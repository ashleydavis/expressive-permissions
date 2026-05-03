import { makeOptions, makeCommand, makeEnv, dummyCall } from "../../rules/test-helpers";

// ---------------------------------------------------------------------------
// makeOptions
// ---------------------------------------------------------------------------

test("makeOptions: returns the provided named options object unchanged", () => {
    const namedOptions = { verbose: true, output: "file.txt" };
    expect(makeOptions(namedOptions)).toEqual({ verbose: true, output: "file.txt" });
});

test("makeOptions: returns empty object when given empty object", () => {
    expect(makeOptions({})).toEqual({});
});

test("makeOptions: boolean false value is preserved", () => {
    expect(makeOptions({ dry: false })).toEqual({ dry: false });
});

// ---------------------------------------------------------------------------
// makeCommand
// ---------------------------------------------------------------------------

test("makeCommand: type is always command", () => {
    const cmd = makeCommand("ls", {}, [], {});
    expect(cmd.type).toBe("command");
});

test("makeCommand: binary is set correctly", () => {
    const cmd = makeCommand("git", {}, [], {});
    expect(cmd.binary).toBe("git");
});

test("makeCommand: options are set correctly", () => {
    const cmd = makeCommand("ls", { recursive: true }, [], {});
    expect(cmd.options).toEqual({ recursive: true });
});

test("makeCommand: cmd as array is set correctly", () => {
    const cmd = makeCommand("cd", {}, ["/home/user"], {});
    expect(cmd.cmd).toEqual(["/home/user"]);
});

test("makeCommand: cmd as string is set correctly", () => {
    const cmd = makeCommand("cd", {}, "/home/user", {});
    expect(cmd.cmd).toBe("/home/user");
});

test("makeCommand: envPrefix is set correctly", () => {
    const cmd = makeCommand("npm", {}, [], { NODE_ENV: "test" });
    expect(cmd.envPrefix).toEqual({ NODE_ENV: "test" });
});

test("makeCommand: redirects is always an empty array", () => {
    const cmd = makeCommand("ls", {}, [], {});
    expect(cmd.redirects).toEqual([]);
});

test("makeCommand: raw is binary and positionals joined", () => {
    const cmd = makeCommand("cd", {}, ["/etc"], {});
    expect(cmd.raw).toBe("cd /etc");
});

test("makeCommand: raw with multiple positionals joins them with spaces", () => {
    const cmd = makeCommand("cp", {}, ["src.txt", "dst.txt"], {});
    expect(cmd.raw).toBe("cp src.txt dst.txt");
});

test("makeCommand: raw with empty positionals is just the binary", () => {
    const cmd = makeCommand("ls", {}, [], {});
    expect(cmd.raw).toBe("ls");
});

test("makeCommand: raw with string cmd treats it as single positional", () => {
    const cmd = makeCommand("cd", {}, "/var/log", {});
    expect(cmd.raw).toBe("cd /var/log");
});

// ---------------------------------------------------------------------------
// makeEnv
// ---------------------------------------------------------------------------

test("makeEnv: cwd is set correctly", () => {
    const env = makeEnv("/home/user", true, {});
    expect(env.cwd).toBe("/home/user");
});

test("makeEnv: cwdResolved true is set correctly", () => {
    const env = makeEnv("/start", true, {});
    expect(env.cwdResolved).toBe(true);
});

test("makeEnv: cwdResolved false is set correctly", () => {
    const env = makeEnv("/start", false, {});
    expect(env.cwdResolved).toBe(false);
});

test("makeEnv: envVars are set correctly", () => {
    const env = makeEnv("/start", true, { FOO: "bar", BAZ: "qux" });
    expect(env.env).toEqual({ FOO: "bar", BAZ: "qux" });
});

test("makeEnv: empty envVars produces empty env record", () => {
    const env = makeEnv("/start", true, {});
    expect(env.env).toEqual({});
});

// ---------------------------------------------------------------------------
// dummyCall
// ---------------------------------------------------------------------------

test("dummyCall: is an object", () => {
    expect(typeof dummyCall).toBe("object");
});
