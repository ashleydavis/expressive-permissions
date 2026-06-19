import { parseBash } from "../parse-bash";
import { BashAstNode, ICommand, IBinOp, IForLoop, IIfStatement, ICommandDescriptor } from "../types";

// makeDescriptors returns a descriptor map with a single command whose named flags have arity 1.
// All unlisted flags default to arity 0 via the EMPTY_DESCRIPTOR fallback.
function makeDescriptors(cmd: string, arity1Flags: string[]): Map<string, ICommandDescriptor> {
    const flags: Record<string, { arity: 0 | 1; kind: "string"; description: string }> = {};
    for (const flagName of arity1Flags) {
        flags[flagName] = { arity: 1, kind: "string", description: "" };
    }
    return new Map([[cmd, { description: cmd, positionals: [], flags }]]);
}

// makeDescriptorsWithCmds returns a descriptor map for a command that has top-level flags and
// sub-command entries, each with their own flags.
function makeDescriptorsWithCmds(
    cmd: string,
    topLevel1Flags: string[],
    subCmds: Record<string, string[]>
): Map<string, ICommandDescriptor> {
    const topLevelFlags: Record<string, { arity: 0 | 1; kind: "string"; description: string }> = {};
    for (const flagName of topLevel1Flags) {
        topLevelFlags[flagName] = { arity: 1, kind: "string", description: "" };
    }
    const cmds: { [subCommand: string]: ICommandDescriptor } = {};
    for (const [subCmdName, arity1Flags] of Object.entries(subCmds)) {
        const subFlags: Record<string, { arity: 0 | 1; kind: "string"; description: string }> = {};
        for (const flagName of arity1Flags) {
            subFlags[flagName] = { arity: 1, kind: "string", description: "" };
        }
        cmds[subCmdName] = { description: subCmdName, positionals: [], flags: subFlags };
    }
    return new Map([[cmd, { description: cmd, positionals: [], flags: topLevelFlags, cmds }]]);
}

// Asserts the node is a Command with the given binary and returns it for further inspection.
function expectCommand(node: BashAstNode, binary: string): ICommand {
    expect(node.type).toBe("command");
    const cmd = node as ICommand;
    expect(cmd.binary).toBe(binary);
    return cmd;
}

// Asserts the node is a BinOp with the given operator and returns it for further inspection.
function expectBinOp(node: BashAstNode, op: string): IBinOp {
    expect(node.type).toBe("binop");
    const binop = node as IBinOp;
    expect(binop.op).toBe(op);
    return binop;
}

describe("parseBash", () => {
    describe("single-command shapes", () => {
        test("bare binary", () => {
            const node = parseBash("ls", new Map());
            const cmd = expectCommand(node, "ls");
            expect(cmd.options).toEqual({});
            expect(cmd.cmd).toEqual([]);
        });

        test("positionals and flags", () => {
            const node = parseBash("ls -la /tmp", new Map());
            const cmd = expectCommand(node, "ls");
            expect(cmd.options).toEqual({ l: true, a: true });
            expect(cmd.cmd).toBe("/tmp");
        });

        test("long flag", () => {
            const node = parseBash("npm test --watch", new Map());
            const cmd = expectCommand(node, "npm");
            expect(cmd.options).toEqual({ watch: true });
            expect(cmd.cmd).toBe("test");
        });

        test("long flag with equals value", () => {
            const node = parseBash("npm test --reporter=spec", new Map());
            const cmd = expectCommand(node, "npm");
            expect(cmd.options).toEqual({ reporter: "spec" });
            expect(cmd.cmd).toBe("test");
        });

        test("long flag with space-separated value", () => {
            const node = parseBash("kubectl delete --context prod-cluster", makeDescriptors("kubectl", ["context"]));
            const cmd = expectCommand(node, "kubectl");
            expect(cmd.options).toEqual({ context: "prod-cluster" });
            expect(cmd.cmd).toBe("delete");
        });

        test("long flag with equals value and space-separated value are equivalent", () => {
            const descriptors = makeDescriptors("kubectl", ["context"]);
            const nodeEquals = parseBash("kubectl delete --context=prod-cluster", descriptors);
            const cmdEquals = expectCommand(nodeEquals, "kubectl");
            const nodeSpace = parseBash("kubectl delete --context prod-cluster", descriptors);
            const cmdSpace = expectCommand(nodeSpace, "kubectl");
            expect(cmdEquals.options).toEqual(cmdSpace.options);
            expect(cmdEquals.cmd).toEqual(cmdSpace.cmd);
        });

        test("long flag followed by another flag stays boolean", () => {
            const node = parseBash("npm test --watch --reporter=spec", new Map());
            const cmd = expectCommand(node, "npm");
            expect(cmd.options).toEqual({ watch: true, reporter: "spec" });
            expect(cmd.cmd).toBe("test");
        });

        test("short flag with equals value", () => {
            const node = parseBash("git commit -m=fix", new Map());
            const cmd = expectCommand(node, "git");
            expect(cmd.options).toEqual({ m: "fix" });
            expect(cmd.cmd).toBe("commit");
        });

        test("single-char short flag consumes following non-flag token as value", () => {
            const node = parseBash("git commit -m fix", makeDescriptors("git", ["m"]));
            const cmd = expectCommand(node, "git");
            expect(cmd.options).toEqual({ m: "fix" });
            expect(cmd.cmd).toBe("commit");
        });

        test("git -C consumes following path as its value, not as positional", () => {
            const node = parseBash("git -C /home/user/tickets/example-project/myapp status -sb", makeDescriptors("git", ["C"]));
            const cmd = expectCommand(node, "git");
            expect(cmd.options).toEqual({ C: "/home/user/tickets/example-project/myapp", s: true, b: true });
            expect(cmd.cmd).toBe("status");
        });

        test("double-quoted positional", () => {
            const node = parseBash('echo "hello world"', new Map());
            const cmd = expectCommand(node, "echo");
            expect(cmd.options).toEqual({});
            expect(cmd.cmd).toBe("hello world");
        });

        test("single-quoted flag value", () => {
            const node = parseBash("git commit -m='fix: bug'", new Map());
            const cmd = expectCommand(node, "git");
            expect(cmd.options).toEqual({ m: "fix: bug" });
            expect(cmd.cmd).toBe("commit");
        });

        test("escaped char becomes literal", () => {
            const node = parseBash("echo \\$HOME", new Map());
            const cmd = expectCommand(node, "echo");
            expect(cmd.options).toEqual({});
            expect(cmd.cmd).toBe("$HOME");
        });

        test("empty input returns empty command", () => {
            const node = parseBash("", new Map());
            const cmd = expectCommand(node, "");
            expect(cmd.options).toEqual({});
            expect(cmd.cmd).toEqual([]);
            expect(cmd.envPrefix).toEqual({});
            expect(cmd.redirects).toEqual([]);
            expect(cmd.raw).toBe("");
        });

        test("whitespace-only input returns empty command", () => {
            const node = parseBash("   ", new Map());
            const cmd = expectCommand(node, "");
            expect(cmd.raw).toBe("");
        });

        test("binary with path", () => {
            const node = parseBash("./scripts/run.sh", new Map());
            expectCommand(node, "./scripts/run.sh");
        });

        test("binary with hyphens", () => {
            const node = parseBash("my-tool", new Map());
            expectCommand(node, "my-tool");
        });

        test("binary with dots", () => {
            const node = parseBash("node.exe", new Map());
            expectCommand(node, "node.exe");
        });
    });

    describe("operators", () => {
        test("pipe: a | b", () => {
            const node = parseBash("a | b", new Map());
            const binop = expectBinOp(node, "|");
            expectCommand(binop.left, "a");
            expectCommand(binop.right, "b");
        });

        test("and: a && b", () => {
            const node = parseBash("a && b", new Map());
            const binop = expectBinOp(node, "&&");
            expectCommand(binop.left, "a");
            expectCommand(binop.right, "b");
        });

        test("or: a || b", () => {
            const node = parseBash("a || b", new Map());
            const binop = expectBinOp(node, "||");
            expectCommand(binop.left, "a");
            expectCommand(binop.right, "b");
        });

        test("sequence: a; b", () => {
            const node = parseBash("a; b", new Map());
            const binop = expectBinOp(node, ";");
            expectCommand(binop.left, "a");
            expectCommand(binop.right, "b");
        });

        test("chained pipes fold left: a | b | c", () => {
            const node = parseBash("a | b | c", new Map());
            const outerBinop = expectBinOp(node, "|");
            const innerBinop = expectBinOp(outerBinop.left, "|");
            expectCommand(innerBinop.left, "a");
            expectCommand(innerBinop.right, "b");
            expectCommand(outerBinop.right, "c");
        });

        test("chained ands fold left: a && b && c", () => {
            const node = parseBash("a && b && c", new Map());
            const outerBinop = expectBinOp(node, "&&");
            const innerBinop = expectBinOp(outerBinop.left, "&&");
            expectCommand(innerBinop.left, "a");
            expectCommand(innerBinop.right, "b");
            expectCommand(outerBinop.right, "c");
        });

        test("mixed: a && b || c — || binds tighter per grammar", () => {
            // Grammar: parseAnd calls parseOr for each operand, so a && b || c → a && (b || c)
            const node = parseBash("a && b || c", new Map());
            const andBinop = expectBinOp(node, "&&");
            expectCommand(andBinop.left, "a");
            const orBinop = expectBinOp(andBinop.right, "||");
            expectCommand(orBinop.left, "b");
            expectCommand(orBinop.right, "c");
        });

        test("mixed: a; b && c | d", () => {
            const node = parseBash("a; b && c | d", new Map());
            const seqBinop = expectBinOp(node, ";");
            expectCommand(seqBinop.left, "a");
            const andBinop = expectBinOp(seqBinop.right, "&&");
            expectCommand(andBinop.left, "b");
            const pipeBinop = expectBinOp(andBinop.right, "|");
            expectCommand(pipeBinop.left, "c");
            expectCommand(pipeBinop.right, "d");
        });
    });

    describe("env-var prefixes", () => {
        test("single prefix", () => {
            const node = parseBash("FOO=bar cmd", new Map());
            const cmd = expectCommand(node, "cmd");
            expect(cmd.envPrefix).toEqual({ FOO: "bar" });
            expect(cmd.options).toEqual({});
            expect(cmd.cmd).toEqual([]);
        });

        test("multiple prefixes", () => {
            const node = parseBash("A=1 B=2 cmd", new Map());
            const cmd = expectCommand(node, "cmd");
            expect(cmd.envPrefix).toEqual({ A: "1", B: "2" });
        });

        test("quoted value in prefix", () => {
            const node = parseBash('FOO="hello world" cmd', new Map());
            const cmd = expectCommand(node, "cmd");
            expect(cmd.envPrefix).toEqual({ FOO: "hello world" });
        });

        test("env-only segment (no binary) yields empty binary", () => {
            const node = parseBash("FOO=bar", new Map());
            const cmd = expectCommand(node, "");
            expect(cmd.envPrefix).toEqual({ FOO: "bar" });
        });
    });

    describe("redirects", () => {
        test("stdout redirect", () => {
            const node = parseBash("cmd > out.log", new Map());
            const cmd = expectCommand(node, "cmd");
            expect(cmd.redirects).toEqual([{ op: ">", target: "out.log" }]);
        });

        test("stdout append redirect", () => {
            const node = parseBash("cmd >> out.log", new Map());
            const cmd = expectCommand(node, "cmd");
            expect(cmd.redirects).toEqual([{ op: ">>", target: "out.log" }]);
        });

        test("stdin redirect", () => {
            const node = parseBash("cmd < in.txt", new Map());
            const cmd = expectCommand(node, "cmd");
            expect(cmd.redirects).toEqual([{ op: "<", target: "in.txt" }]);
        });

        test("stderr redirect", () => {
            const node = parseBash("cmd 2> err.log", new Map());
            const cmd = expectCommand(node, "cmd");
            expect(cmd.redirects).toEqual([{ op: "2>", target: "err.log" }]);
        });

        test("stdout redirect with stderr merged to stdout", () => {
            const node = parseBash("cmd > out 2>&1", new Map());
            const cmd = expectCommand(node, "cmd");
            expect(cmd.redirects).toEqual([
                { op: ">", target: "out" },
                { op: "2>&", target: "1" },
            ]);
        });

        test("merged stdout+stderr redirect", () => {
            const node = parseBash("cmd &> all.log", new Map());
            const cmd = expectCommand(node, "cmd");
            expect(cmd.redirects).toEqual([{ op: "&>", target: "all.log" }]);
        });
    });

    describe("robustness", () => {
        test("leading and trailing whitespace are ignored", () => {
            const node = parseBash("  ls  ", new Map());
            expectCommand(node, "ls");
        });

        test("trailing semicolon produces no extra leaf", () => {
            const node = parseBash("a;", new Map());
            expectCommand(node, "a");
        });

        test("$VAR left as literal token by the parser", () => {
            const node = parseBash("git add $FOO", new Map());
            const cmd = expectCommand(node, "git");
            expect(cmd.options).toEqual({});
            expect(cmd.cmd).toEqual(["add", "$FOO"]);
        });

        test("* left as literal token with no glob expansion", () => {
            const node = parseBash("ls *", new Map());
            const cmd = expectCommand(node, "ls");
            expect(cmd.options).toEqual({});
            expect(cmd.cmd).toBe("*");
        });

        test("$(...) subshell captured as opaque binary token", () => {
            const node = parseBash("$(which sudo) -i", new Map());
            const cmd = expectCommand(node, "$(which sudo)");
            expect(cmd.options).toEqual({ i: true });
            expect(cmd.cmd).toEqual([]);
        });

        test("backtick subshell captured as opaque binary token", () => {
            const node = parseBash("`which sudo` -i", new Map());
            const cmd = expectCommand(node, "`which sudo`");
            expect(cmd.options).toEqual({ i: true });
            expect(cmd.cmd).toEqual([]);
        });

        test("$(...) containing pipe is opaque — inner | is not lexed as operator", () => {
            const node = parseBash("$(echo hello | head -1) arg", new Map());
            const cmd = expectCommand(node, "$(echo hello | head -1)");
            expect(cmd.options).toEqual({});
            expect(cmd.cmd).toBe("arg");
        });
    });

    describe("sub-command flag resolution", () => {
        test("sub-command flag with arity 1 consumes next token when cmds is defined", () => {
            const descriptors = makeDescriptorsWithCmds("git", [], { commit: ["m"] });
            const node = parseBash("git commit -m 'fix bug'", descriptors);
            const cmd = expectCommand(node, "git");
            expect(cmd.options).toEqual({ m: "fix bug" });
            expect(cmd.cmd).toBe("commit");
        });

        test("top-level flag still resolved when sub-command is present", () => {
            const descriptors = makeDescriptorsWithCmds("git", ["C"], { commit: ["m"] });
            const node = parseBash("git -C /some/path commit -m 'msg'", descriptors);
            const cmd = expectCommand(node, "git");
            expect(cmd.options).toEqual({ C: "/some/path", m: "msg" });
            expect(cmd.cmd).toBe("commit");
        });

        test("unrecognised sub-command leaves flags defaulting to arity 0", () => {
            const descriptors = makeDescriptorsWithCmds("git", [], { commit: ["m"] });
            const node = parseBash("git status -m value", descriptors);
            const cmd = expectCommand(node, "git");
            expect(cmd.options).toEqual({ m: true });
            expect(cmd.cmd).toEqual(["status", "value"]);
        });

        test("command with no cmds still parses flags from top-level descriptor", () => {
            const descriptors = makeDescriptors("grep", ["m"]);
            const node = parseBash("grep -m 5 pattern file.txt", descriptors);
            const cmd = expectCommand(node, "grep");
            expect(cmd.options).toEqual({ m: "5" });
            expect(cmd.cmd).toEqual(["pattern", "file.txt"]);
        });
    });

    describe("for-loop", () => {
        test("simple for-loop with single body command", () => {
            const node = parseBash("for x in a b c; do echo $x; done", new Map());
            expect(node.type).toBe("for_loop");
            const loop = node as IForLoop;
            expect(loop.variable).toBe("x");
            expect(loop.items).toEqual(["a", "b", "c"]);
            expect(loop.raw).toBe("for x in a b c; do echo $x; done");
            const body = loop.body as ICommand;
            expect(body.type).toBe("command");
            expect(body.binary).toBe("echo");
            expect(body.cmd).toBe("$x");
        });

        test("for-loop body with sequence is left-associative ; tree", () => {
            const node = parseBash("for x in a b; do echo $x; cat $x; done", new Map());
            const loop = node as IForLoop;
            expect(loop.items).toEqual(["a", "b"]);
            const body = loop.body as IBinOp;
            expect(body.type).toBe("binop");
            expect(body.op).toBe(";");
            expect((body.left as ICommand).binary).toBe("echo");
            expect((body.right as ICommand).binary).toBe("cat");
        });

        test("for-loop body with pipeline preserves pipe structure", () => {
            const node = parseBash("for x in a; do echo $x | grep a; done", new Map());
            const loop = node as IForLoop;
            const body = loop.body as IBinOp;
            expect(body.type).toBe("binop");
            expect(body.op).toBe("|");
            expect((body.left as ICommand).binary).toBe("echo");
            expect((body.right as ICommand).binary).toBe("grep");
        });

        test("for-loop with empty items list", () => {
            const node = parseBash("for x in; do echo $x; done", new Map());
            const loop = node as IForLoop;
            expect(loop.items).toEqual([]);
            expect(loop.variable).toBe("x");
        });

        test("2>&1 lexes as a single fd-merge redirect", () => {
            const node = parseBash("cmd 2>&1", new Map());
            const cmd = node as ICommand;
            expect(cmd.redirects).toEqual([{ op: "2>&", target: "1" }]);
        });
    });

    describe("if-statement", () => {
        test("simple if/then/fi without else", () => {
            const node = parseBash("if test -f a; then echo yes; fi", new Map());
            expect(node.type).toBe("if_statement");
            const ifNode = node as IIfStatement;
            expect((ifNode.condition as ICommand).binary).toBe("test");
            expect((ifNode.thenBranch as ICommand).binary).toBe("echo");
            expect(ifNode.elseBranch).toBeUndefined();
            expect(ifNode.raw).toBe("if test -f a; then echo yes; fi");
        });

        test("if/then/else/fi captures both branches", () => {
            const node = parseBash("if test -f a; then echo yes; else echo no; fi", new Map());
            const ifNode = node as IIfStatement;
            const thenBranch = ifNode.thenBranch as ICommand;
            const elseBranch = ifNode.elseBranch as ICommand;
            expect(thenBranch.binary).toBe("echo");
            expect(thenBranch.cmd).toBe("yes");
            expect(elseBranch.binary).toBe("echo");
            expect(elseBranch.cmd).toBe("no");
        });

        test("condition preserves a multi-command sequence", () => {
            const node = parseBash("if cd /tmp; ls; then echo ok; fi", new Map());
            const ifNode = node as IIfStatement;
            const condition = ifNode.condition as IBinOp;
            expect(condition.type).toBe("binop");
            expect(condition.op).toBe(";");
            expect((condition.left as ICommand).binary).toBe("cd");
            expect((condition.right as ICommand).binary).toBe("ls");
        });

        test("elif chain nests an if-statement in elseBranch", () => {
            const node = parseBash("if test a; then echo a; elif test b; then echo b; else echo c; fi", new Map());
            const ifNode = node as IIfStatement;
            expect((ifNode.thenBranch as ICommand).cmd).toBe("a");
            const elif = ifNode.elseBranch as IIfStatement;
            expect(elif.type).toBe("if_statement");
            expect((elif.condition as ICommand).binary).toBe("test");
            expect((elif.thenBranch as ICommand).cmd).toBe("b");
            expect((elif.elseBranch as ICommand).cmd).toBe("c");
        });

        test("then-branch preserves a pipeline", () => {
            const node = parseBash("if test a; then cat f | grep x; fi", new Map());
            const ifNode = node as IIfStatement;
            const thenBranch = ifNode.thenBranch as IBinOp;
            expect(thenBranch.type).toBe("binop");
            expect(thenBranch.op).toBe("|");
            expect((thenBranch.left as ICommand).binary).toBe("cat");
            expect((thenBranch.right as ICommand).binary).toBe("grep");
        });

        test("if-statement nested inside a for-loop body", () => {
            const node = parseBash("for f in a b; do if diff -q $f other >/dev/null 2>&1; then echo same; else echo diff; fi; done", new Map());
            expect(node.type).toBe("for_loop");
            const loop = node as IForLoop;
            expect(loop.items).toEqual(["a", "b"]);
            const ifNode = loop.body as IIfStatement;
            expect(ifNode.type).toBe("if_statement");
            const condition = ifNode.condition as ICommand;
            expect(condition.binary).toBe("diff");
            expect(condition.redirects).toEqual([
                { op: ">", target: "/dev/null" },
                { op: "2>&", target: "1" },
            ]);
            expect((ifNode.thenBranch as ICommand).cmd).toBe("same");
            expect((ifNode.elseBranch as ICommand).cmd).toBe("diff");
        });
    });
});
