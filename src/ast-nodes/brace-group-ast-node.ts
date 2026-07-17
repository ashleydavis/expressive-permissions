import { IAstChildren, IAstNode } from "../ast";
import { AstNode } from "./ast-node";

// Children of a brace group wrapping a statement list in `{ ...; }`.
export interface IBraceGroupChildren extends IAstChildren {

    // Inner statement list for the brace group body.
    body: IAstNode;
}

// AST node for a brace group `{ ...; }`.
export class BraceGroupAstNode extends AstNode {

    // Named child node for the inner statement list.
    children: IBraceGroupChildren;

    constructor(children: IBraceGroupChildren, source: string) {
        super("brace_group", source);
        this.children = children;
    }
}
