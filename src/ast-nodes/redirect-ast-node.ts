import { IAstChildren, IAstNode } from "../ast";
import { AstNode } from "./ast-node";

// Children of a redirect node wrapping a command with an I/O redirection.
export interface IRedirectChildren extends IAstChildren {

    // Inner command or nested redirect being wrapped.
    command: IAstNode;
}

// AST node for a shell I/O redirection wrapping a command.
export interface IRedirectNode extends IAstNode {

    // Discriminator for a redirect node.
    type: "redirect";

    // Redirection operator (e.g. ">", ">>", "<", "2>", "&>", "2>&").
    op: string;

    // Redirection target (file path or fd number as string for merges like "1").
    target: string;

    // Named child node for the wrapped command or inner redirect.
    children: IRedirectChildren;
}

// AST node for a shell I/O redirection wrapping a command.
export class RedirectAstNode extends AstNode implements IRedirectNode {

    // Discriminator for a redirect node.
    type: "redirect" = "redirect";

    // Redirection operator (e.g. ">", ">>", "<", "2>", "&>", "2>&").
    op: string;

    // Redirection target (file path or fd number as string for merges like "1").
    target: string;

    // Named child node for the wrapped command or inner redirect.
    children: IRedirectChildren;

    constructor(op: string, target: string, children: IRedirectChildren, source: string) {
        super("redirect", source);
        this.op = op;
        this.target = target;
        this.children = children;
    }
}
