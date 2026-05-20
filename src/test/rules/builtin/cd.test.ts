import { cdRule } from "../../../rules/builtin/cd";
import { AstNode, ICommand, IEnvironment, ABSTAIN } from "../../../types";

// makeEnv builds a minimal Environment for cd rule tests.
function makeEnv(cwd: string, cwdResolved: boolean = true): IEnvironment {
    return { cwd, cwdResolved, env: {} };
}

// makeCommand builds a minimal Command node.
function makeCommand(binary: string, cmd: string | string[]): ICommand {
    return { type: "command", binary, options: {}, cmd, envPrefix: {}, redirects: [], raw: binary };
}

// dummyCall is a minimal ToolCall placeholder — cdRule ignores it.
const dummyCall = { tool_name: "Bash", tool_input: { command: "" }, cwd: "/start" };

// ---------------------------------------------------------------------------
// Non-matching nodes
// ---------------------------------------------------------------------------

test("cdRule: non-command node → abstain", () => {
    const node: AstNode = { type: "read", file_path: "/etc/hosts" };
    const result = cdRule(node, makeEnv("/start"), dummyCall);
    expect(result.decision.action).toBe("abstain");
    expect(result.env).toBeUndefined();
});

test("cdRule: command with different binary → abstain", () => {
    const result = cdRule(makeCommand("ls", []), makeEnv("/start"), dummyCall);
    expect(result.decision.action).toBe("abstain");
    expect(result.env).toBeUndefined();
});

// ---------------------------------------------------------------------------
// Decision is always abstain
// ---------------------------------------------------------------------------

test("cdRule: decision is always abstain even on a match", () => {
    const result = cdRule(makeCommand("cd", "/etc"), makeEnv("/start"), dummyCall);
    expect(result.decision.action).toBe("abstain");
});

// ---------------------------------------------------------------------------
// Resolvable targets
// ---------------------------------------------------------------------------

test("cdRule: absolute path sets cwd and cwdResolved true", () => {
    const result = cdRule(makeCommand("cd", "/etc"), makeEnv("/start"), dummyCall);
    expect(result.env?.cwd).toBe("/etc");
    expect(result.env?.cwdResolved).toBe(true);
});

test("cdRule: relative path resolved against env.cwd", () => {
    const result = cdRule(makeCommand("cd", "src"), makeEnv("/home/u"), dummyCall);
    expect(result.env?.cwd).toBe("/home/u/src");
    expect(result.env?.cwdResolved).toBe(true);
});

test("cdRule: parent directory resolved correctly", () => {
    const result = cdRule(makeCommand("cd", ".."), makeEnv("/home/u"), dummyCall);
    expect(result.env?.cwd).toBe("/home");
    expect(result.env?.cwdResolved).toBe(true);
});

test("cdRule: positional as array resolves from first element", () => {
    const result = cdRule(makeCommand("cd", ["/var/log"]), makeEnv("/start"), dummyCall);
    expect(result.env?.cwd).toBe("/var/log");
    expect(result.env?.cwdResolved).toBe(true);
});

test("cdRule: chained resolution — second cd resolves against first cd output", () => {
    const env1 = cdRule(makeCommand("cd", "a"), makeEnv("/orig"), dummyCall).env!;
    const env2 = cdRule(makeCommand("cd", "b"), env1, dummyCall).env!;
    expect(env2.cwd).toBe("/orig/a/b");
    expect(env2.cwdResolved).toBe(true);
});

// ---------------------------------------------------------------------------
// Unresolvable targets — cwdResolved false, cwd unchanged
// ---------------------------------------------------------------------------

test("cdRule: no-arg cd sets cwdResolved false", () => {
    const result = cdRule(makeCommand("cd", []), makeEnv("/start"), dummyCall);
    expect(result.env?.cwdResolved).toBe(false);
    expect(result.env?.cwd).toBe("/start");
});

test("cdRule: cd - sets cwdResolved false", () => {
    const result = cdRule(makeCommand("cd", "-"), makeEnv("/start"), dummyCall);
    expect(result.env?.cwdResolved).toBe(false);
    expect(result.env?.cwd).toBe("/start");
});

test("cdRule: unexpanded $VAR target sets cwdResolved false", () => {
    const result = cdRule(makeCommand("cd", "$HOME"), makeEnv("/start"), dummyCall);
    expect(result.env?.cwdResolved).toBe(false);
    expect(result.env?.cwd).toBe("/start");
});

test("cdRule: unexpanded ${VAR} target sets cwdResolved false", () => {
    const result = cdRule(makeCommand("cd", "${HOME}"), makeEnv("/start"), dummyCall);
    expect(result.env?.cwdResolved).toBe(false);
    expect(result.env?.cwd).toBe("/start");
});

// ---------------------------------------------------------------------------
// Env passthrough
// ---------------------------------------------------------------------------

test("cdRule: other env fields are preserved in returned env", () => {
    const env = { cwd: "/start", cwdResolved: true, env: { FOO: "bar" } };
    const result = cdRule(makeCommand("cd", "/etc"), env, dummyCall);
    expect(result.env?.env.FOO).toBe("bar");
});
