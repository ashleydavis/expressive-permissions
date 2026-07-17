import picomatch from "picomatch";
import { IAstNode } from "../ast";
import { IFilePathToolNode } from "../ast-nodes/file-path-tool-ast-node";
import { pickStrictest } from "../ast-nodes/ast-node";
import { IContext } from "../context";
import { IDecision, IRule, IRuleEvaluation, ISourceLocation } from "./rule";

// FileToolRule matches a file tool call by path glob.
export class FileToolRule implements IRule {

    // File tool category for this rule (read, write, edit, or multiedit).
    toolType: string;

    // Path glob patterns matched against file_path (OR semantics); empty matches any path.
    pathIn: string[];

    // Permission decision when the rule matches.
    decision: string;

    // Human-readable reason forwarded when the rule matches.
    reason?: string;

    // Working directory that must match before the rule fires.
    requiredCwd?: string;

    // Child rules evaluated only once this rule's own conditions match; their strictest decision becomes this rule's decision.
    children?: FileToolRule[];

    // Decide-only fallback used when no child produces a decision.
    catchAll?: FileToolRule;

    // File and line this rule was loaded from, when known.
    sourceLocation?: ISourceLocation;

    constructor(
        toolType: string,
        pathIn: string[],
        decision: string,
        reason: string | undefined,
        sourceLocation: ISourceLocation | undefined
    ) {
        this.toolType = toolType;
        this.pathIn = pathIn;
        this.decision = decision;
        this.reason = reason;
        this.sourceLocation = sourceLocation;
    }

    // Return true when the working directory matches this rule's cwd glob pattern.
    evaluateRequiredCwd(context: IContext): boolean {

        if (!this.requiredCwd) {
            return true;
        }

        if (context.cwdResolved === false) {
            return false;
        }

        return picomatch(this.requiredCwd, { dot: true })(context.cwd);
    }

    // Match a file tool node by tool type and path glob.
    async evaluate(ast: IAstNode, context: IContext): Promise<IRuleEvaluation> {

        if (ast.type !== this.toolType) {
            return { context };
        }

        if (!this.evaluateRequiredCwd(context)) {
            return { context };
        }

        const fileNode = ast as IFilePathToolNode;

        if (this.pathIn.length > 0) {
            let matched = false;

            for (const pathEntry of this.pathIn) {
                if (picomatch(pathEntry, { dot: true })(fileNode.file_path)) {
                    matched = true;
                    break;
                }
            }

            if (!matched) {
                return { context };
            }
        }

        if (this.children || this.catchAll) {
            const childDecisions: IDecision[] = [];
            let workingContext = context;

            if (this.children) {
                for (const child of this.children) {
                    const childEvaluation = await child.evaluate(ast, workingContext);
                    workingContext = childEvaluation.context;

                    if (childEvaluation.decision) {
                        childDecisions.push(childEvaluation.decision);
                    }
                }
            }

            const childDecision = pickStrictest(childDecisions);
            if (childDecision) {
                return {
                    decision: childDecision,
                    context: workingContext,
                };
            }

            if (this.catchAll) {
                return this.catchAll.evaluate(ast, workingContext);
            }

            return {
                context: workingContext,
            };
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
