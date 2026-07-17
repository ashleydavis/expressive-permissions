import { GrepAstNode } from "../../ast-nodes/grep-ast-node";
import { NullAuditLogger } from "../../audit-log";
import { AstNode } from "../../ast-nodes/ast-node";
import { IAstNode } from "../../ast";
import { IContext } from "../../context";
import { IRule, IRuleEvaluation } from "../../rules/rule";

const baseContext: IContext = { cwd: "/project", env: {} };

// Test rule that allows any node it sees.
class AllowRule implements IRule {

    async evaluate(ast: IAstNode, context: IContext): Promise<IRuleEvaluation> {
        return { decision: { action: "allow" }, context };
    }
}

describe("GrepAstNode", () => {

    test("stores type, pattern, and path", () => {
        const node = new GrepAstNode("TODO", "src", "Grep TODO src");
        expect(node.type).toBe("grep");
        expect(node.pattern).toBe("TODO");
        expect(node.path).toBe("src");
    });

    test("is an AstNode and inherits evaluate", async () => {
        const node = new GrepAstNode("TODO", "src", "Grep TODO src");
        expect(node).toBeInstanceOf(AstNode);
        const result = await node.evaluate([new AllowRule()], baseContext, new NullAuditLogger());
        expect(result.decision).toEqual({ action: "allow" });
    });
});
