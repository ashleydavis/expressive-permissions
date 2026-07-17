import { SubshellAstNode } from "../../ast-nodes/subshell-ast-node";
import { NullAuditLogger } from "../../audit-log";
import { AstNode } from "../../ast-nodes/ast-node";
import { CommandAstNode } from "../../ast-nodes/command-ast-node";
import { IAstNode } from "../../ast";
import { IContext } from "../../context";
import { EmptyCommandRule } from "../../rules/builtin/empty-command-rule";
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

describe("SubshellAstNode", () => {

    test("stores type and children", () => {
        const body = new AstNode("command", "command");
        const node = new SubshellAstNode({ body }, "( command )");
        expect(node.type).toBe("subshell");
        expect(node.children).toEqual({ body });
    });

    test("evaluates its body before itself", async () => {
        const body = new AstNode("body", "body");
        const node = new SubshellAstNode({ body }, "( body )");
        const seen: string[] = [];
        await node.evaluate([new RecordRule(seen)], baseContext, new NullAuditLogger());
        expect(seen).toEqual(["body", "subshell"]);
    });

    test("does not leak body env updates to the outer context", async () => {
        const body = new CommandAstNode("", {}, [], { FOO: "bar" }, "FOO=bar");
        const subshell = new SubshellAstNode({ body }, "(FOO=bar)");
        const result = await subshell.evaluate([new EmptyCommandRule()], baseContext, new NullAuditLogger());
        expect(result.context.env["FOO"]).toBeUndefined();
    });
});
