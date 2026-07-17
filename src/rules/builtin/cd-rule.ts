import { resolve } from "path";
import { IAstNode } from "../../ast";
import { ICommandNode } from "../../ast-nodes/command-ast-node";
import { IContext } from "../../context";
import { IRule, IRuleEvaluation } from "../rule";

// CdRule tracks cwd changes caused by cd commands.
export class CdRule implements IRule {

    // Match cd commands and update context cwd from the first positional target.
    async evaluate(ast: IAstNode, context: IContext): Promise<IRuleEvaluation> {

        if (ast.type !== "command") {
            return { context };
        }

        const commandNode = ast as ICommandNode;

        if (commandNode.commandName !== "cd") {
            return { context };
        }

        if (commandNode.positionals.length === 0) {
            return { context };
        }

        const target = commandNode.positionals[0];

        if (target.includes("$")) {
            return {
                context: {
                    cwd: context.cwd,
                    cwdResolved: false,
                    env: context.env,
                },
            };
        }

        const newCwd = resolve(context.cwd, target);

        return {
            context: {
                cwd: newCwd,
                env: context.env,
            },
        };
    }
}
