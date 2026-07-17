import picomatch from "picomatch";
import { IAstNode } from "../ast";
import { IToolNode } from "../ast-nodes/tool-ast-node";
import { IContext } from "../context";
import { IDecision, IRule, IRuleEvaluation, ISourceLocation } from "./rule";

// GenericToolRule matches tool calls by Claude Code tool_name glob.
export class GenericToolRule implements IRule {

    // Glob pattern matched against tool_name.
    pattern?: string;

    // OR list of glob patterns matched against tool_name.
    toolIn?: string[];

    // Permission decision when the rule matches.
    decision: string;

    // Human-readable reason forwarded when the rule matches.
    reason?: string;

    // File and line this rule was loaded from, when known.
    sourceLocation?: ISourceLocation;

    constructor(
        pattern: string | undefined,
        decision: string,
        reason: string | undefined,
        toolIn: string[] | undefined,
        sourceLocation: ISourceLocation | undefined
    ) {
        if (pattern === undefined && toolIn === undefined) {
            throw new Error("GenericToolRule must have either pattern or toolIn");
        }

        this.decision = decision;
        this.pattern = pattern;
        this.reason = reason;
        this.toolIn = toolIn;
        this.sourceLocation = sourceLocation;
    }

    // Match a tool-call node whose Claude tool name matches the configured glob pattern.
    async evaluate(ast: IAstNode, context: IContext): Promise<IRuleEvaluation> {

        let matched = false;

        if (ast.type === "tool") {
            const toolNode = ast as IToolNode;

            if (this.toolIn !== undefined) {
                for (const entry of this.toolIn) {
                    if (picomatch(entry)(toolNode.tool_name)) {
                        matched = true;
                        break;
                    }
                }
            }
            else if (this.pattern !== undefined) {
                matched = picomatch(this.pattern)(toolNode.tool_name);
            }
        }
        else if (this.toolIn !== undefined) {

            // Modeled tool types are the Claude tool name lowercased (WebFetch → webfetch).
            for (const entry of this.toolIn) {
                if (entry.toLowerCase() === ast.type) {
                    matched = true;
                    break;
                }
            }
        }
        else if (this.pattern !== undefined) {
            matched = this.pattern.toLowerCase() === ast.type;
        }

        if (!matched) {
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
