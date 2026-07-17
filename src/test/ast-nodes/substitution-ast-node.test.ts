import { SubstitutionAstNode } from "../../ast-nodes/substitution-ast-node";
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

describe("SubstitutionAstNode", () => {

    test("stores type and children", () => {
        const command = new AstNode("command", "rm -rf /tmp/data");
        const node = new SubstitutionAstNode({ command }, "$(rm -rf /tmp/data)");
        expect(node.type).toBe("substitution");
        expect(node.source).toBe("$(rm -rf /tmp/data)");
        expect(node.children).toEqual({ command });
    });

    test("evaluates its inner command before itself", async () => {
        const command = new AstNode("command", "rm -rf /tmp/data");
        const node = new SubstitutionAstNode({ command }, "$(rm -rf /tmp/data)");
        const seen: string[] = [];
        await node.evaluate([new RecordRule(seen)], baseContext, new NullAuditLogger());
        expect(seen).toEqual(["command", "substitution"]);
    });
});
