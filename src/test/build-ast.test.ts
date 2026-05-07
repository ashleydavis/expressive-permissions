import { buildAst, expandToken, expandCommandOptions, describeNode } from "../build-ast";
import { ToolCall, Bash, Read, Write, Edit, MultiEdit, OtherTool } from "../types";

describe("buildAst", () => {
    test("Bash call produces bash root with raw and child sub-AST", () => {
        const call: ToolCall = {
            tool_name: "Bash",
            tool_input: { command: "ls -la /tmp" },
            cwd: "/tmp",
        };
        const result = buildAst(call);
        expect(result.type).toBe("bash");
        const node = result as Bash;
        expect(node.raw).toBe("ls -la /tmp");
        expect(node.ast.type).toBe("command");
    });

    test("Read call produces read node with file_path", () => {
        const call: ToolCall = {
            tool_name: "Read",
            tool_input: { file_path: "/etc/hosts" },
            cwd: "/tmp",
        };
        const result = buildAst(call);
        expect(result.type).toBe("read");
        const node = result as Read;
        expect(node.file_path).toBe("/etc/hosts");
        expect(node.offset).toBeUndefined();
        expect(node.limit).toBeUndefined();
    });

    test("Read call with offset and limit includes both optional fields", () => {
        const call: ToolCall = {
            tool_name: "Read",
            tool_input: { file_path: "/etc/hosts", offset: 10, limit: 50 },
            cwd: "/tmp",
        };
        const result = buildAst(call);
        expect(result.type).toBe("read");
        const node = result as Read;
        expect(node.file_path).toBe("/etc/hosts");
        expect(node.offset).toBe(10);
        expect(node.limit).toBe(50);
    });

    test("Write call produces write node with file_path and content", () => {
        const call: ToolCall = {
            tool_name: "Write",
            tool_input: { file_path: "/tmp/out.txt", content: "hello world" },
            cwd: "/tmp",
        };
        const result = buildAst(call);
        expect(result.type).toBe("write");
        const node = result as Write;
        expect(node.file_path).toBe("/tmp/out.txt");
        expect(node.content).toBe("hello world");
    });

    test("Edit call produces edit node with all four fields", () => {
        const call: ToolCall = {
            tool_name: "Edit",
            tool_input: {
                file_path: "/tmp/foo.ts",
                old_string: "foo",
                new_string: "bar",
                replace_all: true,
            },
            cwd: "/tmp",
        };
        const result = buildAst(call);
        expect(result.type).toBe("edit");
        const node = result as Edit;
        expect(node.file_path).toBe("/tmp/foo.ts");
        expect(node.old_string).toBe("foo");
        expect(node.new_string).toBe("bar");
        expect(node.replace_all).toBe(true);
    });

    test("Edit call without replace_all omits the field", () => {
        const call: ToolCall = {
            tool_name: "Edit",
            tool_input: {
                file_path: "/tmp/foo.ts",
                old_string: "foo",
                new_string: "bar",
            },
            cwd: "/tmp",
        };
        const result = buildAst(call);
        expect(result.type).toBe("edit");
        const node = result as Edit;
        expect(node.replace_all).toBeUndefined();
    });

    test("MultiEdit call produces multiedit node with file_path and edits array", () => {
        const call: ToolCall = {
            tool_name: "MultiEdit",
            tool_input: {
                file_path: "/tmp/foo.ts",
                edits: [
                    { file_path: "/tmp/foo.ts", old_string: "foo", new_string: "bar" },
                    { file_path: "/tmp/foo.ts", old_string: "baz", new_string: "qux" },
                ],
            },
            cwd: "/tmp",
        };
        const result = buildAst(call);
        expect(result.type).toBe("multiedit");
        const node = result as MultiEdit;
        expect(node.file_path).toBe("/tmp/foo.ts");
        expect(node.edits).toHaveLength(2);
        expect(node.edits[0].old_string).toBe("foo");
        expect(node.edits[1].old_string).toBe("baz");
    });

    test("Grep call produces other node with tool_name and tool_input", () => {
        const call: ToolCall = {
            tool_name: "Grep",
            tool_input: { pattern: "TODO", path: "/tmp" },
            cwd: "/tmp",
        };
        const result = buildAst(call);
        expect(result.type).toBe("other");
        const node = result as OtherTool;
        expect(node.tool_name).toBe("Grep");
        expect(node.tool_input).toEqual({ pattern: "TODO", path: "/tmp" });
    });

    test("mcp__github__list_repos call produces other node with tool_name and tool_input", () => {
        const call: ToolCall = {
            tool_name: "mcp__github__list_repos",
            tool_input: { owner: "octocat" },
            cwd: "/tmp",
        };
        const result = buildAst(call);
        expect(result.type).toBe("other");
        const node = result as OtherTool;
        expect(node.tool_name).toBe("mcp__github__list_repos");
        expect(node.tool_input).toEqual({ owner: "octocat" });
    });
});

describe("expandToken", () => {
    test("substitutes $VAR when var exists", () => {
        expect(expandToken("$FOO", { FOO: "bar" })).toBe("bar");
    });

    test("substitutes ${VAR} brace syntax", () => {
        expect(expandToken("${FOO}", { FOO: "bar" })).toBe("bar");
    });

    test("leaves unknown var as-is", () => {
        expect(expandToken("$UNKNOWN", {})).toBe("$UNKNOWN");
    });

    test("returns unchanged string when no vars present", () => {
        expect(expandToken("hello world", {})).toBe("hello world");
    });
});

describe("expandCommandOptions", () => {
    test("expands binary", () => {
        const node = { type: "command" as const, binary: "$CMD", options: {}, cmd: [], envPrefix: {}, redirects: [], raw: "$CMD" };
        expect(expandCommandOptions(node, { CMD: "git" }).binary).toBe("git");
    });

    test("expands positional array element", () => {
        const node = { type: "command" as const, binary: "git", options: {}, cmd: ["add", "$FILE"], envPrefix: {}, redirects: [], raw: "git add $FILE" };
        expect(expandCommandOptions(node, { FILE: "foo.ts" }).cmd).toEqual(["add", "foo.ts"]);
    });

    test("preserves raw field unchanged", () => {
        const node = { type: "command" as const, binary: "$CMD", options: {}, cmd: [], envPrefix: {}, redirects: [], raw: "original $CMD" };
        expect(expandCommandOptions(node, { CMD: "git" }).raw).toBe("original $CMD");
    });
});

describe("describeNode", () => {
    test("command node returns raw", () => {
        const node = { type: "command" as const, binary: "ls", options: {}, cmd: [], envPrefix: {}, redirects: [], raw: "ls -la" };
        expect(describeNode(node)).toBe("ls -la");
    });

    test("read node returns file_path", () => {
        expect(describeNode({ type: "read", file_path: "/etc/hosts" })).toBe("/etc/hosts");
    });

    test("other node returns tool_name", () => {
        expect(describeNode({ type: "other", tool_name: "Grep", tool_input: {} })).toBe("Grep");
    });

    test("binop node rebuilds left op right", () => {
        const left = { type: "command" as const, binary: "a", options: {}, cmd: [], envPrefix: {}, redirects: [], raw: "a" };
        const right = { type: "command" as const, binary: "b", options: {}, cmd: [], envPrefix: {}, redirects: [], raw: "b" };
        expect(describeNode({ type: "binop", op: "&&", left, right })).toBe("a && b");
    });
});
