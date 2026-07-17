import { IAstNode } from "../ast";
import { AstNode } from "./ast-node";

// AST node for a single bash command.
export interface ICommandNode extends IAstNode {

    // Discriminator for the command node.
    type: "command";

    // Shell command name (argv[0]).
    commandName: string;

    // Named flags and flag values.
    options: Record<string, string | boolean>;

    // Positional arguments.
    positionals: string[];

    // Environment variable assignments before the command.
    envPrefix: Record<string, string>;
}

// AST node for a single bash command.
export class CommandAstNode extends AstNode implements ICommandNode {

    // Discriminator for the command node.
    type: "command" = "command";

    // Shell command name (argv[0]).
    commandName: string;

    // Named flags and flag values.
    options: Record<string, string | boolean>;

    // Positional arguments.
    positionals: string[];

    // Environment variable assignments before the command.
    envPrefix: Record<string, string>;

    constructor(commandName: string, options: Record<string, string | boolean>, positionals: string[], envPrefix: Record<string, string>, source: string) {
        super("command", source);
        this.commandName = commandName;
        this.options = options;
        this.positionals = positionals;
        this.envPrefix = envPrefix;
    }
}
