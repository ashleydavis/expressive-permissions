import { CommandAstNode } from "../../ast-nodes/command-ast-node";
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

describe("CommandAstNode", () => {

    test("stores type, command name, options, positionals, and env prefix", () => {
        const node = new CommandAstNode("ls", { l: true }, ["src"], { FOO: "bar" }, "FOO=bar ls -l src");
        expect(node.type).toBe("command");
        expect(node.commandName).toBe("ls");
        expect(node.options).toEqual({ l: true });
        expect(node.positionals).toEqual(["src"]);
        expect(node.envPrefix).toEqual({ FOO: "bar" });
    });

    test("is an AstNode and inherits evaluate", async () => {
        const node = new CommandAstNode("ls", {}, [], {}, "ls");
        expect(node).toBeInstanceOf(AstNode);
        const result = await node.evaluate([new AllowRule()], baseContext, new NullAuditLogger());
        expect(result.decision).toEqual({ action: "allow" });
    });
});
