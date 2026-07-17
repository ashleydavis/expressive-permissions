import { IAuditLogger, toLocalISOString } from "../audit-log";
import { IAstChildren, IAstNode } from "../ast";
import { IContext } from "../context";
import { IDecision, IRule, IRuleEvaluation } from "../rules/rule";
import { AstNode, pickStrictest } from "./ast-node";

// Children of a for-loop node.
export interface IForLoopChildren extends IAstChildren {

    // Loop body executed once per item.
    body: IAstNode;
}

// A for-loop node: binds a variable to each item and evaluates the body per iteration.
export class ForLoopAstNode extends AstNode {

    // Child node holding the single loop body.
    children?: IForLoopChildren;

    // Name of the loop variable bound on each iteration.
    variable: string;

    // Literal values the loop iterates over.
    items: string[];

    constructor(type: string, children: IForLoopChildren | undefined, variable: string, items: string[], source: string) {
        super(type, source);
        this.children = children;
        this.variable = variable;
        this.items = items;
    }

    // Bind the loop variable to each item's value in turn and walk the body once per iteration.
    async evaluate(rules: IRule[], context: IContext, logger: IAuditLogger): Promise<IRuleEvaluation> {

        const decisions: IDecision[] = [];
        const body = this.children?.body;

        if (body) {
            for (const item of this.items) {
                const iterationContext: IContext = {
                    ...context,
                    env: {
                        ...context.env,
                        [this.variable]: item
                    },
                };

                const iterationResult = await body.evaluate(rules, iterationContext, logger);
                if (iterationResult.decision) {
                    decisions.push(iterationResult.decision);
                }
            }
        }

        const combinedDecision = pickStrictest(decisions);
        if (combinedDecision) {
            logger.log({
                type: "aggregation",
                timestamp: toLocalISOString(new Date()),
                cmd: this.source,
                decision: combinedDecision.action,
                reason: combinedDecision.reason,
            });
        }

        return {
            decision: combinedDecision,
            context,
        };
    }
}
