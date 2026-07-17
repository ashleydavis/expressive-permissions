import { FilePathToolAstNode } from "../../ast-nodes/file-path-tool-ast-node";
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

describe("FilePathToolAstNode", () => {

    test("stores the given type and file path", () => {
        const node = new FilePathToolAstNode("write", "/project/src/index.ts", "write /project/src/index.ts");
        expect(node.type).toBe("write");
        expect(node.file_path).toBe("/project/src/index.ts");
    });

    test("is an AstNode and inherits evaluate", async () => {
        const node = new FilePathToolAstNode("read", "/project/src/index.ts", "read /project/src/index.ts");
        expect(node).toBeInstanceOf(AstNode);
        const result = await node.evaluate([new AllowRule()], baseContext, new NullAuditLogger());
        expect(result.decision).toEqual({ action: "allow" });
    });
});
