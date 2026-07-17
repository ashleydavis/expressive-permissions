import { BashAstNode } from "../../ast-nodes/bash-ast-node";
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

describe("BashAstNode", () => {

    test("stores type and children", () => {
        const command = new AstNode("command", "command");
        const node = new BashAstNode({ command }, "command");
        expect(node.type).toBe("bash");
        expect(node.children).toEqual({ command });
    });

    test("evaluates its command child before itself", async () => {
        const command = new AstNode("command", "command");
        const node = new BashAstNode({ command }, "command");
        const seen: string[] = [];
        await node.evaluate([new RecordRule(seen)], baseContext, new NullAuditLogger());
        expect(seen).toEqual(["command", "bash"]);
    });
});
