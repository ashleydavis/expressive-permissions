import { CapturingAuditLogger, ICommandOutcome } from "../audit-log";
import { commandOutcomesFromAuditEntries } from "../pending-prompt-log";
import { AstNode } from "../ast-nodes/ast-node";
import { BinopAstNode } from "../ast-nodes/binop-ast-node";
import { ForLoopAstNode } from "../ast-nodes/for-loop-ast-node";
import { IAstNode } from "../ast";
import { IContext } from "../context";
import { BashTokenKind } from "../tokenizer";
import { IDecision, IRule, IRuleEvaluation } from "../rules/rule";

const baseContext: IContext = { cwd: "/project", env: {} };

// StubRule returns a fixed decision or abstains.
class StubRule implements IRule {

    // Decision returned when set.
    decision?: IDecision;

    // Optional source location for rule_match coverage.
    sourceLocation?: { file?: string; line?: number };

    constructor(decision?: IDecision) {
        this.decision = decision;
    }

    async evaluate(ast: IAstNode, context: IContext): Promise<IRuleEvaluation> {
        return { decision: this.decision, context };
    }
}

// TypeRule returns a decision only for a matching node type.
class TypeRule implements IRule {

    // Node type this rule applies to.
    type: string;

    // Decision returned when the node type matches.
    decision: IDecision;

    constructor(type: string, decision: IDecision) {
        this.type = type;
        this.decision = decision;
    }

    async evaluate(ast: IAstNode, context: IContext): Promise<IRuleEvaluation> {
        if (ast.type === this.type) {
            return { decision: this.decision, context };
        }
        return { context };
    }
}

// CaptureVarRule records the loop variable value seen on each command outcome.
class CaptureVarRule implements IRule {

    // Environment key to capture.
    variable: string;

    // Values seen for that key, in evaluation order.
    seen: string[];

    constructor(variable: string, seen: string[]) {
        this.variable = variable;
        this.seen = seen;
    }

    async evaluate(ast: IAstNode, context: IContext): Promise<IRuleEvaluation> {
        if (ast.type === "command") {
            this.seen.push(context.env[this.variable]);
            return { decision: { action: "allow", reason: "loop body" }, context };
        }
        return { context };
    }
}

// SourceCmdRule decides based on the command command source string.
class SourceCmdRule implements IRule {

    // Decision action per command source string.
    outcomes: Record<string, IDecision>;

    constructor(outcomes: Record<string, IDecision>) {
        this.outcomes = outcomes;
    }

    async evaluate(ast: IAstNode, context: IContext): Promise<IRuleEvaluation> {
        const decision = this.outcomes[ast.source];
        if (decision) {
            return { decision, context };
        }
        return { context };
    }
}

describe("evaluate audit emission", () => {

    test("logs rule_match for a non-abstaining command rule", async () => {
        const logger = new CapturingAuditLogger();
        const rule = new StubRule({ action: "allow", reason: "ok" });
        rule.sourceLocation = { file: "permissions.yaml", line: 4 };
        await new AstNode("command", "ls").evaluate([rule], baseContext, logger);
        expect(logger.getEntries()).toEqual([
            expect.objectContaining({
                type: "rule_match",
                ruleFile: "permissions.yaml",
                ruleLine: 4,
                decision: "allow",
                reason: "ok",
                cmd: "ls",
            }),
        ]);
    });

    test("logs no_rule_match when every rule abstains on a command node", async () => {
        const logger = new CapturingAuditLogger();
        await new AstNode("command", "pwd").evaluate([new StubRule(undefined)], baseContext, logger);
        expect(logger.getEntries()).toEqual([
            expect.objectContaining({
                type: "no_rule_match",
                nodeType: "command",
                cmd: "pwd",
            }),
        ]);
    });

    test("logs aggregation for an intermediate node", async () => {
        const logger = new CapturingAuditLogger();
        const child = new AstNode("command", "ls");
        const root = new AstNode("bash", "ls", { command: child });
        await root.evaluate([new TypeRule("command", { action: "allow" })], baseContext, logger);
        expect(logger.getEntries()).toContainEqual(expect.objectContaining({
            type: "aggregation",
            decision: "allow",
            cmd: "ls",
        }));
    });

    test("returns NOMATCH command outcome when every rule abstains", async () => {
        const logger = new CapturingAuditLogger();
        await new AstNode("command", "pwd").evaluate([new StubRule(undefined)], baseContext, logger);
        const commandOutcomes = commandOutcomesFromAuditEntries(logger.getEntries());
        expect(commandOutcomes).toEqual([
            {
                cmd: "pwd",
                decision: "NOMATCH",
                source: "no-rule-match",
                cwd: "/project",
                env: {},
            },
        ]);
    });

    test("returns ALLOW matched-rule command outcome", async () => {
        const logger = new CapturingAuditLogger();
        await new AstNode("command", "ls").evaluate([new StubRule({ action: "allow", reason: "safe" })], baseContext, logger);
        const commandOutcomes = commandOutcomesFromAuditEntries(logger.getEntries());
        expect(commandOutcomes).toEqual([
            {
                cmd: "ls",
                decision: "ALLOW",
                reason: "safe",
                source: "matched-rule",
                cwd: "/project",
                env: {},
            },
        ]);
    });

    test("returns matched-rule command outcome with rule location", async () => {
        const logger = new CapturingAuditLogger();
        const rule = new StubRule({ action: "ask", reason: "confirm" });
        rule.sourceLocation = { file: "permissions.yaml", line: 9 };
        await new AstNode("command", "curl https://example.com").evaluate([rule], baseContext, logger);
        const commandOutcomes = commandOutcomesFromAuditEntries(logger.getEntries());
        expect(commandOutcomes).toEqual([
            {
                cmd: "curl https://example.com",
                decision: "ASK",
                ruleFile: "permissions.yaml",
                ruleLine: 9,
                reason: "confirm",
                source: "matched-rule",
                cwd: "/project",
                env: {},
            },
        ]);
    });

    test("returns deny-rule command outcome for a deny", async () => {
        const logger = new CapturingAuditLogger();
        const rule = new StubRule({ action: "deny", reason: "blocked" });
        await new AstNode("command", "rm -rf /").evaluate([rule], baseContext, logger);
        const commandOutcomes = commandOutcomesFromAuditEntries(logger.getEntries());
        expect(commandOutcomes).toEqual([
            {
                cmd: "rm -rf /",
                decision: "DENY",
                reason: "blocked",
                source: "deny-rule",
                cwd: "/project",
                env: {},
            },
        ]);
    });


    test("falls back to action match when pickStrictest joins ask reasons", async () => {
        const logger = new CapturingAuditLogger();
        const first = new StubRule({ action: "ask", reason: "confirm-a" });
        first.sourceLocation = { file: "a.yaml", line: 1 };
        const second = new StubRule({ action: "ask", reason: "confirm-b" });
        second.sourceLocation = { file: "b.yaml", line: 2 };
        await new AstNode("command", "curl https://example.com").evaluate([first, second], baseContext, logger);
        const commandOutcomes = commandOutcomesFromAuditEntries(logger.getEntries());
        expect(commandOutcomes).toEqual([
            {
                cmd: "curl https://example.com",
                decision: "ASK",
                ruleFile: "a.yaml",
                ruleLine: 1,
                reason: "confirm-a; confirm-b",
                source: "matched-rule",
                cwd: "/project",
                env: {},
            },
        ]);
    });

    test("deny short-circuits later rule_match entries", async () => {
        const logger = new CapturingAuditLogger();
        const later = new StubRule({ action: "allow", reason: "later" });
        later.sourceLocation = { file: "later.yaml", line: 2 };
        await new AstNode("command", "rm -rf /").evaluate([new StubRule({ action: "deny", reason: "blocked" }), later], baseContext, logger);
        expect(logger.getEntries()).toEqual([
            expect.objectContaining({
                type: "rule_match",
                decision: "deny",
                reason: "blocked",
            }),
        ]);
    });

    test("returns one command outcome per compound-command child", async () => {
        const logger = new CapturingAuditLogger();
        const left = new AstNode("command", "ls");
        const right = new AstNode("command", "curl https://example.com");
        const binop = new BinopAstNode(
            BashTokenKind.And,
            { left, right },
            "ls && curl https://example.com"
        );
        await binop.evaluate([
                new SourceCmdRule({
                    ls: { action: "allow", reason: "list ok" },
                    "curl https://example.com": { action: "ask", reason: "network" },
                }),
            ], baseContext, logger);
        const commandOutcomes = commandOutcomesFromAuditEntries(logger.getEntries());
        expect(commandOutcomes).toEqual([
            {
                cmd: "ls",
                decision: "ALLOW",
                reason: "list ok",
                source: "matched-rule",
                cwd: "/project",
                env: {},
            },
            {
                cmd: "curl https://example.com",
                decision: "ASK",
                reason: "network",
                source: "matched-rule",
                cwd: "/project",
                env: {},
            },
        ]);
    });

    test("walks positional underscore children", async () => {
        const logger = new CapturingAuditLogger();
        const left = new AstNode("command", "ls");
        const right = new AstNode("command", "pwd");
        const root = new AstNode("group", "ls ; pwd", { _: [left, right] });
        await root.evaluate([new TypeRule("command", { action: "allow", reason: "ok" })], baseContext, logger);
        const commandOutcomes = commandOutcomesFromAuditEntries(logger.getEntries());
        expect(commandOutcomes).toEqual([
            {
                cmd: "ls",
                decision: "ALLOW",
                reason: "ok",
                source: "matched-rule",
                cwd: "/project",
                env: {},
            },
            {
                cmd: "pwd",
                decision: "ALLOW",
                reason: "ok",
                source: "matched-rule",
                cwd: "/project",
                env: {},
            },
        ]);
    });

    test("rejects underscore children that are not an array", async () => {
        const logger = new CapturingAuditLogger();
        const root = new AstNode("group", "bad", { _: "not-an-array" as any });
        await expect(root.evaluate([], baseContext, logger)).rejects.toThrow(
            "AST children `_` must be an array of positional children"
        );
    });

    test("rejects underscore children combined with named children", async () => {
        const logger = new CapturingAuditLogger();
        const command = new AstNode("command", "ls");
        const root = new AstNode("group", "bad", { _: [command], named: command });
        await expect(root.evaluate([], baseContext, logger)).rejects.toThrow(
            "AST children cannot combine `_` positional children with named children"
        );
    });

    test("aggregates a parent deny when a child command denies", async () => {
        const logger = new CapturingAuditLogger();
        const left = new AstNode("command", "ls");
        const right = new AstNode("command", "rm -rf /");
        const binop = new BinopAstNode(BashTokenKind.And, { left, right }, "ls && rm -rf /");
        await binop.evaluate([
                new SourceCmdRule({
                    ls: { action: "allow" },
                    "rm -rf /": { action: "deny", reason: "dangerous" },
                }),
            ], baseContext, logger);
        expect(logger.getEntries()).toContainEqual(expect.objectContaining({
            type: "aggregation",
            decision: "deny",
            reason: "dangerous",
            cmd: "ls && rm -rf /",
        }));
    });

    test("does not emit aggregation for an intermediate node with no child decisions", async () => {
        const logger = new CapturingAuditLogger();
        const root = new AstNode("group", "empty", { _: [] });
        await root.evaluate([], baseContext, logger);
        const commandOutcomes = commandOutcomesFromAuditEntries(logger.getEntries());
        expect(commandOutcomes).toEqual([]);
        expect(logger.getEntries()).toEqual([]);
    });

    test("walks for-loop body once per item and records each command outcome", async () => {
        const logger = new CapturingAuditLogger();
        const body = new AstNode("command", "echo $region");
        const forLoop = new ForLoopAstNode(
            "for_loop",
            { body },
            "region",
            ["ap-northwest-1", "na-central-1"],
            "for region in ap-northwest-1 na-central-1; do echo $region; done"
        );
        const seen: string[] = [];
        await forLoop.evaluate([new CaptureVarRule("region", seen)], baseContext, logger);
        const commandOutcomes = commandOutcomesFromAuditEntries(logger.getEntries());
        expect(seen).toEqual(["ap-northwest-1", "na-central-1"]);
        expect(commandOutcomes).toEqual([
            {
                cmd: "echo $region",
                decision: "ALLOW",
                reason: "loop body",
                source: "matched-rule",
                cwd: "/project",
                env: { region: "ap-northwest-1" },
            },
            {
                cmd: "echo $region",
                decision: "ALLOW",
                reason: "loop body",
                source: "matched-rule",
                cwd: "/project",
                env: { region: "na-central-1" },
            },
        ]);
        expect(logger.getEntries()).toContainEqual(expect.objectContaining({
            type: "aggregation",
            decision: "allow",
            cmd: "for region in ap-northwest-1 na-central-1; do echo $region; done",
        }));
    });

    test("for-loop with no items emits no command outcomes and no aggregation", async () => {
        const logger = new CapturingAuditLogger();
        const body = new AstNode("command", "echo $region");
        const forLoop = new ForLoopAstNode(
            "for_loop",
            { body },
            "region",
            [],
            "for region in; do echo $region; done"
        );
        await forLoop.evaluate([new StubRule({ action: "deny" })], baseContext, logger);
        const commandOutcomes = commandOutcomesFromAuditEntries(logger.getEntries());
        expect(commandOutcomes).toEqual([]);
        expect(logger.getEntries()).toEqual([]);
    });

    test("for-loop without a body emits no command outcomes", async () => {
        const logger = new CapturingAuditLogger();
        const forLoop = new ForLoopAstNode(
            "for_loop",
            undefined,
            "region",
            ["ap-northwest-1"],
            "for region in ap-northwest-1; do; done"
        );
        await forLoop.evaluate([], baseContext, logger);
        const commandOutcomes = commandOutcomesFromAuditEntries(logger.getEntries());
        expect(commandOutcomes).toEqual([]);
        expect(logger.getEntries()).toEqual([]);
    });

    test("prefers an intermediate own decision over a non-deny child decision", async () => {
        const logger = new CapturingAuditLogger();
        const child = new AstNode("command", "ls");
        const root = new AstNode("bash", "ls", { command: child });
        await root.evaluate([
                new TypeRule("command", { action: "allow", reason: "child" }),
                new TypeRule("bash", { action: "ask", reason: "parent" }),
            ], baseContext, logger);
        expect(logger.getEntries()).toContainEqual(expect.objectContaining({
            type: "aggregation",
            decision: "ask",
            reason: "parent",
            cmd: "ls",
        }));
    });
});
