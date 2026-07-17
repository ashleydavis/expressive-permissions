import { IAstNode } from "../../ast";
import { ICommandNode } from "../../ast-nodes/command-ast-node";
import { IContext } from "../../context";
import { IRule, IRuleEvaluation } from "../rule";

// EmptyCommandRule allows command nodes with no command name and a non-empty env prefix.
export class EmptyCommandRule implements IRule {

    // Match standalone prefix-only command nodes such as FOO=bar.
    async evaluate(ast: IAstNode, context: IContext): Promise<IRuleEvaluation> {

        if (ast.type !== "command") {
            return { context };
        }

        const commandNode = ast as ICommandNode;

        if (commandNode.commandName !== "") {
            return { context };
        }

        if (Object.keys(commandNode.envPrefix).length === 0) {
            return { context };
        }

        return {
            decision: {
                action: "allow",
            },
            context: {
                cwd: context.cwd,
                env: { ...context.env, ...commandNode.envPrefix },
            },
        };
    }
}
