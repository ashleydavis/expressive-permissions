import { IfStatementAstNode } from "../../ast-nodes/if-statement-ast-node";
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

describe("IfStatementAstNode", () => {

    test("stores type and children", () => {
        const condition = new AstNode("command", "command");
        const thenBranch = new AstNode("command", "command");
        const node = new IfStatementAstNode({ condition, thenBranch }, "if command; then command; fi");
        expect(node.type).toBe("if_statement");
        expect(node.children).toEqual({ condition, thenBranch });
    });

    test("evaluates condition and branches before itself", async () => {
        const condition = new AstNode("condition", "condition");
        const thenBranch = new AstNode("then", "then");
        const elseBranch = new AstNode("else", "else");
        const node = new IfStatementAstNode({ condition, thenBranch, elseBranch }, "if condition; then then; else else; fi");
        const seen: string[] = [];
        await node.evaluate([new RecordRule(seen)], baseContext, new NullAuditLogger());
        expect(seen).toEqual(["condition", "then", "else", "if_statement"]);
    });
});
