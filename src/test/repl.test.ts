import { parseReplCommand } from "../repl";

// ---------------------------------------------------------------------------
// parseReplCommand
// ---------------------------------------------------------------------------

test("parseReplCommand returns empty for blank line", () => {
    const command = parseReplCommand("");
    expect(command.kind).toBe("empty");
});

test("parseReplCommand returns empty for whitespace-only line", () => {
    const command = parseReplCommand("   \t  ");
    expect(command.kind).toBe("empty");
});

test("parseReplCommand recognises :quit", () => {
    const command = parseReplCommand(":quit");
    expect(command.kind).toBe("quit");
});

test("parseReplCommand recognises :q alias for quit", () => {
    const command = parseReplCommand(":q");
    expect(command.kind).toBe("quit");
});

test("parseReplCommand recognises :cwd with a path", () => {
    const command = parseReplCommand(":cwd /home/ash/project");
    expect(command.kind).toBe("set-cwd");
    if (command.kind === "set-cwd") {
        expect(command.path).toBe("/home/ash/project");
    }
});

test("parseReplCommand trims surrounding whitespace from :cwd path", () => {
    const command = parseReplCommand("   :cwd   /tmp/foo   ");
    expect(command.kind).toBe("set-cwd");
    if (command.kind === "set-cwd") {
        expect(command.path).toBe("/tmp/foo");
    }
});

test("parseReplCommand recognises :project with a path", () => {
    const command = parseReplCommand(":project /home/ash/tickets/prod-cfg-7643");
    expect(command.kind).toBe("set-project");
    if (command.kind === "set-project") {
        expect(command.path).toBe("/home/ash/tickets/prod-cfg-7643");
    }
});

test("parseReplCommand recognises :proj as alias for :project", () => {
    const command = parseReplCommand(":proj /home/ash/projects/foo");
    expect(command.kind).toBe("set-project");
    if (command.kind === "set-project") {
        expect(command.path).toBe("/home/ash/projects/foo");
    }
});

test("parseReplCommand treats unknown :foo as analyze input", () => {
    const command = parseReplCommand(":foo bar");
    expect(command.kind).toBe("analyze");
    if (command.kind === "analyze") {
        expect(command.input).toBe(":foo bar");
    }
});

test("parseReplCommand treats bare Bash command as analyze input", () => {
    const command = parseReplCommand("git status");
    expect(command.kind).toBe("analyze");
    if (command.kind === "analyze") {
        expect(command.input).toBe("git status");
    }
});

test("parseReplCommand preserves analyze input through whitespace trim", () => {
    const command = parseReplCommand("   ls -la /tmp   ");
    expect(command.kind).toBe("analyze");
    if (command.kind === "analyze") {
        expect(command.input).toBe("ls -la /tmp");
    }
});

test("parseReplCommand treats :cwd without a path as analyze input", () => {
    const command = parseReplCommand(":cwd");
    expect(command.kind).toBe("analyze");
    if (command.kind === "analyze") {
        expect(command.input).toBe(":cwd");
    }
});

test("parseReplCommand treats :project without a path as analyze input", () => {
    const command = parseReplCommand(":project");
    expect(command.kind).toBe("analyze");
    if (command.kind === "analyze") {
        expect(command.input).toBe(":project");
    }
});
