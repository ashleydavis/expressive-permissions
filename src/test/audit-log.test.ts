import { mkdtempSync, readFileSync, rmSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
    resolveLogBaseDir,
    resolveLogPath,
    cleanupOldMonths,
    FileAuditLogger,
    NullAuditLogger,
    toLocalISOString,
    IFinalDecisionEntry,
    IToolRequestEntry,
} from "../audit-log";

// makeDate builds a local-time Date from explicit year/month(1-based)/day/hour components.
function makeDate(year: number, month: number, day: number, hour: number): Date {
    return new Date(year, month - 1, day, hour, 0, 0, 0);
}

// makeTmpDir creates a temporary directory and returns its path.
function makeTmpDir(): string {
    return mkdtempSync(join(tmpdir(), "audit-log-test-"));
}

test("resolveLogBaseDir returns path with .claude/permissions-log suffix", () => {
    const result = resolveLogBaseDir("/home/user/project");
    expect(result).toBe("/home/user/project/.claude/permissions-log");
});

test("resolveLogPath returns correct YYYY-MM/DD/HH.log path for a known date", () => {
    const baseDir = "/some/base";
    const date = makeDate(2025, 11, 15, 9);
    const result = resolveLogPath(baseDir, date);
    expect(result).toBe("/some/base/2025-11/15/09.log");
});

test("resolveLogPath zero-pads month, day, and hour", () => {
    const baseDir = "/base";
    const date = makeDate(2025, 3, 5, 7);
    const result = resolveLogPath(baseDir, date);
    expect(result).toBe("/base/2025-03/05/07.log");
});

test("resolveLogPath uses local time fields", () => {
    // Construct a local-time Date so getFullYear/getMonth/getDate/getHours are known.
    const date = new Date(2025, 5, 1, 14, 0, 0, 0); // June 1, 2025 at 14:00 local
    const result = resolveLogPath("/base", date);
    expect(result).toBe("/base/2025-06/01/14.log");
});

test("cleanupOldMonths does nothing when base dir does not exist", () => {
    const nonExistentDir = "/tmp/does-not-exist-audit-log-test-xyz";
    expect(() => cleanupOldMonths(nonExistentDir, makeDate(2025, 6, 1, 0))).not.toThrow();
});

test("cleanupOldMonths does not remove current month directory", () => {
    const tmpDir = makeTmpDir();
    try {
        mkdirSync(join(tmpDir, "2025-06"), { recursive: true });
        cleanupOldMonths(tmpDir, makeDate(2025, 6, 15, 0));
        const remaining = require("fs").readdirSync(tmpDir);
        expect(remaining).toContain("2025-06");
    }
    finally {
        rmSync(tmpDir, { recursive: true, force: true });
    }
});

test("cleanupOldMonths does not remove directory exactly 2 months ago", () => {
    const tmpDir = makeTmpDir();
    try {
        mkdirSync(join(tmpDir, "2025-04"), { recursive: true });
        cleanupOldMonths(tmpDir, makeDate(2025, 6, 1, 0));
        const remaining = require("fs").readdirSync(tmpDir);
        expect(remaining).toContain("2025-04");
    }
    finally {
        rmSync(tmpDir, { recursive: true, force: true });
    }
});

test("cleanupOldMonths removes directory that is 3 months ago", () => {
    const tmpDir = makeTmpDir();
    try {
        mkdirSync(join(tmpDir, "2025-03"), { recursive: true });
        cleanupOldMonths(tmpDir, makeDate(2025, 6, 1, 0));
        const remaining = require("fs").readdirSync(tmpDir);
        expect(remaining).not.toContain("2025-03");
    }
    finally {
        rmSync(tmpDir, { recursive: true, force: true });
    }
});

test("cleanupOldMonths keeps multiple recent months and removes only the old one", () => {
    const tmpDir = makeTmpDir();
    try {
        mkdirSync(join(tmpDir, "2025-04"), { recursive: true });
        mkdirSync(join(tmpDir, "2025-05"), { recursive: true });
        mkdirSync(join(tmpDir, "2025-06"), { recursive: true });
        mkdirSync(join(tmpDir, "2025-03"), { recursive: true });
        cleanupOldMonths(tmpDir, makeDate(2025, 6, 1, 0));
        const remaining = require("fs").readdirSync(tmpDir);
        expect(remaining).toContain("2025-04");
        expect(remaining).toContain("2025-05");
        expect(remaining).toContain("2025-06");
        expect(remaining).not.toContain("2025-03");
    }
    finally {
        rmSync(tmpDir, { recursive: true, force: true });
    }
});

test("cleanupOldMonths ignores entries that do not match YYYY-MM pattern", () => {
    const tmpDir = makeTmpDir();
    try {
        mkdirSync(join(tmpDir, "not-a-month"), { recursive: true });
        mkdirSync(join(tmpDir, "2025-06"), { recursive: true });
        cleanupOldMonths(tmpDir, makeDate(2025, 6, 1, 0));
        const remaining = require("fs").readdirSync(tmpDir);
        expect(remaining).toContain("not-a-month");
        expect(remaining).toContain("2025-06");
    }
    finally {
        rmSync(tmpDir, { recursive: true, force: true });
    }
});

test("FileAuditLogger.log creates directory structure and writes a JSON line", () => {
    const tmpDir = makeTmpDir();
    try {
        const baseDir = join(tmpDir, "logs");
        const now = makeDate(2025, 6, 15, 10);
        const logger = new FileAuditLogger(baseDir, now);
        const entry: IFinalDecisionEntry = {
            type: "final_decision",
            timestamp: "2025-06-15T10:00:00.000Z",
            tool: "Bash",
            decision: "allow",
        };
        logger.log(entry);
        const logPath = join(baseDir, "2025-06", "15", "10.log");
        const contents = readFileSync(logPath, "utf-8");
        expect(contents.trim()).toBe(JSON.stringify(entry));
    }
    finally {
        rmSync(tmpDir, { recursive: true, force: true });
    }
});

test("FileAuditLogger.log appends a second entry on a new line without overwriting the first", () => {
    const tmpDir = makeTmpDir();
    try {
        const baseDir = join(tmpDir, "logs");
        const now = makeDate(2025, 6, 15, 10);
        const logger = new FileAuditLogger(baseDir, now);
        const entryA: IToolRequestEntry = {
            type: "tool_request",
            timestamp: "2025-06-15T10:00:00.000Z",
            tool: "Bash",
            input: { command: "ls" },
            cwd: "/home/user",
        };
        const entryB: IFinalDecisionEntry = {
            type: "final_decision",
            timestamp: "2025-06-15T10:00:00.001Z",
            tool: "Bash",
            decision: "allow",
        };
        logger.log(entryA);
        logger.log(entryB);
        const logPath = join(baseDir, "2025-06", "15", "10.log");
        const lines = readFileSync(logPath, "utf-8").split("\n").filter(Boolean);
        expect(lines).toHaveLength(2);
        expect(JSON.parse(lines[0])).toEqual(entryA);
        expect(JSON.parse(lines[1])).toEqual(entryB);
    }
    finally {
        rmSync(tmpDir, { recursive: true, force: true });
    }
});

test("NullAuditLogger.log does not throw and writes nothing", () => {
    const logger = new NullAuditLogger();
    const entry: IFinalDecisionEntry = {
        type: "final_decision",
        timestamp: "2025-06-15T10:00:00.000Z",
        tool: "Bash",
        decision: "deny",
    };
    expect(() => logger.log(entry)).not.toThrow();
});

// ---------------------------------------------------------------------------
// toLocalISOString
// ---------------------------------------------------------------------------

test("toLocalISOString matches ISO 8601 format with timezone offset", () => {
    const date = new Date(2025, 5, 15, 10, 23, 1, 500);
    const result = toLocalISOString(date);
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/);
});

test("toLocalISOString never ends with Z", () => {
    const result = toLocalISOString(new Date(2025, 5, 15, 10, 0, 0, 0));
    expect(result).not.toMatch(/Z$/);
});

test("toLocalISOString local date components match the input date", () => {
    const date = new Date(2025, 5, 15, 10, 23, 1, 500);
    const result = toLocalISOString(date);
    expect(result.startsWith("2025-06-15T10:23:01.500")).toBe(true);
});

test("toLocalISOString zero-pads single-digit month, day, hour, minute, second", () => {
    const date = new Date(2025, 0, 5, 9, 3, 7, 42);
    const result = toLocalISOString(date);
    expect(result.startsWith("2025-01-05T09:03:07.042")).toBe(true);
});

test("toLocalISOString offset matches the machine timezone offset", () => {
    const date = new Date(2025, 5, 15, 10, 0, 0, 0);
    const result = toLocalISOString(date);
    const offsetMinutes = -date.getTimezoneOffset();
    const sign = offsetMinutes >= 0 ? "+" : "-";
    const absOffset = Math.abs(offsetMinutes);
    const expectedOffset = `${sign}${String(Math.floor(absOffset / 60)).padStart(2, "0")}:${String(absOffset % 60).padStart(2, "0")}`;
    expect(result.endsWith(expectedOffset)).toBe(true);
});

test("toLocalISOString includes milliseconds", () => {
    const date = new Date(2025, 5, 15, 10, 0, 0, 123);
    const result = toLocalISOString(date);
    expect(result).toContain("T10:00:00.123");
});

test("toLocalISOString produces a string parseable as a Date with correct local time", () => {
    const original = new Date(2025, 5, 15, 10, 23, 1, 500);
    const result = toLocalISOString(original);
    const reparsed = new Date(result);
    expect(reparsed.getFullYear()).toBe(original.getFullYear());
    expect(reparsed.getMonth()).toBe(original.getMonth());
    expect(reparsed.getDate()).toBe(original.getDate());
    expect(reparsed.getHours()).toBe(original.getHours());
    expect(reparsed.getMinutes()).toBe(original.getMinutes());
    expect(reparsed.getSeconds()).toBe(original.getSeconds());
    expect(reparsed.getMilliseconds()).toBe(original.getMilliseconds());
});
