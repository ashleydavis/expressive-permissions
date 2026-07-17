import { WebFetchAstNode } from "../../ast-nodes/webfetch-ast-node";
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

describe("WebFetchAstNode", () => {

    test("stores type and url", () => {
        const node = new WebFetchAstNode("https://api.example.com/data", "WebFetch https://api.example.com/data");
        expect(node.type).toBe("webfetch");
        expect(node.url).toBe("https://api.example.com/data");
    });

    test("is an AstNode and inherits evaluate", async () => {
        const node = new WebFetchAstNode("https://api.example.com/data", "WebFetch https://api.example.com/data");
        expect(node).toBeInstanceOf(AstNode);
        const result = await node.evaluate([new AllowRule()], baseContext, new NullAuditLogger());
        expect(result.decision).toEqual({ action: "allow" });
    });
});
