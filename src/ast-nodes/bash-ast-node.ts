import { IAstChildren, IAstNode } from "../ast";
import { AstNode } from "./ast-node";

// Children of a Bash tool-call root.
export interface IBashChildren extends IAstChildren {

    // Parsed bash expression root for this tool call (command or compound expression).
    command: IAstNode;
}

// AST node for a Bash tool call.
export class BashAstNode extends AstNode {

    // Named child nodes for this bash root.
    children: IBashChildren;

    constructor(children: IBashChildren, source: string) {
        super("bash", source);
        this.children = children;
    }
}
