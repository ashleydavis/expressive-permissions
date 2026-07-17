import { AstNode, pickStrictest } from "../../ast-nodes/ast-node";
import { NullAuditLogger } from "../../audit-log";
import { IAstNode } from "../../ast";
import { IContext } from "../../context";
import { IDecision, IRule, IRuleEvaluation } from "../../rules/rule";

const baseContext: IContext = { cwd: "/project", env: {} };

// Test rule that returns a fixed decision (or abstains) and passes context through unchanged.
class StubRule implements IRule {

    // Decision this rule returns, or undefined to abstain.
    decision?: IDecision;

    constructor(decision?: IDecision) {
        this.decision = decision;
    }

    async evaluate(ast: IAstNode, context: IContext): Promise<IRuleEvaluation> {
        return { decision: this.decision, context };
    }
}

// Test rule that records the node types it sees, in evaluation order.
class RecordRule implements IRule {

    // Node types seen, appended on each evaluation.
    seen: string[];

    constructor(seen: string[]) {
        this.seen = seen;
    }

    async evaluate(ast: IAstNode, context: IContext): Promise<IRuleEvaluation> {
        this.seen.push(ast.type);
        return { context };
    }
}

// Test rule that returns a decision only when the node type matches.
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

// Test rule that writes a marker into the environment so context threading is observable.
class MarkerRule implements IRule {

    // Environment key this rule sets to "1".
    key: string;

    constructor(key: string) {
        this.key = key;
    }

    async evaluate(ast: IAstNode, context: IContext): Promise<IRuleEvaluation> {
        return { context: { ...context, env: { ...context.env, [this.key]: "1" } } };
    }
}

describe("AstNode constructor", () => {

    test("stores type and children", () => {
        const child = new AstNode("command", "command");
        const node = new AstNode("bash", "bash", { command: child });
        expect(node.type).toBe("bash");
        expect(node.children).toEqual({ command: child });
    });

    test("a node without children has no children property", () => {
        const node = new AstNode("command", "command");
        expect(node.children).toBeUndefined();
    });

    test("stores the source text passed to the constructor", () => {
        const node = new AstNode("command", "ls -l");
        expect(node.source).toBe("ls -l");
    });
});

describe("AstNode.evaluate", () => {

    test("returns the decision from a matching rule", async () => {
        const node = new AstNode("command", "command");
        const result = await node.evaluate([new StubRule({ action: "allow" })], baseContext, new NullAuditLogger());
        expect(result.decision).toEqual({ action: "allow" });
    });

    test("defaults an undecided node with no children to ask", async () => {
        const node = new AstNode("command", "command");
        const result = await node.evaluate([new StubRule(undefined)], baseContext, new NullAuditLogger());
        expect(result.decision).toEqual({ action: "ask" });
    });

    test("a node's own rule overrides its children", async () => {
        const child = new AstNode("command", "child");
        const node = new AstNode("redirect", "redirect", { command: child });
        const result = await node.evaluate([new TypeRule("redirect", { action: "allow" })], baseContext, new NullAuditLogger());
        expect(result.decision).toEqual({ action: "allow" });
    });

    test("a child deny cannot be overridden by the node's own rule", async () => {
        const child = new AstNode("command", "child");
        const node = new AstNode("redirect", "redirect", { command: child });
        const result = await node.evaluate([
            new TypeRule("command", { action: "deny" }),
            new TypeRule("redirect", { action: "allow" }),
        ], baseContext, new NullAuditLogger());
        expect(result.decision).toEqual({ action: "deny" });
    });

    test("returns the strictest decision across rules", async () => {
        const node = new AstNode("command", "command");
        const result = await node.evaluate([new StubRule({ action: "allow" }), new StubRule({ action: "deny" })], baseContext, new NullAuditLogger());
        expect(result.decision).toEqual({ action: "deny" });
    });

    test("deny short-circuits remaining rules at the same node", async () => {
        let laterRuleCalled = false;
        const laterRule: IRule = {
            async evaluate(ast: IAstNode, context: IContext): Promise<IRuleEvaluation> {
                laterRuleCalled = true;
                return { decision: { action: "allow" }, context };
            },
        };
        const node = new AstNode("command", "command");
        const result = await node.evaluate(
            [new StubRule({ action: "deny", reason: "blocked" }), laterRule], baseContext, new NullAuditLogger());
        expect(result.decision).toEqual({ action: "deny", reason: "blocked" });
        expect(laterRuleCalled).toBe(false);
    });

    test("deny short-circuits later-layer env updates", async () => {
        const laterLayer: IRule = {
            async evaluate(ast: IAstNode, context: IContext): Promise<IRuleEvaluation> {
                return {
                    decision: { action: "allow" },
                    context: {
                        ...context,
                        env: {
                            ...context.env,
                            LATER: "applied",
                        },
                    },
                };
            },
        };
        const node = new AstNode("command", "command");
        const result = await node.evaluate([new StubRule({ action: "deny", reason: "blocked" }), laterLayer], baseContext, new NullAuditLogger());
        expect(result.decision).toEqual({ action: "deny", reason: "blocked" });
        expect(result.context.env["LATER"]).toBeUndefined();
    });

    test("allow then ask still evaluates both rules", async () => {
        let laterRuleCalled = false;
        const laterRule: IRule = {
            async evaluate(ast: IAstNode, context: IContext): Promise<IRuleEvaluation> {
                laterRuleCalled = true;
                return { decision: { action: "ask", reason: "confirm" }, context };
            },
        };
        const node = new AstNode("command", "command");
        const result = await node.evaluate([new StubRule({ action: "allow" }), laterRule], baseContext, new NullAuditLogger());
        expect(result.decision).toEqual({ action: "ask", reason: "confirm" });
        expect(laterRuleCalled).toBe(true);
    });

    test("includes a child's decision in the aggregate", async () => {
        const child = new AstNode("command", "command");
        const node = new AstNode("bash", "bash", { command: child });
        const result = await node.evaluate([new TypeRule("command", { action: "deny" })], baseContext, new NullAuditLogger());
        expect(result.decision).toEqual({ action: "deny" });
    });

    test("falls back to a child's non-deny decision when the node has no own rule", async () => {
        const child = new AstNode("command", "command");
        const node = new AstNode("bash", "bash", { command: child });
        const result = await node.evaluate([new TypeRule("command", { action: "allow" })], baseContext, new NullAuditLogger());
        expect(result.decision).toEqual({ action: "allow" });
    });

    test("returns no decision when an intermediate node has no children and no own decision", async () => {
        const node = new AstNode("bash", "bash", {});
        const result = await node.evaluate([new StubRule(undefined)], baseContext, new NullAuditLogger());
        expect(result.decision).toBeUndefined();
    });

    test("evaluates children before this node's rules", async () => {
        const seen: string[] = [];
        const child = new AstNode("command", "command");
        const node = new AstNode("bash", "bash", { command: child });
        await node.evaluate([new RecordRule(seen)], baseContext, new NullAuditLogger());
        expect(seen).toEqual(["command", "bash"]);
    });

    test("threads context changes from a rule into the returned context", async () => {
        const node = new AstNode("command", "command");
        const result = await node.evaluate([new MarkerRule("touched")], baseContext, new NullAuditLogger());
        expect(result.context.env["touched"]).toBe("1");
    });

    test("walks every positional child in the `_` array in order", async () => {
        const seen: string[] = [];
        const node = new AstNode("case_statement", "case", { _: [new AstNode("a", "a"), new AstNode("b", "b")] });
        await node.evaluate([new RecordRule(seen)], baseContext, new NullAuditLogger());
        expect(seen).toEqual(["a", "b", "case_statement"]);
    });

    test("a deny in any positional child cannot be overridden by the node's own rule", async () => {
        const node = new AstNode("case_statement", "case", { _: [new AstNode("command", "rm"), new AstNode("command", "echo")] });
        const result = await node.evaluate([
            new TypeRule("command", { action: "deny" }),
            new TypeRule("case_statement", { action: "allow" }),
        ], baseContext, new NullAuditLogger());
        expect(result.decision).toEqual({ action: "deny" });
    });

    test("throws when `_` is present but not an array", async () => {
        const node = new AstNode("case_statement", "case", { _: new AstNode("command", "rm") as any });
        await expect(node.evaluate([], baseContext, new NullAuditLogger())).rejects.toThrow("`_` must be an array");
    });

    test("throws when `_` is combined with named children", async () => {
        const node = new AstNode("case_statement", "case", { _: [new AstNode("command", "rm")], extra: new AstNode("command", "echo") });
        await expect(node.evaluate([], baseContext, new NullAuditLogger())).rejects.toThrow("cannot combine `_` positional children with named children");
    });
});

describe("pickStrictest", () => {

    test("returns undefined for no decisions", () => {
        expect(pickStrictest([])).toBeUndefined();
    });

    test("joins the reasons of every decision sharing the strictest action", () => {
        const result = pickStrictest([
            { action: "allow", reason: "set environment variable" },
            { action: "allow", reason: "sed within /tmp" },
        ]);
        expect(result).toEqual({ action: "allow", reason: "set environment variable; sed within /tmp" });
    });

    test("ignores reasons from actions weaker than the strictest", () => {
        const result = pickStrictest([
            { action: "allow", reason: "allowed here" },
            { action: "deny", reason: "blocked" },
        ]);
        expect(result).toEqual({ action: "deny", reason: "blocked" });
    });

    test("deduplicates identical reasons", () => {
        const result = pickStrictest([
            { action: "deny", reason: "blocked" },
            { action: "deny", reason: "blocked" },
        ]);
        expect(result).toEqual({ action: "deny", reason: "blocked" });
    });

    test("returns deny over allow", () => {
        expect(pickStrictest([{ action: "allow" }, { action: "deny" }])).toEqual({ action: "deny" });
    });

    test("treats unknown actions as weaker than allow", () => {
        expect(pickStrictest([{ action: "other" }, { action: "allow" }])).toEqual({ action: "allow" });
    });

    test("returns ask over allow", () => {
        expect(pickStrictest([{ action: "allow" }, { action: "ask" }])).toEqual({ action: "ask" });
    });

    test("returns the only decision when there is one", () => {
        expect(pickStrictest([{ action: "allow" }])).toEqual({ action: "allow" });
    });
});
