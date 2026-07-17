import { IAstChildren, IAstNode } from "../ast";
import { AstNode } from "./ast-node";

// Children of a while-loop node.
export interface IWhileLoopChildren extends IAstChildren {

    // Condition command(s) evaluated before each iteration.
    condition: IAstNode;

    // Loop body executed when the condition allows iteration.
    body: IAstNode;
}

// AST node for a bash `while COND; do BODY; done` loop.
export class WhileLoopAstNode extends AstNode {

    // false for `while` loops.
    until: boolean;

    // Named child nodes for the condition and loop body.
    children: IWhileLoopChildren;

    constructor(until: boolean, children: IWhileLoopChildren, source: string) {
        super("while_loop", source);
        this.until = until;
        this.children = children;
    }
}
