import { mkdtempSync, rmSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { spawnSync, SpawnSyncReturns } from "child_process";
import { resolveJsonLogPath, resolveLogBaseDir } from "../audit-log";
import { IToolExecutionEntry } from "../audit-log";

// makeTmpDir creates a temporary directory and returns its path.
function makeTmpDir(): string {
    return mkdtempSync(join(tmpdir(), "post-hook-test-"));
}

// makePostStdin builds a JSON string matching IPostToolUseCall for a given scenario.
function makePostStdin(overrides: Record<string, unknown>): string {
    const base = {
        tool_name: "Bash",
        tool_input: { command: "ls" },
        tool_response: { output: "file.txt", isError: false },
        cwd: "/home/user/project",
    };
    return JSON.stringify({ ...base, ...overrides });
}

// spawnPostHook spawns post-hook.ts via bun with the given stdin and env, returning the result.
function spawnPostHook(stdinData: string, env: Record<string, string>): SpawnSyncReturns<string> {
    const postHookPath = join(__dirname, "..", "post-hook.ts");
    return spawnSync("bun", [postHookPath], {
        input: stdinData,
        env,
        encoding: "utf-8",
    });
}

// buildEnv returns a test environment with CLAUDE_PROJECT_DIR set to projectDir.
function buildEnv(projectDir: string): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
        if (key !== "NODE_ENV" && value !== undefined) {
            env[key] = value;
        }
    }
    env["CLAUDE_PROJECT_DIR"] = projectDir;
    return env;
}

test("runPostHook logs a tool_execution entry with correct fields for a Bash call", () => {
    const tmpDir = makeTmpDir();
    try {
        const stdinData = makePostStdin({});
        const result = spawnPostHook(stdinData, buildEnv(tmpDir));
        expect(result.status).toBe(0);
        const logBaseDir = resolveLogBaseDir(tmpDir);
        const logFile = resolveJsonLogPath(logBaseDir, new Date());
        const lines = readFileSync(logFile, "utf-8").split("\n").filter(Boolean);
        expect(lines).toHaveLength(1);
        const entry = JSON.parse(lines[0]) as IToolExecutionEntry;
        expect(entry.type).toBe("tool_execution");
        expect(entry.tool).toBe("Bash");
        expect(entry.isError).toBe(false);
        expect(entry.cwd).toBe("/home/user/project");
    }
    finally {
        rmSync(tmpDir, { recursive: true, force: true });
    }
});

test("runPostHook extracts isError true from tool_response", () => {
    const tmpDir = makeTmpDir();
    try {
        const stdinData = makePostStdin({
            tool_response: { output: "", isError: true },
        });
        const result = spawnPostHook(stdinData, buildEnv(tmpDir));
        expect(result.status).toBe(0);
        const logBaseDir = resolveLogBaseDir(tmpDir);
        const logFile = resolveJsonLogPath(logBaseDir, new Date());
        const lines = readFileSync(logFile, "utf-8").split("\n").filter(Boolean);
        expect(lines).toHaveLength(1);
        const entry = JSON.parse(lines[0]) as IToolExecutionEntry;
        expect(entry.isError).toBe(true);
    }
    finally {
        rmSync(tmpDir, { recursive: true, force: true });
    }
});

test("runPostHook exits 1 when CLAUDE_PROJECT_DIR is absent", () => {
    const stdinData = makePostStdin({});
    const envWithoutProjectDir: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
        if (key !== "NODE_ENV" && key !== "CLAUDE_PROJECT_DIR" && value !== undefined) {
            envWithoutProjectDir[key] = value;
        }
    }
    const result = spawnPostHook(stdinData, envWithoutProjectDir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("CLAUDE_PROJECT_DIR is not set");
});
