import { xargsRule } from "../../../rules/builtin/xargs";
import { AstNode, ICommand, IEnvironment, IXargsNode, ABSTAIN } from "../../../types";

// makeEnv builds a minimal IEnvironment for xargs rule tests.
function makeEnv(cwd: string = "/start"): IEnvironment {
    return { cwd, cwdResolved: true, env: {} };
}

// makeCommand builds a minimal ICommand node.
function makeCommand(binary: string): ICommand {
    return { type: "command", binary, options: {}, cmd: [], envPrefix: {}, raw: binary };
}

// makeXargsNode builds a minimal IXargsNode with the given child binary.
function makeXargsNode(childBinary: string): IXargsNode {
    return {
        type: "xargs",
        options: {},
        child: makeCommand(childBinary),
        raw: `xargs ${childBinary}`,
    };
}

// dummyCall is a minimal IToolCall placeholder -- xargsRule ignores it.
const dummyCall = { tool_name: "Bash", tool_input: { command: "" }, cwd: "/start" };

// ---------------------------------------------------------------------------
// Non-matching node types
// ---------------------------------------------------------------------------

test("xargsRule: read node returns abstain with no env", () => {
    const node: AstNode = { type: "read", file_path: "/etc/hosts" };
    const result = xargsRule(node, makeEnv(), dummyCall);
    expect(result.decision.action).toBe("abstain");
    expect(result.env).toBeUndefined();
});

test("xargsRule: bash node returns abstain with no env", () => {
    const node: AstNode = { type: "bash", ast: makeCommand("ls"), raw: "ls" };
    const result = xargsRule(node, makeEnv(), dummyCall);
    expect(result.decision.action).toBe("abstain");
    expect(result.env).toBeUndefined();
});

test("xargsRule: command node with different binary returns abstain with no env", () => {
    const result = xargsRule(makeCommand("grep"), makeEnv(), dummyCall);
    expect(result.decision.action).toBe("abstain");
    expect(result.env).toBeUndefined();
});

test("xargsRule: command node with xargs binary returns abstain (no env update)", () => {
    const result = xargsRule(makeCommand("xargs"), makeEnv(), dummyCall);
    expect(result.decision.action).toBe("abstain");
    expect(result.env).toBeUndefined();
});

// ---------------------------------------------------------------------------
// IXargsNode always abstains
// ---------------------------------------------------------------------------

test("xargsRule: xargs node with grep child returns abstain", () => {
    const result = xargsRule(makeXargsNode("grep"), makeEnv(), dummyCall);
    expect(result.decision.action).toBe("abstain");
    expect(result.env).toBeUndefined();
});

test("xargsRule: xargs node with rm child returns abstain", () => {
    const result = xargsRule(makeXargsNode("rm"), makeEnv(), dummyCall);
    expect(result.decision.action).toBe("abstain");
    expect(result.env).toBeUndefined();
});

test("xargsRule: xargs node with empty child binary returns abstain", () => {
    const result = xargsRule(makeXargsNode(""), makeEnv(), dummyCall);
    expect(result.decision.action).toBe("abstain");
    expect(result.env).toBeUndefined();
});

test("xargsRule: xargs node with options set still returns abstain", () => {
    const node: IXargsNode = {
        type: "xargs",
        options: { n: "1", I: "{}" },
        child: makeCommand("cp"),
        raw: "xargs -n 1 -I{} cp {} /dest",
    };
    const result = xargsRule(node, makeEnv(), dummyCall);
    expect(result.decision.action).toBe("abstain");
    expect(result.env).toBeUndefined();
});

test("xargsRule: always returns abstain regardless of child contents", () => {
    const outcomes = ["grep", "rm", "find", "cat", "echo"].map(
        (binary: string) => xargsRule(makeXargsNode(binary), makeEnv(), dummyCall)
    );
    for (const outcome of outcomes) {
        expect(outcome).toEqual(ABSTAIN);
    }
});
