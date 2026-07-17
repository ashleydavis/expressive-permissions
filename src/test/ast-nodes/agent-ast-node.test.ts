import { AgentAstNode } from "../../ast-nodes/agent-ast-node";
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

describe("AgentAstNode", () => {

    test("stores type, description, and prompt", () => {
        const node = new AgentAstNode("review code", "Please review this change", "review code");
        expect(node.type).toBe("agent");
        expect(node.description).toBe("review code");
        expect(node.prompt).toBe("Please review this change");
    });

    test("is an AstNode and inherits evaluate", async () => {
        const node = new AgentAstNode("review code", "Please review this change", "review code");
        expect(node).toBeInstanceOf(AstNode);
        const result = await node.evaluate([new AllowRule()], baseContext, new NullAuditLogger());
        expect(result.decision).toEqual({ action: "allow" });
    });
});
