import { exportRule } from "../../../rules/builtin/export";
import { makeOptions, makeCommand, makeEnv, dummyCall } from "../../../rules/test-helpers";
import { AstNode } from "../../../types";

// ---------------------------------------------------------------------------
// Non-matching nodes
// ---------------------------------------------------------------------------

test("exportRule: non-command node → abstain", () => {
    const node: AstNode = { type: "read", file_path: "/etc/hosts" };
    const result = exportRule(node, makeEnv("/start", true, {}), dummyCall);
    expect(result.decision.action).toBe("abstain");
    expect(result.env).toBeUndefined();
});

test("exportRule: non-export binary → abstain", () => {
    const result = exportRule(makeCommand("echo", makeOptions({}), ["FOO=bar"], {}), makeEnv("/start", true, {}), dummyCall);
    expect(result.decision.action).toBe("abstain");
    expect(result.env).toBeUndefined();
});

test("exportRule: export with no KEY=VALUE tokens → abstain", () => {
    const result = exportRule(makeCommand("export", makeOptions({}), [], {}), makeEnv("/start", true, {}), dummyCall);
    expect(result.decision.action).toBe("abstain");
    expect(result.env).toBeUndefined();
});

test("exportRule: export with bare name (no =) → abstain", () => {
    const result = exportRule(makeCommand("export", makeOptions({}), ["FOO"], {}), makeEnv("/start", true, {}), dummyCall);
    expect(result.decision.action).toBe("abstain");
    expect(result.env).toBeUndefined();
});

// ---------------------------------------------------------------------------
// Decision is always abstain
// ---------------------------------------------------------------------------

test("exportRule: decision is always abstain on match", () => {
    const result = exportRule(makeCommand("export", makeOptions({}), ["FOO=bar"], {}), makeEnv("/start", true, {}), dummyCall);
    expect(result.decision.action).toBe("abstain");
});

// ---------------------------------------------------------------------------
// Persistent env updates
// ---------------------------------------------------------------------------

test("exportRule: export FOO=bar sets env persistently", () => {
    const result = exportRule(makeCommand("export", makeOptions({}), ["FOO=bar"], {}), makeEnv("/start", true, {}), dummyCall);
    expect(result.env?.env.FOO).toBe("bar");
});

test("exportRule: multiple exports all appear in persistent env", () => {
    const result = exportRule(makeCommand("export", makeOptions({}), ["A=1", "B=2"], {}), makeEnv("/start", true, {}), dummyCall);
    expect(result.env?.env.A).toBe("1");
    expect(result.env?.env.B).toBe("2");
});

test("exportRule: existing env vars are preserved", () => {
    const result = exportRule(makeCommand("export", makeOptions({}), ["NEW=val"], {}), makeEnv("/start", true, { EXISTING: "keep" }), dummyCall);
    expect(result.env?.env.EXISTING).toBe("keep");
    expect(result.env?.env.NEW).toBe("val");
});

test("exportRule: exported var overrides existing var with same name", () => {
    const result = exportRule(makeCommand("export", makeOptions({}), ["FOO=new"], {}), makeEnv("/start", true, { FOO: "old" }), dummyCall);
    expect(result.env?.env.FOO).toBe("new");
});

test("exportRule: value containing = is captured correctly", () => {
    const result = exportRule(makeCommand("export", makeOptions({}), ["CONN=host=localhost"], {}), makeEnv("/start", true, {}), dummyCall);
    expect(result.env?.env.CONN).toBe("host=localhost");
});

test("exportRule: does not return scopedEnv", () => {
    const result = exportRule(makeCommand("export", makeOptions({}), ["FOO=bar"], {}), makeEnv("/start", true, {}), dummyCall);
    expect(result.scopedEnv).toBeUndefined();
});

test("exportRule: cwd is preserved in returned env", () => {
    const result = exportRule(makeCommand("export", makeOptions({}), ["FOO=bar"], {}), makeEnv("/mydir", true, {}), dummyCall);
    expect(result.env?.cwd).toBe("/mydir");
});
