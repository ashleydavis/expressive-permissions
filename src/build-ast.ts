import { ToolCall, ToolRoot, IEditEntry, Read, Edit, AstNode, BinOp, Command } from "./types";
import { parseBash } from "./parse-bash";

// expandToken substitutes $VAR and ${VAR} references in a single string using the
// provided vars dict. Unknown variable references are left as-is.
export function expandToken(token: string, vars: Record<string, string>): string {
    return token.replace(
        /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
        (match: string, braced: string, unbraced: string) => {
            const varName = braced || unbraced;
            return vars[varName] !== undefined ? vars[varName] : match;
        }
    );
}

// expandCommandOptions clones a Command node with binary, flag values, and positionals expanded
// against the provided vars dict. The raw field is preserved unchanged.
export function expandCommandOptions(node: Command, vars: Record<string, string>): Command {
    const expandedOptions: Record<string, string | boolean> = {};
    for (const [key, value] of Object.entries(node.options)) {
        expandedOptions[key] = typeof value === "string" ? expandToken(value, vars) : value;
    }

    let expandedCmd: string | string[];
    if (typeof node.cmd === "string") {
        expandedCmd = expandToken(node.cmd, vars);
    }
    else {
        expandedCmd = node.cmd.map((positional: string) => expandToken(positional, vars));
    }

    return {
        ...node,
        binary: expandToken(node.binary, vars),
        options: expandedOptions,
        cmd: expandedCmd,
    };
}

// describeNode returns a human-readable string representation of an AST node for log output.
// For command nodes it returns the raw command string. For tool-root leaf nodes it returns
// the relevant file path or tool name. For intermediate nodes it recursively rebuilds
// the expression from its children.
export function describeNode(node: AstNode): string {
    switch (node.type) {
        case "command":
            return node.raw;
        case "binop":
            return `${describeNode((node as BinOp).left)} ${(node as BinOp).op} ${describeNode((node as BinOp).right)}`;
        case "for_loop":
            return node.raw;
        case "bash":
            return node.raw;
        case "read":
            return node.file_path;
        case "write":
            return node.file_path;
        case "edit":
            return node.file_path;
        case "multiedit":
            return node.file_path;
        case "other":
            return node.tool_name;
    }
}

// buildAst converts a raw ToolCall into the typed ToolRoot that the interpreter and rules see.
// Switches on tool_name and maps the tool_input fields to a strongly-typed node.
// Unknown tools fall through to an OtherTool node that preserves the raw input.
export function buildAst(call: ToolCall): ToolRoot {
    switch (call.tool_name) {
        case "Bash": {
            const command = call.tool_input.command as string;
            return {
                type: "bash",
                raw: command,
                ast: parseBash(command),
            };
        }
        case "Read": {
            const node: Read = {
                type: "read",
                file_path: call.tool_input.file_path as string,
            };
            if (call.tool_input.offset !== undefined) {
                node.offset = call.tool_input.offset as number;
            }
            if (call.tool_input.limit !== undefined) {
                node.limit = call.tool_input.limit as number;
            }
            return node;
        }
        case "Write": {
            return {
                type: "write",
                file_path: call.tool_input.file_path as string,
                content: call.tool_input.content as string,
            };
        }
        case "Edit": {
            const node: Edit = {
                type: "edit",
                file_path: call.tool_input.file_path as string,
                old_string: call.tool_input.old_string as string,
                new_string: call.tool_input.new_string as string,
            };
            if (call.tool_input.replace_all !== undefined) {
                node.replace_all = call.tool_input.replace_all as boolean;
            }
            return node;
        }
        case "MultiEdit": {
            return {
                type: "multiedit",
                file_path: call.tool_input.file_path as string,
                edits: call.tool_input.edits as IEditEntry[],
            };
        }
        default: {
            return {
                type: "other",
                tool_name: call.tool_name,
                tool_input: call.tool_input,
            };
        }
    }
}
