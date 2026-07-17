import { WhileLoopAstNode } from "../../ast-nodes/while-loop-ast-node";
import { NullAuditLogger } from "../../audit-log";
import { AstNode } from "../../ast-nodes/ast-node";
import { IAstNode } from "../../ast";
import { IContext } from "../../context";
import { IRule, IRuleEvaluation } from "../../rules/rule";

const baseContext: IContext = { cwd: "/project", env: {} };

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

describe("WhileLoopAstNode", () => {

    test("stores type, until flag, and children", () => {
        const condition = new AstNode("command", "command");
        const body = new AstNode("command", "command");
        const node = new WhileLoopAstNode(false, { condition, body }, "while command; do command; done");
        expect(node.type).toBe("while_loop");
        expect(node.until).toBe(false);
        expect(node.children).toEqual({ condition, body });
    });

    test("evaluates condition and body before itself", async () => {
        const condition = new AstNode("condition", "condition");
        const body = new AstNode("body", "body");
        const node = new WhileLoopAstNode(false, { condition, body }, "while condition; do body; done");
        const seen: string[] = [];
        await node.evaluate([new RecordRule(seen)], baseContext, new NullAuditLogger());
        expect(seen).toEqual(["condition", "body", "while_loop"]);
    });
});
