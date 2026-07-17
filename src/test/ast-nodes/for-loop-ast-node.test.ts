import { ForLoopAstNode } from "../../ast-nodes/for-loop-ast-node";
import { NullAuditLogger } from "../../audit-log";
import { AstNode } from "../../ast-nodes/ast-node";
import { IAstNode } from "../../ast";
import { IContext } from "../../context";
import { IDecision, IRule, IRuleEvaluation } from "../../rules/rule";

const baseContext: IContext = { cwd: "/project", env: {} };

// Test rule that records the loop variable's value on each evaluation.
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
        this.seen.push(context.env[this.variable]);
        return { context };
    }
}

// Test rule that returns a decision keyed by the current loop variable's value.
class RegionRule implements IRule {

    // Decision action per region value.
    outcomes: Record<string, string>;

    constructor(outcomes: Record<string, string>) {
        this.outcomes = outcomes;
    }

    async evaluate(ast: IAstNode, context: IContext): Promise<IRuleEvaluation> {
        const action = this.outcomes[context.env["region"]];
        if (action) {
            return { decision: { action }, context };
        }
        return { context };
    }
}

describe("ForLoopAstNode constructor", () => {

    test("stores type, children, variable, and items", () => {
        const body = new AstNode("command", "command");
        const forLoop = new ForLoopAstNode("for_loop", { body }, "region", ["a", "b"], "for region in a b; do command; done");
        expect(forLoop.type).toBe("for_loop");
        expect(forLoop.children).toEqual({ body });
        expect(forLoop.variable).toBe("region");
        expect(forLoop.items).toEqual(["a", "b"]);
    });
});

describe("ForLoopAstNode.evaluate", () => {

    test("binds the loop variable to each item when walking the body", async () => {
        const body = new AstNode("command", "command");
        const forLoop = new ForLoopAstNode("for_loop", { body }, "region", ["ap-northwest-1", "na-central-1"], "for region in ap-northwest-1 na-central-1; do command; done");
        const seen: string[] = [];
        await forLoop.evaluate([new CaptureVarRule("region", seen)], baseContext, new NullAuditLogger());
        expect(seen).toEqual(["ap-northwest-1", "na-central-1"]);
    });

    test("returns the strictest decision across iterations", async () => {
        const body = new AstNode("command", "command");
        const forLoop = new ForLoopAstNode("for_loop", { body }, "region", ["ap-northwest-1", "na-central-1"], "for region in ap-northwest-1 na-central-1; do command; done");
        const rule = new RegionRule({ "ap-northwest-1": "allow", "na-central-1": "deny" });
        const result = await forLoop.evaluate([rule], baseContext, new NullAuditLogger());
        expect(result.decision).toEqual({ action: "deny" });
    });

    test("returns no decision when there are no items", async () => {
        const body = new AstNode("command", "command");
        const forLoop = new ForLoopAstNode("for_loop", { body }, "region", [], "for region in; do command; done");
        const result = await forLoop.evaluate([new RegionRule({ "ap-northwest-1": "deny" })], baseContext, new NullAuditLogger());
        expect(result.decision).toBeUndefined();
    });

    test("does not leak the loop variable into the returned context", async () => {
        const body = new AstNode("command", "command");
        const forLoop = new ForLoopAstNode("for_loop", { body }, "region", ["ap-northwest-1"], "for region in ap-northwest-1; do command; done");
        const result = await forLoop.evaluate([], baseContext, new NullAuditLogger());
        expect(result.context).toEqual(baseContext);
        expect(result.context.env["region"]).toBeUndefined();
    });
});
