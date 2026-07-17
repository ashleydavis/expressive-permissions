import { IAuditLogger } from "../audit-log";
import { IAstChildren, IAstNode } from "../ast";
import { IContext } from "../context";
import { IRule, IRuleEvaluation } from "../rules/rule";
import { AstNode } from "./ast-node";

// Children of a subshell wrapping a statement list in `( ... )`.
export interface ISubshellChildren extends IAstChildren {

    // Inner statement list for the subshell body.
    body: IAstNode;
}

// AST node for a subshell `( ... )`.
export class SubshellAstNode extends AstNode {

    // Named child node for the inner statement list.
    children: ISubshellChildren;

    constructor(children: ISubshellChildren, source: string) {
        super("subshell", source);
        this.children = children;
    }

    // Walk the body with its own env so assignments do not leak out of the subshell.
    async evaluate(rules: IRule[], context: IContext, logger: IAuditLogger): Promise<IRuleEvaluation> {

        const result = await super.evaluate(rules, {
            ...context,
            env: { ...context.env },
        }, logger);

        return {
            decision: result.decision,
            context,
        };
    }
}
