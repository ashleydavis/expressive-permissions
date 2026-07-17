import { CaseStatementAstNode } from "../../ast-nodes/case-statement-ast-node";
import { NullAuditLogger } from "../../audit-log";
import { AstNode } from "../../ast-nodes/ast-node";
import { ICaseClause } from "../../ast-nodes/case-statement-ast-node";
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

// Test rule that denies a command node whose source text is exactly "rm".
class DenyRmRule implements IRule {

    async evaluate(ast: IAstNode, context: IContext): Promise<IRuleEvaluation> {
        if (ast.source === "rm") {
            return { decision: { action: "deny", reason: "rm is not allowed" }, context };
        }
        return { decision: undefined, context };
    }
}

describe("CaseStatementAstNode", () => {

    test("stores type, word, clauses, and clause bodies as positional children", () => {
        const clause: ICaseClause = { patterns: ["stop", "halt"] };
        const body = new AstNode("command", "command");
        const node = new CaseStatementAstNode("$action", [clause], { _: [body] }, "case $action in stop|halt) command;; esac");
        expect(node.type).toBe("case_statement");
        expect(node.word).toBe("$action");
        expect(node.clauses).toEqual([clause]);
        expect(node.children).toEqual({ _: [body] });
    });

    test("is an AstNode and inherits evaluate", async () => {
        const node = new CaseStatementAstNode("$action", [], { _: [] }, "case $action in esac");
        expect(node).toBeInstanceOf(AstNode);
        const result = await node.evaluate([new AllowRule()], baseContext, new NullAuditLogger());
        expect(result.decision).toEqual({ action: "allow" });
    });

    test("a deny in any clause body denies the statement (bash-case-body-inner-deny)", async () => {
        const node = new CaseStatementAstNode(
            "$1",
            [{ patterns: ["start"] }, { patterns: ["*"] }],
            { _: [new AstNode("command", "rm"), new AstNode("command", "echo")] },
            "case $1 in start) rm;; *) echo ok;; esac",
        );
        const result = await node.evaluate([new DenyRmRule()], baseContext, new NullAuditLogger());
        expect(result.decision).toEqual({ action: "deny", reason: "rm is not allowed" });
    });
});
