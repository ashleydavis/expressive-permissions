import { IAstChildren, IAstNode } from "../ast";
import { BashTokenKind } from "../tokenizer";
import { AstNode } from "./ast-node";

// Children of a binop node connecting two bash sub-expressions.
export interface IBinopChildren extends IAstChildren {

    // Left-hand operand of the binary operator.
    left: IAstNode;

    // Right-hand operand of the binary operator.
    right: IAstNode;
}

// AST node for a bash binary operator expression.
export class BinopAstNode extends AstNode {

    // Operator token (";", "&&", "||", or "|").
    op: BashTokenKind;

    // Named child nodes for the left and right operands.
    children: IBinopChildren;

    constructor(op: BashTokenKind, children: IBinopChildren, source: string) {
        super("binop", source);
        this.op = op;
        this.children = children;
    }
}
