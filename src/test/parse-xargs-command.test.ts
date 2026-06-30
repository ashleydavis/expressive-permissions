import { parseXargsCommand } from "../build-ast";
import { findInnerCommand } from "../types";

// ---------------------------------------------------------------------------
// No subcommand
// ---------------------------------------------------------------------------

test("bare xargs: empty options and empty child binary", () => {
    const result = parseXargsCommand("xargs", new Map());
    expect(result.options).toEqual({});
    expect(findInnerCommand(result.child).binary).toBe("");
});

// ---------------------------------------------------------------------------
// Short value flags (consume next token as value)
// ---------------------------------------------------------------------------

test("-n 1: options.n === '1', child is the subcommand", () => {
    const result = parseXargsCommand("xargs -n 1 rm", new Map());
    expect(result.options["n"]).toBe("1");
    expect(findInnerCommand(result.child).binary).toBe("rm");
});

test("-P 4: options.P === '4'", () => {
    const result = parseXargsCommand("xargs -P 4 grep", new Map());
    expect(result.options["P"]).toBe("4");
    expect(findInnerCommand(result.child).binary).toBe("grep");
});

test("-I{} (value attached): options.I === '{}'", () => {
    const result = parseXargsCommand("xargs -I{} cp {} /dest", new Map());
    expect(result.options["I"]).toBe("{}");
    expect(findInnerCommand(result.child).binary).toBe("cp");
});

test("-I {} (value separate): options.I === '{}'", () => {
    const result = parseXargsCommand("xargs -I {} cp {} /dest", new Map());
    expect(result.options["I"]).toBe("{}");
    expect(findInnerCommand(result.child).binary).toBe("cp");
});

test("-n1 (value attached, no space): options.n === '1'", () => {
    const result = parseXargsCommand("xargs -n1 echo", new Map());
    expect(result.options["n"]).toBe("1");
    expect(findInnerCommand(result.child).binary).toBe("echo");
});

// ---------------------------------------------------------------------------
// Short boolean flags
// ---------------------------------------------------------------------------

test("-0: boolean flag options['0'] === true", () => {
    const result = parseXargsCommand("xargs -0 rm", new Map());
    expect(result.options["0"]).toBe(true);
    expect(findInnerCommand(result.child).binary).toBe("rm");
});

test("-0t: bundled boolean flags both set to true", () => {
    const result = parseXargsCommand("xargs -0t grep", new Map());
    expect(result.options["0"]).toBe(true);
    expect(result.options["t"]).toBe(true);
    expect(findInnerCommand(result.child).binary).toBe("grep");
});

// ---------------------------------------------------------------------------
// Long value flags (consume next token as value)
// ---------------------------------------------------------------------------

test("--max-args 5: options['max-args'] === '5'", () => {
    const result = parseXargsCommand("xargs --max-args 5 echo", new Map());
    expect(result.options["max-args"]).toBe("5");
    expect(findInnerCommand(result.child).binary).toBe("echo");
});

test("--replace={}: options['replace'] === '{}'", () => {
    const result = parseXargsCommand("xargs --replace={} cp {} /dest", new Map());
    expect(result.options["replace"]).toBe("{}");
    expect(findInnerCommand(result.child).binary).toBe("cp");
});

// ---------------------------------------------------------------------------
// Long boolean flags (no value)
// ---------------------------------------------------------------------------

test("--no-run-if-empty: options['no-run-if-empty'] === true", () => {
    const result = parseXargsCommand("xargs --no-run-if-empty rm", new Map());
    expect(result.options["no-run-if-empty"]).toBe(true);
    expect(findInnerCommand(result.child).binary).toBe("rm");
});

test("--verbose: options['verbose'] === true", () => {
    const result = parseXargsCommand("xargs --verbose grep", new Map());
    expect(result.options["verbose"]).toBe(true);
    expect(findInnerCommand(result.child).binary).toBe("grep");
});

// ---------------------------------------------------------------------------
// Long flag with embedded = value
// ---------------------------------------------------------------------------

test("--delimiter=,: options['delimiter'] === ','", () => {
    const result = parseXargsCommand("xargs --delimiter=, echo", new Map());
    expect(result.options["delimiter"]).toBe(",");
    expect(findInnerCommand(result.child).binary).toBe("echo");
});

// ---------------------------------------------------------------------------
// -- separator
// ---------------------------------------------------------------------------

test("-- stops option parsing: token after -- is subcommand", () => {
    const result = parseXargsCommand("xargs -- grep", new Map());
    expect(findInnerCommand(result.child).binary).toBe("grep");
    expect(Object.keys(result.options).length).toBe(0);
});

test("-n 1 -- grep: options parsed before --, child is grep", () => {
    const result = parseXargsCommand("xargs -n 1 -- grep", new Map());
    expect(result.options["n"]).toBe("1");
    expect(findInnerCommand(result.child).binary).toBe("grep");
});

// ---------------------------------------------------------------------------
// Redirect skipping before subcommand
// ---------------------------------------------------------------------------

test("xargs 2>/dev/null grep: redirect before subcmd is skipped, child is grep", () => {
    const result = parseXargsCommand("xargs 2>/dev/null grep", new Map());
    expect(findInnerCommand(result.child).binary).toBe("grep");
});

// ---------------------------------------------------------------------------
// Subcommand with options preserved
// ---------------------------------------------------------------------------

test("xargs grep -l pattern: child has options.l and correct binary", () => {
    const result = parseXargsCommand('xargs grep -l "pattern"', new Map());
    expect(findInnerCommand(result.child).binary).toBe("grep");
    expect(findInnerCommand(result.child).options["l"]).toBeDefined();
});

test("xargs rm -rf: child binary is rm with options r and f", () => {
    const result = parseXargsCommand("xargs rm -rf", new Map());
    expect(findInnerCommand(result.child).binary).toBe("rm");
    expect(findInnerCommand(result.child).options["r"]).toBe(true);
    expect(findInnerCommand(result.child).options["f"]).toBe(true);
});

// ---------------------------------------------------------------------------
// Multiple xargs options combined
// ---------------------------------------------------------------------------

test("-n 1 -P 4 grep: both options parsed, child is grep", () => {
    const result = parseXargsCommand("xargs -n 1 -P 4 grep", new Map());
    expect(result.options["n"]).toBe("1");
    expect(result.options["P"]).toBe("4");
    expect(findInnerCommand(result.child).binary).toBe("grep");
});
