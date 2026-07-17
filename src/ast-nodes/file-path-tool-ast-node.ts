import { IAstNode } from "../ast";
import { AstNode } from "./ast-node";

// AST node for Read, Write, Edit, and MultiEdit tool calls.
export interface IFilePathToolNode extends IAstNode {

    // Path of the file being accessed.
    file_path: string;
}

// AST node for Read, Write, Edit, and MultiEdit tool calls.
export class FilePathToolAstNode extends AstNode implements IFilePathToolNode {

    // Path of the file being accessed.
    file_path: string;

    constructor(type: string, file_path: string, source: string) {
        super(type, source);
        this.file_path = file_path;
    }
}
