import { IAstNode } from "../../ast";
import { ICommandNode } from "../../ast-nodes/command-ast-node";
import { IContext } from "../../context";
import { IRule, IRuleEvaluation } from "../rule";

// ExportRule allows `export KEY=VALUE` commands that set environment variables.
export class ExportRule implements IRule {

    // Match export commands with at least one KEY=VALUE positional.
    async evaluate(ast: IAstNode, context: IContext): Promise<IRuleEvaluation> {

        if (ast.type !== "command") {
            return { context };
        }

        const commandNode = ast as ICommandNode;

        if (commandNode.commandName !== "export") {
            return { context };
        }

        let hasKeyValueToken = false;
        const updates: Record<string, string> = {};

        for (const token of commandNode.positionals) {
            const eqIndex = token.indexOf("=");

            if (eqIndex > 0) {
                hasKeyValueToken = true;
                updates[token.slice(0, eqIndex)] = token.slice(eqIndex + 1);
            }
        }

        if (!hasKeyValueToken) {
            return { context };
        }

        return {
            decision: {
                action: "allow",
                reason: "set environment variable",
            },
            context: {
                cwd: context.cwd,
                env: { ...context.env, ...updates },
            },
        };
    }
}
