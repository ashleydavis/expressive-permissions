// Raw tool call payload from the PreToolUse hook.
export interface IToolCall {

    // Tool name as reported by Claude Code.
    tool_name: string;

    // Input arguments supplied to the tool.
    tool_input: Record<string, string>;

    // Working directory at hook invocation time.
    cwd: string;
}
