import { XargsAstNode } from "../../ast-nodes/xargs-ast-node";
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

describe("XargsAstNode", () => {

    test("stores type, options, and children", () => {
        const child = new AstNode("command", "command");
        const node = new XargsAstNode({ n: "1" }, { child }, "xargs -n 1 command");
        expect(node.type).toBe("xargs");
        expect(node.options).toEqual({ n: "1" });
        expect(node.children).toEqual({ child });
    });

    test("evaluates its subcommand before itself", async () => {
        const child = new AstNode("command", "command");
        const node = new XargsAstNode({}, { child }, "xargs command");
        const seen: string[] = [];
        await node.evaluate([new RecordRule(seen)], baseContext, new NullAuditLogger());
        expect(seen).toEqual(["command", "xargs"]);
    });
});
