import { IAstChildren, IAstNode } from "../ast";
import { AstNode } from "./ast-node";

// Children of an if-statement node.
export interface IIfStatementChildren extends IAstChildren {

    // Condition command(s) evaluated to choose a branch.
    condition: IAstNode;

    // Body executed when the condition succeeds.
    thenBranch: IAstNode;

    // Body executed when the condition fails; omitted when there is no else branch.
    elseBranch?: IAstNode;
}

// AST node for a bash `if COND; then BODY [else BODY]; fi` statement.
export class IfStatementAstNode extends AstNode {

    // Named child nodes for the condition and branch bodies.
    children: IIfStatementChildren;

    constructor(children: IIfStatementChildren, source: string) {
        super("if_statement", source);
        this.children = children;
    }
}
