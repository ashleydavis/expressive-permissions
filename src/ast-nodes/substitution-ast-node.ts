import { IAstChildren, IAstNode } from "../ast";
import { AstNode } from "./ast-node";

// Children of a command substitution wrapping the command run inside `$(...)` or backticks.
export interface ISubstitutionChildren extends IAstChildren {

    // Parsed command that the substitution runs and whose output is spliced into the outer command.
    command: IAstNode;
}

// AST node for a command substitution `$(...)` or `` `...` `` embedded in a command argument.
export class SubstitutionAstNode extends AstNode {

    // Named child node for the command run inside the substitution.
    children: ISubstitutionChildren;

    constructor(children: ISubstitutionChildren, source: string) {
        super("substitution", source);
        this.children = children;
    }
}
