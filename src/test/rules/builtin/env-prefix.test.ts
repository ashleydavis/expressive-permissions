import { envPrefixRule } from "../../../rules/builtin/env-prefix";
import { AstNode, Command, Environment } from "../../../types";

// makeEnv builds a minimal Environment.
function makeEnv(envVars: Record<string, string> = {}): Environment {
    return { cwd: "/start", cwdResolved: true, env: envVars };
}

// makeCommand builds a Command node with the given binary and envPrefix.
function makeCommand(binary: string, envPrefix: Record<string, string>): Command {
    return { type: "command", binary, options: {}, pos: [], envPrefix, redirects: [], raw: binary };
}

const dummyCall = { tool_name: "Bash", tool_input: { command: "" }, cwd: "/start" };

// ---------------------------------------------------------------------------
// Non-matching nodes
// ---------------------------------------------------------------------------

test("envPrefixRule: non-command node → abstain", () => {
    const node: AstNode = { type: "read", file_path: "/etc/hosts" };
    const result = envPrefixRule(node, makeEnv(), dummyCall);
    expect(result.decision.action).toBe("abstain");
    expect(result.scopedEnv).toBeUndefined();
});

test("envPrefixRule: command with empty binary → abstain", () => {
    const result = envPrefixRule(makeCommand("", { FOO: "bar" }), makeEnv(), dummyCall);
    expect(result.decision.action).toBe("abstain");
    expect(result.scopedEnv).toBeUndefined();
});

test("envPrefixRule: command with no envPrefix → abstain", () => {
    const result = envPrefixRule(makeCommand("npm", {}), makeEnv(), dummyCall);
    expect(result.decision.action).toBe("abstain");
    expect(result.scopedEnv).toBeUndefined();
});

// ---------------------------------------------------------------------------
// Matching nodes
// ---------------------------------------------------------------------------

test("envPrefixRule: decision is always abstain on match", () => {
    const result = envPrefixRule(makeCommand("npm", { FOO: "bar" }), makeEnv(), dummyCall);
    expect(result.decision.action).toBe("abstain");
});

test("envPrefixRule: returns scopedEnv with prefix var merged in", () => {
    const result = envPrefixRule(makeCommand("npm", { FOO: "bar" }), makeEnv(), dummyCall);
    expect(result.scopedEnv?.env.FOO).toBe("bar");
});

test("envPrefixRule: multiple prefix vars all appear in scopedEnv", () => {
    const result = envPrefixRule(makeCommand("cmd", { A: "1", B: "2" }), makeEnv(), dummyCall);
    expect(result.scopedEnv?.env.A).toBe("1");
    expect(result.scopedEnv?.env.B).toBe("2");
});

test("envPrefixRule: existing env vars are preserved in scopedEnv", () => {
    const result = envPrefixRule(makeCommand("cmd", { NEW: "val" }), makeEnv({ EXISTING: "keep" }), dummyCall);
    expect(result.scopedEnv?.env.EXISTING).toBe("keep");
    expect(result.scopedEnv?.env.NEW).toBe("val");
});

test("envPrefixRule: prefix var overrides existing var with same name in scopedEnv", () => {
    const result = envPrefixRule(makeCommand("cmd", { FOO: "new" }), makeEnv({ FOO: "old" }), dummyCall);
    expect(result.scopedEnv?.env.FOO).toBe("new");
});

test("envPrefixRule: does not return persistent env", () => {
    const result = envPrefixRule(makeCommand("npm", { FOO: "bar" }), makeEnv(), dummyCall);
    expect(result.env).toBeUndefined();
});

test("envPrefixRule: cwd is preserved in scopedEnv", () => {
    const env = { cwd: "/mydir", cwdResolved: true, env: {} };
    const result = envPrefixRule(makeCommand("npm", { FOO: "bar" }), env, dummyCall);
    expect(result.scopedEnv?.cwd).toBe("/mydir");
});
