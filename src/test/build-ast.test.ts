import { buildAst, expandToken, expandCommandOptions, describeNode } from "../build-ast";
import { IToolCall, IBash, IBinOp, ICaseStatement, IGroup, IIfStatement, IRead, IWrite, IEdit, IMultiEdit, IOtherTool, IWhileLoop, IXargsNode, ICommand, ICommandDescriptor } from "../types";

// makeDescriptors builds a one-command descriptor map with arity-1 flags for the given names.
function makeDescriptors(cmd: string, arity1Flags: string[]): Map<string, ICommandDescriptor> {
    const flags: Record<string, { arity: 0 | 1; kind: "string"; description: string }> = {};
    for (const flagName of arity1Flags) {
        flags[flagName] = { arity: 1, kind: "string", description: "" };
    }
    return new Map([[cmd, { description: cmd, positionals: [], flags }]]);
}

// makePathDescriptor builds a descriptor with a variadic path positional for the given command.
function makePathDescriptor(cmd: string): Map<string, ICommandDescriptor> {
    return new Map([[cmd, {
        description: cmd,
        positionals: [{ kind: "path", description: "files", variadic: true }],
        flags: {},
    }]]);
}

describe("buildAst", () => {
    test("Bash call produces bash root with raw and child sub-AST", () => {
        const call: IToolCall = {
            tool_name: "Bash",
            tool_input: { command: "ls -la /tmp" },
            cwd: "/tmp",
        };
        const result = buildAst(call, new Map());
        expect(result.type).toBe("bash");
        const node = result as IBash;
        expect(node.raw).toBe("ls -la /tmp");
        expect(node.ast.type).toBe("command");
    });

    test("Shell call produces bash root with raw and child sub-AST", () => {
        const call: IToolCall = {
            tool_name: "Shell",
            tool_input: { command: "ls -la /tmp" },
            cwd: "/tmp",
        };
        const result = buildAst(call, new Map());
        expect(result.type).toBe("bash");
        const node = result as IBash;
        expect(node.raw).toBe("ls -la /tmp");
        expect(node.ast.type).toBe("command");
    });

    test("Read call produces read node with file_path", () => {
        const call: IToolCall = {
            tool_name: "Read",
            tool_input: { file_path: "/etc/hosts" },
            cwd: "/tmp",
        };
        const result = buildAst(call, new Map());
        expect(result.type).toBe("read");
        const node = result as IRead;
        expect(node.file_path).toBe("/etc/hosts");
        expect(node.offset).toBeUndefined();
        expect(node.limit).toBeUndefined();
    });

    test("Read call with offset and limit includes both optional fields", () => {
        const call: IToolCall = {
            tool_name: "Read",
            tool_input: { file_path: "/etc/hosts", offset: 10, limit: 50 },
            cwd: "/tmp",
        };
        const result = buildAst(call, new Map());
        expect(result.type).toBe("read");
        const node = result as IRead;
        expect(node.file_path).toBe("/etc/hosts");
        expect(node.offset).toBe(10);
        expect(node.limit).toBe(50);
    });

    test("Write call produces write node with file_path and content", () => {
        const call: IToolCall = {
            tool_name: "Write",
            tool_input: { file_path: "/tmp/out.txt", content: "hello world" },
            cwd: "/tmp",
        };
        const result = buildAst(call, new Map());
        expect(result.type).toBe("write");
        const node = result as IWrite;
        expect(node.file_path).toBe("/tmp/out.txt");
        expect(node.content).toBe("hello world");
    });

    test("Edit call produces edit node with all four fields", () => {
        const call: IToolCall = {
            tool_name: "Edit",
            tool_input: {
                file_path: "/tmp/foo.ts",
                old_string: "foo",
                new_string: "bar",
                replace_all: true,
            },
            cwd: "/tmp",
        };
        const result = buildAst(call, new Map());
        expect(result.type).toBe("edit");
        const node = result as IEdit;
        expect(node.file_path).toBe("/tmp/foo.ts");
        expect(node.old_string).toBe("foo");
        expect(node.new_string).toBe("bar");
        expect(node.replace_all).toBe(true);
    });

    test("Edit call without replace_all omits the field", () => {
        const call: IToolCall = {
            tool_name: "Edit",
            tool_input: {
                file_path: "/tmp/foo.ts",
                old_string: "foo",
                new_string: "bar",
            },
            cwd: "/tmp",
        };
        const result = buildAst(call, new Map());
        expect(result.type).toBe("edit");
        const node = result as IEdit;
        expect(node.replace_all).toBeUndefined();
    });

    test("MultiEdit call produces multiedit node with file_path and edits array", () => {
        const call: IToolCall = {
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
        const result = buildAst(call, new Map());
        expect(result.type).toBe("multiedit");
        const node = result as IMultiEdit;
        expect(node.file_path).toBe("/tmp/foo.ts");
        expect(node.edits).toHaveLength(2);
        expect(node.edits[0].old_string).toBe("foo");
        expect(node.edits[1].old_string).toBe("baz");
    });

    test("Grep call produces other node with tool_name and tool_input", () => {
        const call: IToolCall = {
            tool_name: "Grep",
            tool_input: { pattern: "TODO", path: "/tmp" },
            cwd: "/tmp",
        };
        const result = buildAst(call, new Map());
        expect(result.type).toBe("other");
        const node = result as IOtherTool;
        expect(node.tool_name).toBe("Grep");
        expect(node.tool_input).toEqual({ pattern: "TODO", path: "/tmp" });
    });

    test("mcp__github__list_repos call produces other node with tool_name and tool_input", () => {
        const call: IToolCall = {
            tool_name: "mcp__github__list_repos",
            tool_input: { owner: "octocat" },
            cwd: "/tmp",
        };
        const result = buildAst(call, new Map());
        expect(result.type).toBe("other");
        const node = result as IOtherTool;
        expect(node.tool_name).toBe("mcp__github__list_repos");
        expect(node.tool_input).toEqual({ owner: "octocat" });
    });
});

describe("buildAst with descriptors", () => {
    test("grep pattern path: positional 0 is string (pattern), positional 1 is path via descriptor", () => {
        const descriptor = new Map([["grep", {
            description: "grep",
            positionals: [
                { kind: "string" as const, description: "pattern", variadic: false },
                { kind: "path" as const, description: "files", variadic: true },
            ],
            flags: {},
        }]]);
        const call: IToolCall = { tool_name: "Bash", tool_input: { command: "grep pattern /etc/hosts" }, cwd: "/tmp" };
        const result = buildAst(call, descriptor) as IBash;
        const cmd = result.ast as ICommand;
        expect(cmd.type).toBe("command");
        expect(cmd.cmd).toEqual(["pattern", "/etc/hosts"]);
    });

    test("grep -f config.txt path: -f consumed as arity-1 value flag, path lands as second positional", () => {
        const descriptor = new Map([["grep", {
            description: "grep",
            positionals: [
                { kind: "path" as const, description: "files", variadic: true },
            ],
            flags: { "f|file": { arity: 1 as const, kind: "path" as const, description: "" } },
        }]]);
        const call: IToolCall = { tool_name: "Bash", tool_input: { command: "grep -f config.txt /etc/hosts" }, cwd: "/tmp" };
        const result = buildAst(call, descriptor) as IBash;
        const cmd = result.ast as ICommand;
        expect(cmd.type).toBe("command");
        expect(cmd.options["f"]).toBe("config.txt");
        expect(cmd.cmd).toBe("/etc/hosts");
    });

    test("cat path1 path2: all positionals classified as paths via variadic descriptor entry", () => {
        const call: IToolCall = { tool_name: "Bash", tool_input: { command: "cat /etc/hosts /etc/passwd" }, cwd: "/tmp" };
        const result = buildAst(call, makePathDescriptor("cat")) as IBash;
        const cmd = result.ast as ICommand;
        expect(cmd.type).toBe("command");
        expect(cmd.cmd).toEqual(["/etc/hosts", "/etc/passwd"]);
    });

    test("rm -r and rm --recursive both resolve identically when aliases declared", () => {
        const descriptor = new Map([["rm", {
            description: "rm",
            positionals: [{ kind: "path" as const, description: "files", variadic: true }],
            flags: { "r|recursive": { arity: 0 as const, kind: "string" as const, description: "" } },
        }]]);
        const callShort: IToolCall = { tool_name: "Bash", tool_input: { command: "rm -r /tmp/foo" }, cwd: "/tmp" };
        const callLong: IToolCall = { tool_name: "Bash", tool_input: { command: "rm --recursive /tmp/foo" }, cwd: "/tmp" };
        const shortCmd = (buildAst(callShort, descriptor) as IBash).ast as ICommand;
        const longCmd = (buildAst(callLong, descriptor) as IBash).ast as ICommand;
        expect(shortCmd.cmd).toBe("/tmp/foo");
        expect(longCmd.cmd).toBe("/tmp/foo");
    });

    test("unknown command with unrecognised flag: flag is arity 0, next token is a separate string positional", () => {
        const call: IToolCall = { tool_name: "Bash", tool_input: { command: "mytool --output result.txt" }, cwd: "/tmp" };
        const result = buildAst(call, new Map()) as IBash;
        const cmd = result.ast as ICommand;
        expect(cmd.type).toBe("command");
        expect(cmd.options["output"]).toBe(true);
        expect(cmd.cmd).toBe("result.txt");
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

    test("xargs node returns raw", () => {
        const child: ICommand = { type: "command", binary: "grep", options: {}, cmd: [], envPrefix: {}, redirects: [], raw: "grep" };
        const xargsNode: IXargsNode = { type: "xargs", options: {}, child, raw: "xargs grep -l pattern" };
        expect(describeNode(xargsNode)).toBe("xargs grep -l pattern");
    });

    test("if-statement node returns raw", () => {
        const condition: ICommand = { type: "command", binary: "test", options: {}, cmd: [], envPrefix: {}, redirects: [], raw: "test" };
        const thenBranch: ICommand = { type: "command", binary: "echo", options: {}, cmd: [], envPrefix: {}, redirects: [], raw: "echo" };
        const ifNode: IIfStatement = { type: "if_statement", condition, thenBranch, raw: "if test; then echo; fi" };
        expect(describeNode(ifNode)).toBe("if test; then echo; fi");
    });

    test("while-loop node returns raw", () => {
        const condition: ICommand = { type: "command", binary: "true", options: {}, cmd: [], envPrefix: {}, redirects: [], raw: "true" };
        const body: ICommand = { type: "command", binary: "echo", options: {}, cmd: [], envPrefix: {}, redirects: [], raw: "echo" };
        const loop: IWhileLoop = { type: "while_loop", until: false, condition, body, raw: "while true; do echo; done" };
        expect(describeNode(loop)).toBe("while true; do echo; done");
    });

    test("group node returns raw", () => {
        const body: ICommand = { type: "command", binary: "echo", options: {}, cmd: [], envPrefix: {}, redirects: [], raw: "echo" };
        const group: IGroup = { type: "group", style: "subshell", body, raw: "(echo)" };
        expect(describeNode(group)).toBe("(echo)");
    });

    test("case-statement node returns raw", () => {
        const body: ICommand = { type: "command", binary: "echo", options: {}, cmd: [], envPrefix: {}, redirects: [], raw: "echo" };
        const caseNode: ICaseStatement = { type: "case_statement", word: "$x", clauses: [{ patterns: ["a"], body }], raw: "case $x in a) echo;; esac" };
        expect(describeNode(caseNode)).toBe("case $x in a) echo;; esac");
    });
});

describe("transformXargsNodes via buildAst", () => {
    test("xargs inside an if-statement branch is transformed to an xargs node", () => {
        const call: IToolCall = {
            tool_name: "Bash",
            tool_input: { command: "if test -f list; then cat list | xargs rm; fi" },
            cwd: "/start",
        };
        const root = buildAst(call, new Map()) as IBash;
        const ifNode = root.ast as IIfStatement;
        expect(ifNode.type).toBe("if_statement");
        const pipeline = ifNode.thenBranch as IBinOp;
        expect(pipeline.op).toBe("|");
        expect(pipeline.right.type).toBe("xargs");
    });

    test("xargs inside a while-loop body is transformed", () => {
        const call: IToolCall = {
            tool_name: "Bash",
            tool_input: { command: "while true; do find . | xargs rm; done" },
            cwd: "/start",
        };
        const root = buildAst(call, new Map()) as IBash;
        const loop = root.ast as IWhileLoop;
        const pipeline = loop.body as IBinOp;
        expect(pipeline.right.type).toBe("xargs");
    });

    test("xargs inside a subshell group is transformed", () => {
        const call: IToolCall = {
            tool_name: "Bash",
            tool_input: { command: "(find . | xargs rm)" },
            cwd: "/start",
        };
        const root = buildAst(call, new Map()) as IBash;
        const group = root.ast as IGroup;
        const pipeline = group.body as IBinOp;
        expect(pipeline.right.type).toBe("xargs");
    });

    test("xargs inside a case clause body is transformed", () => {
        const call: IToolCall = {
            tool_name: "Bash",
            tool_input: { command: "case $x in a) find . | xargs rm;; esac" },
            cwd: "/start",
        };
        const root = buildAst(call, new Map()) as IBash;
        const caseNode = root.ast as ICaseStatement;
        const pipeline = caseNode.clauses[0].body as IBinOp;
        expect(pipeline.right.type).toBe("xargs");
    });

    test("xargs inside a command substitution is transformed", () => {
        const call: IToolCall = {
            tool_name: "Bash",
            tool_input: { command: "echo $(find . | xargs rm)" },
            cwd: "/start",
        };
        const root = buildAst(call, new Map()) as IBash;
        const command = root.ast as ICommand;
        expect(command.substitutions).toBeDefined();
        const pipeline = command.substitutions![0] as IBinOp;
        expect(pipeline.right.type).toBe("xargs");
    });
});
