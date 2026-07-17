import { RedirectAstNode } from "../../ast-nodes/redirect-ast-node";
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

describe("RedirectAstNode", () => {

    test("stores type, operator, target, and children", () => {
        const command = new AstNode("command", "command");
        const node = new RedirectAstNode(">", "out.txt", { command }, "command > out.txt");
        expect(node.type).toBe("redirect");
        expect(node.op).toBe(">");
        expect(node.target).toBe("out.txt");
        expect(node.children).toEqual({ command });
    });

    test("evaluates its wrapped command before itself", async () => {
        const command = new AstNode("command", "command");
        const node = new RedirectAstNode(">", "out.txt", { command }, "command > out.txt");
        const seen: string[] = [];
        await node.evaluate([new RecordRule(seen)], baseContext, new NullAuditLogger());
        expect(seen).toEqual(["command", "redirect"]);
    });
});
