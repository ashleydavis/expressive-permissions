import { envSetRule } from "../../../rules/builtin/env-set";
import { AstNode, Command, Environment } from "../../../types";

// makeEnv builds a minimal Environment.
function makeEnv(envVars: Record<string, string> = {}): Environment {
    return { cwd: "/start", cwdResolved: true, env: envVars };
}

// makeCommand builds a Command node with the given binary and envPrefix.
function makeCommand(binary: string, envPrefix: Record<string, string>): Command {
    return { type: "command", binary, args: {}, pos: [], envPrefix, redirects: [], raw: binary };
}

const dummyCall = { tool_name: "Bash", tool_input: { command: "" }, cwd: "/start" };

// ---------------------------------------------------------------------------
// Non-matching nodes
// ---------------------------------------------------------------------------

test("envSetRule: non-command node → abstain", () => {
    const node: AstNode = { type: "read", file_path: "/etc/hosts" };
    const result = envSetRule(node, makeEnv(), dummyCall);
    expect(result.decision.action).toBe("abstain");
    expect(result.env).toBeUndefined();
});

test("envSetRule: command with non-empty binary → abstain", () => {
    const result = envSetRule(makeCommand("npm", { FOO: "bar" }), makeEnv(), dummyCall);
    expect(result.decision.action).toBe("abstain");
    expect(result.env).toBeUndefined();
});

test("envSetRule: standalone with empty envPrefix → abstain", () => {
    const result = envSetRule(makeCommand("", {}), makeEnv(), dummyCall);
    expect(result.decision.action).toBe("abstain");
    expect(result.env).toBeUndefined();
});

// ---------------------------------------------------------------------------
// Matching nodes (binary === "" with envPrefix entries)
// ---------------------------------------------------------------------------

test("envSetRule: decision is always abstain on match", () => {
    const result = envSetRule(makeCommand("", { FOO: "bar" }), makeEnv(), dummyCall);
    expect(result.decision.action).toBe("abstain");
});

test("envSetRule: returns persistent env with var set", () => {
    const result = envSetRule(makeCommand("", { FOO: "bar" }), makeEnv(), dummyCall);
    expect(result.env?.env.FOO).toBe("bar");
});

test("envSetRule: multiple vars all appear in persistent env", () => {
    const result = envSetRule(makeCommand("", { A: "1", B: "2" }), makeEnv(), dummyCall);
    expect(result.env?.env.A).toBe("1");
    expect(result.env?.env.B).toBe("2");
});

test("envSetRule: existing env vars are preserved", () => {
    const result = envSetRule(makeCommand("", { NEW: "val" }), makeEnv({ EXISTING: "keep" }), dummyCall);
    expect(result.env?.env.EXISTING).toBe("keep");
    expect(result.env?.env.NEW).toBe("val");
});

test("envSetRule: new var overrides existing var with same name", () => {
    const result = envSetRule(makeCommand("", { FOO: "new" }), makeEnv({ FOO: "old" }), dummyCall);
    expect(result.env?.env.FOO).toBe("new");
});

test("envSetRule: does not return scopedEnv", () => {
    const result = envSetRule(makeCommand("", { FOO: "bar" }), makeEnv(), dummyCall);
    expect(result.scopedEnv).toBeUndefined();
});

test("envSetRule: cwd is preserved in returned env", () => {
    const env = { cwd: "/mydir", cwdResolved: true, env: {} };
    const result = envSetRule(makeCommand("", { FOO: "bar" }), env, dummyCall);
    expect(result.env?.cwd).toBe("/mydir");
});
