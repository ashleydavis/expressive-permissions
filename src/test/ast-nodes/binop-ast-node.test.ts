import { BinopAstNode } from "../../ast-nodes/binop-ast-node";
import { NullAuditLogger } from "../../audit-log";
import { AstNode } from "../../ast-nodes/ast-node";
import { IAstNode } from "../../ast";
import { IContext } from "../../context";
import { IRule, IRuleEvaluation } from "../../rules/rule";
import { BashTokenKind } from "../../tokenizer";

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

describe("BinopAstNode", () => {

    test("stores type, operator, and children", () => {
        const left = new AstNode("command", "left");
        const right = new AstNode("command", "right");
        const node = new BinopAstNode(BashTokenKind.And, { left, right }, "left && right");
        expect(node.type).toBe("binop");
        expect(node.op).toBe("&&");
        expect(node.children).toEqual({ left, right });
    });

    test("evaluates both operands before itself", async () => {
        const left = new AstNode("left", "left");
        const right = new AstNode("right", "right");
        const node = new BinopAstNode(BashTokenKind.And, { left, right }, "left && right");
        const seen: string[] = [];
        await node.evaluate([new RecordRule(seen)], baseContext, new NullAuditLogger());
        expect(seen).toEqual(["left", "right", "binop"]);
    });
});
