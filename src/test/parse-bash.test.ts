import { parseBash } from "../parse-bash";
import { BashAstNode, Command, BinOp, ForLoop } from "../types";

// Asserts the node is a Command with the given binary and returns it for further inspection.
function expectCommand(node: BashAstNode, binary: string): Command {
    expect(node.type).toBe("command");
    const cmd = node as Command;
    expect(cmd.binary).toBe(binary);
    return cmd;
}

// Asserts the node is a BinOp with the given operator and returns it for further inspection.
function expectBinOp(node: BashAstNode, op: string): BinOp {
    expect(node.type).toBe("binop");
    const binop = node as BinOp;
    expect(binop.op).toBe(op);
    return binop;
}

describe("parseBash", () => {
    describe("single-command shapes", () => {
        test("bare binary", () => {
            const node = parseBash("ls");
            const cmd = expectCommand(node, "ls");
            expect(cmd.options).toEqual({});
            expect(cmd.cmd).toEqual([]);
        });

        test("positionals and flags", () => {
            const node = parseBash("ls -la /tmp");
            const cmd = expectCommand(node, "ls");
            expect(cmd.options).toEqual({ l: true, a: true });
            expect(cmd.cmd).toBe("/tmp");
        });

        test("long flag", () => {
            const node = parseBash("npm test --watch");
            const cmd = expectCommand(node, "npm");
            expect(cmd.options).toEqual({ watch: true });
            expect(cmd.cmd).toBe("test");
        });

        test("long flag with equals value", () => {
            const node = parseBash("npm test --reporter=spec");
            const cmd = expectCommand(node, "npm");
            expect(cmd.options).toEqual({ reporter: "spec" });
            expect(cmd.cmd).toBe("test");
        });

        test("long flag with space-separated value", () => {
            const node = parseBash("kubectl delete --context prod-cluster");
            const cmd = expectCommand(node, "kubectl");
            expect(cmd.options).toEqual({ context: "prod-cluster" });
            expect(cmd.cmd).toBe("delete");
        });

        test("long flag with equals value and space-separated value are equivalent", () => {
            const nodeEquals = parseBash("kubectl delete --context=prod-cluster");
            const cmdEquals = expectCommand(nodeEquals, "kubectl");
            const nodeSpace = parseBash("kubectl delete --context prod-cluster");
            const cmdSpace = expectCommand(nodeSpace, "kubectl");
            expect(cmdEquals.options).toEqual(cmdSpace.options);
            expect(cmdEquals.cmd).toEqual(cmdSpace.cmd);
        });

        test("long flag followed by another flag stays boolean", () => {
            const node = parseBash("npm test --watch --reporter=spec");
            const cmd = expectCommand(node, "npm");
            expect(cmd.options).toEqual({ watch: true, reporter: "spec" });
            expect(cmd.cmd).toBe("test");
        });

        test("short flag with equals value", () => {
            const node = parseBash("git commit -m=fix");
            const cmd = expectCommand(node, "git");
            expect(cmd.options).toEqual({ m: "fix" });
            expect(cmd.cmd).toBe("commit");
        });

        test("single-char short flag consumes following non-flag token as value", () => {
            const node = parseBash("git commit -m fix");
            const cmd = expectCommand(node, "git");
            expect(cmd.options).toEqual({ m: "fix" });
            expect(cmd.cmd).toBe("commit");
        });

        test("git -C consumes following path as its value, not as positional", () => {
            const node = parseBash("git -C /home/ash/tickets/arcktl-versions-6690/arkctl status -sb");
            const cmd = expectCommand(node, "git");
            expect(cmd.options).toEqual({ C: "/home/ash/tickets/arcktl-versions-6690/arkctl", s: true, b: true });
            expect(cmd.cmd).toBe("status");
        });

        test("double-quoted positional", () => {
            const node = parseBash('echo "hello world"');
            const cmd = expectCommand(node, "echo");
            expect(cmd.options).toEqual({});
            expect(cmd.cmd).toBe("hello world");
        });

        test("single-quoted flag value", () => {
            const node = parseBash("git commit -m='fix: bug'");
            const cmd = expectCommand(node, "git");
            expect(cmd.options).toEqual({ m: "fix: bug" });
            expect(cmd.cmd).toBe("commit");
        });

        test("escaped char becomes literal", () => {
            const node = parseBash("echo \\$HOME");
            const cmd = expectCommand(node, "echo");
            expect(cmd.options).toEqual({});
            expect(cmd.cmd).toBe("$HOME");
        });

        test("empty input returns empty command", () => {
            const node = parseBash("");
            const cmd = expectCommand(node, "");
            expect(cmd.options).toEqual({});
            expect(cmd.cmd).toEqual([]);
            expect(cmd.envPrefix).toEqual({});
            expect(cmd.redirects).toEqual([]);
            expect(cmd.raw).toBe("");
        });

        test("whitespace-only input returns empty command", () => {
            const node = parseBash("   ");
            const cmd = expectCommand(node, "");
            expect(cmd.raw).toBe("");
        });

        test("binary with path", () => {
            const node = parseBash("./scripts/run.sh");
            expectCommand(node, "./scripts/run.sh");
        });

        test("binary with hyphens", () => {
            const node = parseBash("my-tool");
            expectCommand(node, "my-tool");
        });

        test("binary with dots", () => {
            const node = parseBash("node.exe");
            expectCommand(node, "node.exe");
        });
    });

    describe("operators", () => {
        test("pipe: a | b", () => {
            const node = parseBash("a | b");
            const binop = expectBinOp(node, "|");
            expectCommand(binop.left, "a");
            expectCommand(binop.right, "b");
        });

        test("and: a && b", () => {
            const node = parseBash("a && b");
            const binop = expectBinOp(node, "&&");
            expectCommand(binop.left, "a");
            expectCommand(binop.right, "b");
        });

        test("or: a || b", () => {
            const node = parseBash("a || b");
            const binop = expectBinOp(node, "||");
            expectCommand(binop.left, "a");
            expectCommand(binop.right, "b");
        });

        test("sequence: a; b", () => {
            const node = parseBash("a; b");
            const binop = expectBinOp(node, ";");
            expectCommand(binop.left, "a");
            expectCommand(binop.right, "b");
        });

        test("chained pipes fold left: a | b | c", () => {
            const node = parseBash("a | b | c");
            const outerBinop = expectBinOp(node, "|");
            const innerBinop = expectBinOp(outerBinop.left, "|");
            expectCommand(innerBinop.left, "a");
            expectCommand(innerBinop.right, "b");
            expectCommand(outerBinop.right, "c");
        });

        test("chained ands fold left: a && b && c", () => {
            const node = parseBash("a && b && c");
            const outerBinop = expectBinOp(node, "&&");
            const innerBinop = expectBinOp(outerBinop.left, "&&");
            expectCommand(innerBinop.left, "a");
            expectCommand(innerBinop.right, "b");
            expectCommand(outerBinop.right, "c");
        });

        test("mixed: a && b || c — || binds tighter per grammar", () => {
            // Grammar: parseAnd calls parseOr for each operand, so a && b || c → a && (b || c)
            const node = parseBash("a && b || c");
            const andBinop = expectBinOp(node, "&&");
            expectCommand(andBinop.left, "a");
            const orBinop = expectBinOp(andBinop.right, "||");
            expectCommand(orBinop.left, "b");
            expectCommand(orBinop.right, "c");
        });

        test("mixed: a; b && c | d", () => {
            const node = parseBash("a; b && c | d");
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
            const node = parseBash("FOO=bar cmd");
            const cmd = expectCommand(node, "cmd");
            expect(cmd.envPrefix).toEqual({ FOO: "bar" });
            expect(cmd.options).toEqual({});
            expect(cmd.cmd).toEqual([]);
        });

        test("multiple prefixes", () => {
            const node = parseBash("A=1 B=2 cmd");
            const cmd = expectCommand(node, "cmd");
            expect(cmd.envPrefix).toEqual({ A: "1", B: "2" });
        });

        test("quoted value in prefix", () => {
            const node = parseBash('FOO="hello world" cmd');
            const cmd = expectCommand(node, "cmd");
            expect(cmd.envPrefix).toEqual({ FOO: "hello world" });
        });

        test("env-only segment (no binary) yields empty binary", () => {
            const node = parseBash("FOO=bar");
            const cmd = expectCommand(node, "");
            expect(cmd.envPrefix).toEqual({ FOO: "bar" });
        });
    });

    describe("redirects", () => {
        test("stdout redirect", () => {
            const node = parseBash("cmd > out.log");
            const cmd = expectCommand(node, "cmd");
            expect(cmd.redirects).toEqual([{ op: ">", target: "out.log" }]);
        });

        test("stdout append redirect", () => {
            const node = parseBash("cmd >> out.log");
            const cmd = expectCommand(node, "cmd");
            expect(cmd.redirects).toEqual([{ op: ">>", target: "out.log" }]);
        });

        test("stdin redirect", () => {
            const node = parseBash("cmd < in.txt");
            const cmd = expectCommand(node, "cmd");
            expect(cmd.redirects).toEqual([{ op: "<", target: "in.txt" }]);
        });

        test("stderr redirect", () => {
            const node = parseBash("cmd 2> err.log");
            const cmd = expectCommand(node, "cmd");
            expect(cmd.redirects).toEqual([{ op: "2>", target: "err.log" }]);
        });

        test("stdout redirect with stderr merged to stdout", () => {
            const node = parseBash("cmd > out 2>&1");
            const cmd = expectCommand(node, "cmd");
            expect(cmd.redirects).toEqual([
                { op: ">", target: "out" },
                { op: "2>&", target: "1" },
            ]);
        });

        test("merged stdout+stderr redirect", () => {
            const node = parseBash("cmd &> all.log");
            const cmd = expectCommand(node, "cmd");
            expect(cmd.redirects).toEqual([{ op: "&>", target: "all.log" }]);
        });
    });

    describe("robustness", () => {
        test("leading and trailing whitespace are ignored", () => {
            const node = parseBash("  ls  ");
            expectCommand(node, "ls");
        });

        test("trailing semicolon produces no extra leaf", () => {
            const node = parseBash("a;");
            expectCommand(node, "a");
        });

        test("$VAR left as literal token by the parser", () => {
            const node = parseBash("git add $FOO");
            const cmd = expectCommand(node, "git");
            expect(cmd.options).toEqual({});
            expect(cmd.cmd).toEqual(["add", "$FOO"]);
        });

        test("* left as literal token with no glob expansion", () => {
            const node = parseBash("ls *");
            const cmd = expectCommand(node, "ls");
            expect(cmd.options).toEqual({});
            expect(cmd.cmd).toBe("*");
        });

        test("$(...) subshell captured as opaque binary token", () => {
            const node = parseBash("$(which sudo) -i");
            const cmd = expectCommand(node, "$(which sudo)");
            expect(cmd.options).toEqual({ i: true });
            expect(cmd.cmd).toEqual([]);
        });

        test("backtick subshell captured as opaque binary token", () => {
            const node = parseBash("`which sudo` -i");
            const cmd = expectCommand(node, "`which sudo`");
            expect(cmd.options).toEqual({ i: true });
            expect(cmd.cmd).toEqual([]);
        });

        test("$(...) containing pipe is opaque — inner | is not lexed as operator", () => {
            const node = parseBash("$(echo hello | head -1) arg");
            const cmd = expectCommand(node, "$(echo hello | head -1)");
            expect(cmd.options).toEqual({});
            expect(cmd.cmd).toBe("arg");
        });
    });

    describe("for-loop", () => {
        test("simple for-loop with single body command", () => {
            const node = parseBash("for x in a b c; do echo $x; done");
            expect(node.type).toBe("for_loop");
            const loop = node as ForLoop;
            expect(loop.variable).toBe("x");
            expect(loop.items).toEqual(["a", "b", "c"]);
            expect(loop.raw).toBe("for x in a b c; do echo $x; done");
            const body = loop.body as Command;
            expect(body.type).toBe("command");
            expect(body.binary).toBe("echo");
            expect(body.cmd).toBe("$x");
        });

        test("for-loop body with sequence is left-associative ; tree", () => {
            const node = parseBash("for x in a b; do echo $x; cat $x; done");
            const loop = node as ForLoop;
            expect(loop.items).toEqual(["a", "b"]);
            const body = loop.body as BinOp;
            expect(body.type).toBe("binop");
            expect(body.op).toBe(";");
            expect((body.left as Command).binary).toBe("echo");
            expect((body.right as Command).binary).toBe("cat");
        });

        test("for-loop body with pipeline preserves pipe structure", () => {
            const node = parseBash("for x in a; do echo $x | grep a; done");
            const loop = node as ForLoop;
            const body = loop.body as BinOp;
            expect(body.type).toBe("binop");
            expect(body.op).toBe("|");
            expect((body.left as Command).binary).toBe("echo");
            expect((body.right as Command).binary).toBe("grep");
        });

        test("for-loop with empty items list", () => {
            const node = parseBash("for x in; do echo $x; done");
            const loop = node as ForLoop;
            expect(loop.items).toEqual([]);
            expect(loop.variable).toBe("x");
        });

        test("2>&1 lexes as a single fd-merge redirect", () => {
            const node = parseBash("cmd 2>&1");
            const cmd = node as Command;
            expect(cmd.redirects).toEqual([{ op: "2>&", target: "1" }]);
        });
    });
});
