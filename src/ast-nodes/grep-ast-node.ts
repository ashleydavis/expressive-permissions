import { AstNode } from "./ast-node";

// AST node for a Grep tool call.
export class GrepAstNode extends AstNode {

    // Search pattern.
    pattern: string;

    // Directory or file path to search under.
    path: string;

    constructor(pattern: string, path: string, source: string) {
        super("grep", source);
        this.pattern = pattern;
        this.path = path;
    }
}
