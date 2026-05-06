import { mkdtemp, readFile, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { resolveDebugLogPath, appendDebugBlock, logDebugError } from "../debug-log";

// tempDir creates a temporary directory and returns its path and a cleanup function.
async function tempDir(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
    const dir = await mkdtemp(join(tmpdir(), "debug-log-test-"));
    return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test("resolveDebugLogPath returns path under .claude/", () => {
    const result = resolveDebugLogPath("/some/project");
    expect(result).toBe("/some/project/.claude/permissions-debug.log");
});

test("resolveDebugLogPath uses the given projectDir", () => {
    const result = resolveDebugLogPath("/home/user/myproject");
    expect(result).toBe("/home/user/myproject/.claude/permissions-debug.log");
});

test("appendDebugBlock creates missing directories and writes a timestamped block", async () => {
    const { dir, cleanup } = await tempDir();
    try {
        const logPath = join(dir, "nested", "dir", "debug.log");
        await appendDebugBlock(logPath, "[TEST HEADER]", [
            { key: "strField", value: "hello" },
        ]);
        const content = await readFile(logPath, "utf8");
        expect(content).toMatch(/\[TEST HEADER\]/);
        expect(content).toContain("  strField: hello");
    }
    finally {
        await cleanup();
    }
});

test("appendDebugBlock prefixes only the header line with a timestamp", async () => {
    const { dir, cleanup } = await tempDir();
    try {
        const logPath = join(dir, "debug.log");
        await appendDebugBlock(logPath, "[HEADER]", [
            { key: "key1", value: "val1" },
            { key: "key2", value: "val2" },
        ]);
        const lines = (await readFile(logPath, "utf8")).split("\n").filter(line => line.length > 0);
        expect(lines[0]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2} \[HEADER\]$/);
        expect(lines[1]).toBe("  key1: val1");
        expect(lines[2]).toBe("  key2: val2");
    }
    finally {
        await cleanup();
    }
});

test("appendDebugBlock serializes object values with JSON indentation", async () => {
    const { dir, cleanup } = await tempDir();
    try {
        const logPath = join(dir, "debug.log");
        await appendDebugBlock(logPath, "[HEADER]", [
            { key: "obj", value: { a: 1, b: "two" } },
        ]);
        const content = await readFile(logPath, "utf8");
        expect(content).toContain("  obj: {");
        expect(content).toContain('    "a": 1');
        expect(content).toContain('    "b": "two"');
    }
    finally {
        await cleanup();
    }
});

test("appendDebugBlock appends multiple blocks to the same file", async () => {
    const { dir, cleanup } = await tempDir();
    try {
        const logPath = join(dir, "debug.log");
        await appendDebugBlock(logPath, "[BLOCK ONE]", [{ key: "x", value: "1" }]);
        await appendDebugBlock(logPath, "[BLOCK TWO]", [{ key: "y", value: "2" }]);
        const content = await readFile(logPath, "utf8");
        expect(content).toContain("[BLOCK ONE]");
        expect(content).toContain("[BLOCK TWO]");
    }
    finally {
        await cleanup();
    }
});

test("logDebugError writes to the log file and to stdout when path is provided", async () => {
    const { dir, cleanup } = await tempDir();
    const stdoutWrites: string[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: string) => {
        stdoutWrites.push(chunk);
        return true;
    };
    try {
        const logPath = join(dir, "debug.log");
        await logDebugError(logPath, new Error("something went wrong"));
        const content = await readFile(logPath, "utf8");
        expect(content).toContain("[ERROR]");
        expect(content).toContain("something went wrong");
        expect(stdoutWrites.join("")).toContain("[ERROR] Error: something went wrong");
    }
    finally {
        process.stdout.write = originalWrite;
        await cleanup();
    }
});

test("logDebugError writes only to stdout when path is undefined", async () => {
    const stdoutWrites: string[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: string) => {
        stdoutWrites.push(chunk);
        return true;
    };
    try {
        await logDebugError(undefined, new Error("no path error"));
        expect(stdoutWrites.join("")).toContain("[ERROR] Error: no path error");
    }
    finally {
        process.stdout.write = originalWrite;
    }
});
