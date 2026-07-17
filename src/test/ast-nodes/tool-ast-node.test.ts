import { ToolAstNode } from "../../ast-nodes/tool-ast-node";
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

describe("ToolAstNode", () => {

    test("stores type, tool name, and input", () => {
        const node = new ToolAstNode("mcp__server__search", { query: "hello" }, "mcp__server__search");
        expect(node.type).toBe("tool");
        expect(node.tool_name).toBe("mcp__server__search");
        expect(node.tool_input).toEqual({ query: "hello" });
    });

    test("is an AstNode and inherits evaluate", async () => {
        const node = new ToolAstNode("mcp__server__search", {}, "mcp__server__search");
        expect(node).toBeInstanceOf(AstNode);
        const result = await node.evaluate([new AllowRule()], baseContext, new NullAuditLogger());
        expect(result.decision).toEqual({ action: "allow" });
    });
});
