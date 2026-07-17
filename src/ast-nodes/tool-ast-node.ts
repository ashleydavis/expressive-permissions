import { IAstNode } from "../ast";
import { AstNode } from "./ast-node";

// Shape of an unmodeled tool-call node consumed by tool rules, decoupling them from the node class.
export interface IToolNode extends IAstNode {

    // Discriminator for an unmodeled tool root.
    type: "tool";

    // Tool name as reported by Claude Code.
    tool_name: string;

    // Raw tool input payload.
    tool_input: Record<string, string>;
}

// AST node for a tool call not yet modeled with a dedicated node type.
export class ToolAstNode extends AstNode implements IToolNode {

    // Discriminator for an unmodeled tool root.
    type: "tool" = "tool";

    // Tool name as reported by Claude Code.
    tool_name: string;

    // Raw tool input payload.
    tool_input: Record<string, string>;

    constructor(tool_name: string, tool_input: Record<string, string>, source: string) {
        super("tool", source);
        this.tool_name = tool_name;
        this.tool_input = tool_input;
    }
}
