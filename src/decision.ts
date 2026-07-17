import { IAuditLogger } from "./audit-log";
import { IAstNode } from "./ast";
import { IContext } from "./context";
import { IRules } from "./load";
import { IDecision } from "./rules/rule";

// Decide whether a tool call is allowed by evaluating its AST from the leaves up.
export async function decideNode(ast: IAstNode, rules: IRules, context: IContext, logger: IAuditLogger): Promise<IDecision | undefined> {
    const evaluation = await ast.evaluate(rules.rules, context, logger);
    return evaluation.decision;
}

// Evaluate a tool call against rules and return the strictest decision.
export async function decide(ast: IAstNode, rules: IRules, context: IContext, logger: IAuditLogger): Promise<IDecision | undefined> {
    return decideNode(ast, rules, context, logger);
}
