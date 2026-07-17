import { IAstNode } from "../ast";
import { IWebFetchNode } from "../ast-nodes/webfetch-ast-node";
import { IContext } from "../context";
import { IDecision, IRule, IRuleEvaluation, ISourceLocation } from "./rule";

// WebFetchRule matches a WebFetch tool call by URL hostname.
export class WebFetchRule implements IRule {

    // Hostnames matched when any entry matches the URL hostname (OR). Empty means any host.
    hostIn: string[];

    // Permission decision when the rule matches.
    decision: string;

    // Human-readable reason forwarded when the rule matches.
    reason?: string;

    // File and line this rule was loaded from, when known.
    sourceLocation?: ISourceLocation;

    constructor(
        hostIn: string[],
        decision: string,
        reason: string | undefined,
        sourceLocation: ISourceLocation | undefined
    ) {
        this.hostIn = hostIn;
        this.decision = decision;
        this.reason = reason;
        this.sourceLocation = sourceLocation;
    }

    // Match a webfetch node by URL hostname. An empty host list matches any host.
    async evaluate(ast: IAstNode, context: IContext): Promise<IRuleEvaluation> {

        if (ast.type !== "webfetch") {
            return { context };
        }

        if (this.hostIn.length > 0) {
            const webfetchNode = ast as IWebFetchNode;
            let hostname = "";

            try {
                hostname = new URL(webfetchNode.url).hostname;
            }
            catch {
                hostname = "";
            }

            let matched = false;

            for (const hostEntry of this.hostIn) {
                if (hostname === hostEntry) {
                    matched = true;
                    break;
                }
            }

            if (!matched) {
                return { context };
            }
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
