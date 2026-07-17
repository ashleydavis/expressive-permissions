import { IAstNode } from "../ast";
import { IContext } from "../context";
import { IDecision, IRule, IRuleEvaluation, ISourceLocation } from "./rule";

// GrepRule matches a Grep tool call.
export class GrepRule implements IRule {

    // Permission decision when the rule matches.
    decision: string;

    // Human-readable reason forwarded when the rule matches.
    reason?: string;

    // File and line this rule was loaded from, when known.
    sourceLocation?: ISourceLocation;

    constructor(
        decision: string,
        reason: string | undefined,
        sourceLocation: ISourceLocation | undefined
    ) {
        this.decision = decision;
        this.reason = reason;
        this.sourceLocation = sourceLocation;
    }

    // Match a grep AST node.
    async evaluate(ast: IAstNode, context: IContext): Promise<IRuleEvaluation> {

        if (ast.type !== "grep") {
            return { context };
        }

        const decision: IDecision = {
            action: this.decision,
        };

        if (this.reason !== undefined) {
            decision.reason = this.reason;
        }

        return {
            decision,
            context,
        };
    }
}
