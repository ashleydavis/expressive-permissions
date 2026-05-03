import { ToolCall, ToolRoot, IEditEntry, Read, Edit } from "./types";
import { parseBash } from "./parse-bash";

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
