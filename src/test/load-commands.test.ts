import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { loadCommandDescriptors, resolvePositionalKind, resolveFlagArity } from "../load-commands";
import { ICommandDescriptor } from "../types";

// makeTmpDir creates a temporary directory and returns its path.
function makeTmpDir(): string {
    return mkdtempSync(join(tmpdir(), "load-commands-test-"));
}

// makeCommandsDir creates .claude/permissions.d/commands/ inside the given root and returns the path.
function makeCommandsDir(root: string): string {
    const dir = join(root, ".claude", "permissions.d", "commands");
    mkdirSync(dir, { recursive: true });
    return dir;
}

// writeYaml writes a YAML string to a file in the given directory.
function writeYaml(dir: string, name: string, content: string): void {
    writeFileSync(join(dir, name), content, "utf-8");
}


// ---------------------------------------------------------------------------
// loadCommandDescriptors
// ---------------------------------------------------------------------------

test("returns empty map when neither home nor project commands directory exists", async () => {
    const projectDir = makeTmpDir();
    const homeDir = makeTmpDir();
    try {
        const result = await loadCommandDescriptors(homeDir, projectDir);
        expect(result.size).toBe(0);
    }
    finally {
        rmSync(projectDir, { recursive: true, force: true });
        rmSync(homeDir, { recursive: true, force: true });
    }
});

test("pipe-separated alias group expands so both short and long flag names resolve correctly", async () => {
    const projectDir = makeTmpDir();
    const homeDir = makeTmpDir();
    const commandsDir = makeCommandsDir(projectDir);
    writeYaml(commandsDir, "rm.yaml", `
rm:
  description: Remove files
  positionals:
    - kind: path
      description: Files to remove
      variadic: true
  flags:
    r|recursive:
      arity: 0
      kind: string
      description: Remove directories recursively
`);
    try {
        const result = await loadCommandDescriptors(homeDir, projectDir);
        const rm = result.get("rm") as ICommandDescriptor;
        expect(rm).toBeDefined();
        expect(resolveFlagArity(rm, "r")).toBe(0);
        expect(resolveFlagArity(rm, "recursive")).toBe(0);
    }
    finally {
        rmSync(projectDir, { recursive: true, force: true });
        rmSync(homeDir, { recursive: true, force: true });
    }
});

test("project-layer descriptor wins over global-user layer on the same flag", async () => {
    const projectDir = makeTmpDir();
    const homeDir = makeTmpDir();
    const homeCommandsDir = makeCommandsDir(homeDir);
    const projectCommandsDir = makeCommandsDir(projectDir);
    writeYaml(homeCommandsDir, "grep.yaml", `
grep:
  description: Search files
  flags:
    m|max-count:
      arity: 0
      kind: string
      description: Home version (arity 0)
`);
    writeYaml(projectCommandsDir, "grep.yaml", `
grep:
  description: Search files (project override)
  flags:
    m|max-count:
      arity: 1
      kind: string
      description: Project version (arity 1)
`);
    try {
        const result = await loadCommandDescriptors(homeDir, projectDir);
        const grep = result.get("grep") as ICommandDescriptor;
        expect(grep).toBeDefined();
        expect(resolveFlagArity(grep, "m")).toBe(1);
        expect(resolveFlagArity(grep, "max-count")).toBe(1);
    }
    finally {
        rmSync(projectDir, { recursive: true, force: true });
        rmSync(homeDir, { recursive: true, force: true });
    }
});

test("unknown command returns undefined from map (all flags resolve to arity 0 via EMPTY_DESCRIPTOR)", async () => {
    const projectDir = makeTmpDir();
    const homeDir = makeTmpDir();
    try {
        const result = await loadCommandDescriptors(homeDir, projectDir);
        expect(result.get("nonexistent-cmd")).toBeUndefined();
    }
    finally {
        rmSync(projectDir, { recursive: true, force: true });
        rmSync(homeDir, { recursive: true, force: true });
    }
});

test("description field is preserved on loaded descriptors for both command and flags", async () => {
    const projectDir = makeTmpDir();
    const homeDir = makeTmpDir();
    const commandsDir = makeCommandsDir(projectDir);
    writeYaml(commandsDir, "find.yaml", `
find:
  description: Search for files in a directory hierarchy
  positionals:
    - kind: path
      description: Directory to search
      variadic: true
  flags:
    name:
      arity: 1
      kind: string
      description: Match filename pattern
`);
    try {
        const result = await loadCommandDescriptors(homeDir, projectDir);
        const find = result.get("find") as ICommandDescriptor;
        expect(find).toBeDefined();
        expect(find.description).toBe("Search for files in a directory hierarchy");
        expect(find.flags["name"].description).toBe("Match filename pattern");
    }
    finally {
        rmSync(projectDir, { recursive: true, force: true });
        rmSync(homeDir, { recursive: true, force: true });
    }
});

test("variadic: true on the last positional is preserved correctly", async () => {
    const projectDir = makeTmpDir();
    const homeDir = makeTmpDir();
    const commandsDir = makeCommandsDir(projectDir);
    writeYaml(commandsDir, "cat.yaml", `
cat:
  description: Concatenate files
  positionals:
    - kind: path
      description: Files to concatenate
      variadic: true
  flags: {}
`);
    try {
        const result = await loadCommandDescriptors(homeDir, projectDir);
        const cat = result.get("cat") as ICommandDescriptor;
        expect(cat).toBeDefined();
        expect(cat.positionals.length).toBe(1);
        expect(cat.positionals[0].variadic).toBe(true);
        expect(cat.positionals[0].kind).toBe("path");
    }
    finally {
        rmSync(projectDir, { recursive: true, force: true });
        rmSync(homeDir, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// resolvePositionalKind
// ---------------------------------------------------------------------------

test("resolvePositionalKind returns string for unknown command (empty descriptor)", () => {
    const empty: ICommandDescriptor = { description: "", positionals: [], flags: {} };
    expect(resolvePositionalKind(empty, 0)).toBe("string");
    expect(resolvePositionalKind(empty, 5)).toBe("string");
});

test("resolvePositionalKind returns correct kind for a fixed-index positional", () => {
    const descriptor: ICommandDescriptor = {
        description: "",
        positionals: [
            { kind: "string", description: "pattern", variadic: false },
            { kind: "path", description: "file", variadic: false },
        ],
        flags: {},
    };
    expect(resolvePositionalKind(descriptor, 0)).toBe("string");
    expect(resolvePositionalKind(descriptor, 1)).toBe("path");
    expect(resolvePositionalKind(descriptor, 2)).toBe("string");
});

test("resolvePositionalKind extends variadic last positional to out-of-bounds indices", () => {
    const descriptor: ICommandDescriptor = {
        description: "",
        positionals: [
            { kind: "path", description: "files", variadic: true },
        ],
        flags: {},
    };
    expect(resolvePositionalKind(descriptor, 0)).toBe("path");
    expect(resolvePositionalKind(descriptor, 3)).toBe("path");
});

// ---------------------------------------------------------------------------
// resolveFlagArity
// ---------------------------------------------------------------------------

test("resolveFlagArity returns 0 for unknown flag (safe default)", () => {
    const descriptor: ICommandDescriptor = { description: "", positionals: [], flags: {} };
    expect(resolveFlagArity(descriptor, "unknown")).toBe(0);
});

test("resolveFlagArity returns declared arity for a known flag", () => {
    const descriptor: ICommandDescriptor = {
        description: "",
        positionals: [],
        flags: {
            "f|file": { arity: 1, kind: "path", description: "" },
            "v|verbose": { arity: 0, kind: "string", description: "" },
        },
    };
    expect(resolveFlagArity(descriptor, "f")).toBe(1);
    expect(resolveFlagArity(descriptor, "file")).toBe(1);
    expect(resolveFlagArity(descriptor, "v")).toBe(0);
    expect(resolveFlagArity(descriptor, "verbose")).toBe(0);
});
