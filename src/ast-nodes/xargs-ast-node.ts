import { IAstChildren, IAstNode } from "../ast";
import { AstNode } from "./ast-node";

// Children of an xargs node wrapping a subcommand invoked by xargs.
export interface IXargsChildren extends IAstChildren {

    // Parsed subcommand that xargs will run on each input line.
    child: IAstNode;
}

// AST node for a bash `xargs` invocation with a parsed subcommand child.
export class XargsAstNode extends AstNode {

    // Options consumed by xargs itself, not passed to the subcommand.
    options: Record<string, string | boolean>;

    // Named child node for the subcommand xargs invokes.
    children: IXargsChildren;

    constructor(options: Record<string, string | boolean>, children: IXargsChildren, source: string) {
        super("xargs", source);
        this.options = options;
        this.children = children;
    }
}
