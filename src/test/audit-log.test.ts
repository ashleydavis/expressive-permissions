import { mkdtempSync, readFileSync, rmSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
    resolveLogBaseDir,
    resolveJsonLogPath,
    resolveTextLogPath,
    formatTextEntry,
    cleanupOldMonths,
    FileAuditLogger,
    NullAuditLogger,
    CapturingAuditLogger,
    toLocalISOString,
    IFinalDecisionEntry,
    IToolRequestEntry,
    IRuleMatchEntry,
    INoRuleMatchEntry,
    IAggregationEntry,
    IToolExecutionEntry,
    IConfigLoadEntry,
    IAuditLogEntry,
    IAuditLogger,
    logConfigLoad,
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

test("resolveJsonLogPath returns correct YYYY-MM/DD/HH.json path for a known date", () => {
    const baseDir = "/some/base";
    const date = makeDate(2025, 11, 15, 9);
    const result = resolveJsonLogPath(baseDir, date);
    expect(result).toBe("/some/base/2025-11/15/09.json");
});

test("resolveJsonLogPath zero-pads month, day, and hour", () => {
    const baseDir = "/base";
    const date = makeDate(2025, 3, 5, 7);
    const result = resolveJsonLogPath(baseDir, date);
    expect(result).toBe("/base/2025-03/05/07.json");
});

test("resolveJsonLogPath uses local time fields", () => {
    const date = new Date(2025, 5, 1, 14, 0, 0, 0);
    const result = resolveJsonLogPath("/base", date);
    expect(result).toBe("/base/2025-06/01/14.json");
});

test("resolveTextLogPath returns correct YYYY-MM/DD/HH.log path for a known date", () => {
    const date = makeDate(2025, 11, 15, 9);
    const result = resolveTextLogPath("/some/base", date);
    expect(result).toBe("/some/base/2025-11/15/09.log");
});

test("resolveTextLogPath uses same directory as resolveJsonLogPath", () => {
    const date = makeDate(2025, 6, 15, 10);
    const jsonPath = resolveJsonLogPath("/base", date);
    const textPath = resolveTextLogPath("/base", date);
    expect(jsonPath.replace(/\.json$/, "")).toBe(textPath.replace(/\.log$/, ""));
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

test("FileAuditLogger.log creates directory structure and writes a JSON line to .json file", () => {
    const tmpDir = makeTmpDir();
    try {
        const baseDir = join(tmpDir, "logs");
        const now = makeDate(2025, 6, 15, 10);
        const logger = new FileAuditLogger(baseDir, now);
        const entry: IFinalDecisionEntry = {
            type: "final_decision",
            timestamp: "2025-06-15T10:00:00.000+10:00",
            tool: "Bash",
            decision: "allow",
        };
        logger.log(entry);
        const jsonPath = join(baseDir, "2025-06", "15", "10.json");
        const contents = readFileSync(jsonPath, "utf-8");
        expect(contents.trim()).toBe(JSON.stringify(entry));
    }
    finally {
        rmSync(tmpDir, { recursive: true, force: true });
    }
});

test("FileAuditLogger.log writes a human-readable line to .log file", () => {
    const tmpDir = makeTmpDir();
    try {
        const baseDir = join(tmpDir, "logs");
        const now = makeDate(2025, 6, 15, 10);
        const logger = new FileAuditLogger(baseDir, now);
        const entry: IFinalDecisionEntry = {
            type: "final_decision",
            timestamp: "2025-06-15T10:23:01.000+10:00",
            tool: "Bash",
            decision: "allow",
        };
        logger.log(entry);
        const textPath = join(baseDir, "2025-06", "15", "10.log");
        const contents = readFileSync(textPath, "utf-8");
        expect(contents.trim()).toBe(formatTextEntry(entry));
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
            timestamp: "2025-06-15T10:00:00.000+10:00",
            tool: "Bash",
            input: { command: "ls" },
            cwd: "/home/user",
        };
        const entryB: IFinalDecisionEntry = {
            type: "final_decision",
            timestamp: "2025-06-15T10:00:00.001+10:00",
            tool: "Bash",
            decision: "allow",
        };
        logger.log(entryA);
        logger.log(entryB);
        const jsonPath = join(baseDir, "2025-06", "15", "10.json");
        const lines = readFileSync(jsonPath, "utf-8").split("\n").filter(Boolean);
        expect(lines).toHaveLength(2);
        expect(JSON.parse(lines[0])).toEqual(entryA);
        expect(JSON.parse(lines[1])).toEqual(entryB);
    }
    finally {
        rmSync(tmpDir, { recursive: true, force: true });
    }
});

// RecordingLogger captures every audit entry passed to it. Used in unit tests in place of a
// real FileAuditLogger so we can inspect the payload directly.
class RecordingLogger implements IAuditLogger {
    // The list of entries received in the order they were logged.
    public readonly entries: IAuditLogEntry[] = [];

    log(entry: IAuditLogEntry): void {
        this.entries.push(entry);
    }
}

test("logConfigLoad writes a config_load entry to the supplied logger", () => {
    const recordingLogger = new RecordingLogger();
    logConfigLoad(recordingLogger, "~/.claude/permissions.yaml", 4);
    expect(recordingLogger.entries.length).toBe(1);
    const entry = recordingLogger.entries[0] as IConfigLoadEntry;
    expect(entry.type).toBe("config_load");
    expect(entry.filePath).toBe("~/.claude/permissions.yaml");
    expect(entry.ruleCount).toBe(4);
    expect(typeof entry.timestamp).toBe("string");
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
// formatTextEntry
// ---------------------------------------------------------------------------

test("formatTextEntry tool_request with command shows tool and command", () => {
    const entry: IToolRequestEntry = {
        type: "tool_request",
        timestamp: "2025-06-15T10:23:01.000+10:00",
        tool: "Bash",
        input: { command: "ls -la" },
        cwd: "/home/user",
    };
    expect(formatTextEntry(entry)).toBe('10:23:01  TOOL     Bash      "ls -la"');
});

test("formatTextEntry tool_request with file_path shows tool and path", () => {
    const entry: IToolRequestEntry = {
        type: "tool_request",
        timestamp: "2025-06-15T10:23:01.000+10:00",
        tool: "Read",
        input: { file_path: "/project/src/main.ts" },
        cwd: "/home/user",
    };
    expect(formatTextEntry(entry)).toBe('10:23:01  TOOL     Read      "/project/src/main.ts"');
});

test("formatTextEntry tool_request with unknown input falls back to JSON", () => {
    const entry: IToolRequestEntry = {
        type: "tool_request",
        timestamp: "2025-06-15T10:23:01.000+10:00",
        tool: "Other",
        input: { foo: "bar" },
        cwd: "/home/user",
    };
    expect(formatTextEntry(entry)).toBe('10:23:01  TOOL     Other     "{"foo":"bar"}"');
});

test("formatTextEntry rule_match allow with ruleName shows RULE, cmd, rule, and decision", () => {
    const entry: IRuleMatchEntry = {
        type: "rule_match",
        timestamp: "2025-06-15T10:23:01.000+10:00",
        ruleFile: "ls",
        decision: "allow",
        cmd: "ls",
    };
    expect(formatTextEntry(entry)).toBe('10:23:01  RULE               "ls" → ls → allow');
});

test("formatTextEntry rule_match deny with reason shows RULE, cmd, rule, decision, and reason", () => {
    const entry: IRuleMatchEntry = {
        type: "rule_match",
        timestamp: "2025-06-15T10:23:01.000+10:00",
        ruleFile: "rm",
        decision: "deny",
        reason: "rm is not allowed",
        cmd: "rm foo",
    };
    expect(formatTextEntry(entry)).toBe('10:23:01  RULE               "rm foo" → rm → deny "rm is not allowed"');
});

test("formatTextEntry rule_match ask with reason shows RULE and decision", () => {
    const entry: IRuleMatchEntry = {
        type: "rule_match",
        timestamp: "2025-06-15T10:23:01.000+10:00",
        ruleFile: "catch-all",
        decision: "ask",
        reason: "please confirm",
        cmd: "something",
    };
    expect(formatTextEntry(entry)).toBe('10:23:01  RULE               "something" → catch-all → ask "please confirm"');
});

test("formatTextEntry rule_match without ruleName omits rule part", () => {
    const entry: IRuleMatchEntry = {
        type: "rule_match",
        timestamp: "2025-06-15T10:23:01.000+10:00",
        decision: "allow",
        cmd: "ls",
    };
    expect(formatTextEntry(entry)).toBe('10:23:01  RULE               "ls" → allow');
});

test("formatTextEntry rule_match with cmd and reason shows cmd before reason", () => {
    const entry: IRuleMatchEntry = {
        type: "rule_match",
        timestamp: "2025-06-15T10:23:01.000+10:00",
        ruleFile: "head-allow",
        decision: "allow",
        reason: "Readonly file access",
        cmd: "head -5 foo.csv",
    };
    expect(formatTextEntry(entry)).toBe('10:23:01  RULE               "head -5 foo.csv" → head-allow → allow "Readonly file access"');
});

test("formatTextEntry rule_match without cmd omits cmd part", () => {
    const entry: IRuleMatchEntry = {
        type: "rule_match",
        timestamp: "2025-06-15T10:23:01.000+10:00",
        ruleFile: "head-allow",
        decision: "allow",
        reason: "Readonly file access",
    };
    expect(formatTextEntry(entry)).toBe('10:23:01  RULE               head-allow → allow "Readonly file access"');
});

test("formatTextEntry no_rule_match shows NOMATCH with nodeType and cmd", () => {
    const entry: INoRuleMatchEntry = {
        type: "no_rule_match",
        timestamp: "2025-06-15T10:23:01.000+10:00",
        nodeType: "command",
        cmd: "ls -la",
    };
    expect(formatTextEntry(entry)).toBe('10:23:01  NOMATCH  command   "ls -la"');
});

test("formatTextEntry no_rule_match for read leaf shows file path", () => {
    const entry: INoRuleMatchEntry = {
        type: "no_rule_match",
        timestamp: "2025-06-15T10:23:01.000+10:00",
        nodeType: "read",
        cmd: "/tmp/x.txt",
    };
    expect(formatTextEntry(entry)).toBe('10:23:01  NOMATCH  read      "/tmp/x.txt"');
});

test("formatTextEntry aggregation shows NODE with cmd and decision", () => {
    const entry: IAggregationEntry = {
        type: "aggregation",
        timestamp: "2025-06-15T10:23:01.000+10:00",
        cmd: "git diff --cached && echo done",
        decision: "deny",
    };
    expect(formatTextEntry(entry)).toBe('10:23:01  NODE               "git diff --cached && echo done" → deny');
});

test("formatTextEntry aggregation with reason shows reason", () => {
    const entry: IAggregationEntry = {
        type: "aggregation",
        timestamp: "2025-06-15T10:23:01.000+10:00",
        cmd: "git diff --cached --name-only && echo done",
        decision: "allow",
        reason: "all sub-commands allowed",
    };
    expect(formatTextEntry(entry)).toBe('10:23:01  NODE               "git diff --cached --name-only && echo done" → allow "all sub-commands allowed"');
});

test("formatTextEntry final_decision with cmd shows cmd before decision", () => {
    const entry: IFinalDecisionEntry = {
        type: "final_decision",
        timestamp: "2025-06-15T10:23:01.000+10:00",
        tool: "Bash",
        cmd: "git diff --name-only",
        decision: "allow",
    };
    expect(formatTextEntry(entry)).toBe('10:23:01  RESULT   Bash      "git diff --name-only" → ALLOW');
});

test("formatTextEntry final_decision without cmd omits cmd part", () => {
    const entry: IFinalDecisionEntry = {
        type: "final_decision",
        timestamp: "2025-06-15T10:23:01.000+10:00",
        tool: "Bash",
        decision: "allow",
    };
    expect(formatTextEntry(entry)).toBe("10:23:01  RESULT   Bash      → ALLOW");
});

test("formatTextEntry final_decision with reason shows reason", () => {
    const entry: IFinalDecisionEntry = {
        type: "final_decision",
        timestamp: "2025-06-15T10:23:01.000+10:00",
        tool: "Bash",
        cmd: "rm foo",
        decision: "deny",
        reason: "rm is not allowed",
    };
    expect(formatTextEntry(entry)).toBe('10:23:01  RESULT   Bash      "rm foo" → DENY "rm is not allowed"');
});

test("formatTextEntry tool_execution with command input and isError false shows EXECUTE without ERROR", () => {
    const entry: IToolExecutionEntry = {
        type: "tool_execution",
        timestamp: "2025-06-15T10:23:01.000+10:00",
        tool: "Bash",
        input: { command: "ls -la" },
        cwd: "/home/user",
        response: { output: "file.txt", isError: false },
        isError: false,
    };
    expect(formatTextEntry(entry)).toBe('10:23:01  EXECUTE  Bash      "ls -la"');
});

test("formatTextEntry tool_execution with isError true appends ERROR suffix", () => {
    const entry: IToolExecutionEntry = {
        type: "tool_execution",
        timestamp: "2025-06-15T10:23:01.000+10:00",
        tool: "Bash",
        input: { command: "rm -rf /" },
        cwd: "/home/user",
        response: { output: "", isError: true },
        isError: true,
    };
    expect(formatTextEntry(entry)).toBe('10:23:01  EXECUTE  Bash      "rm -rf /" [ERROR]');
});

test("formatTextEntry config_load shows CONFIG, path, and rule count", () => {
    const entry: IConfigLoadEntry = {
        type: "config_load",
        timestamp: "2025-06-15T10:23:01.000+10:00",
        filePath: "~/.claude/permissions.yaml",
        ruleCount: 7,
    };
    expect(formatTextEntry(entry)).toBe("10:23:01  CONFIG             LOADED ~/.claude/permissions.yaml (7 rules)");
});

test("formatTextEntry config_load with one rule uses singular 'rule'", () => {
    const entry: IConfigLoadEntry = {
        type: "config_load",
        timestamp: "2025-06-15T10:23:01.000+10:00",
        filePath: ".claude/permissions.yaml",
        ruleCount: 1,
    };
    expect(formatTextEntry(entry)).toBe("10:23:01  CONFIG             LOADED .claude/permissions.yaml (1 rule)");
});

test("formatTextEntry config_load with zero rules uses plural 'rules'", () => {
    const entry: IConfigLoadEntry = {
        type: "config_load",
        timestamp: "2025-06-15T10:23:01.000+10:00",
        filePath: ".claude/permissions.yaml",
        ruleCount: 0,
    };
    expect(formatTextEntry(entry)).toBe("10:23:01  CONFIG             LOADED .claude/permissions.yaml (0 rules)");
});

test("formatTextEntry tool_execution with file_path input uses path as summary", () => {
    const entry: IToolExecutionEntry = {
        type: "tool_execution",
        timestamp: "2025-06-15T10:23:01.000+10:00",
        tool: "Read",
        input: { file_path: "/project/src/main.ts" },
        cwd: "/home/user",
        response: { content: "hello" },
        isError: false,
    };
    expect(formatTextEntry(entry)).toBe('10:23:01  EXECUTE  Read      "/project/src/main.ts"');
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

// ---------------------------------------------------------------------------
// CapturingAuditLogger
// ---------------------------------------------------------------------------

test("CapturingAuditLogger.log accumulates entries and getEntries returns them in order", () => {
    const logger = new CapturingAuditLogger();
    const entryA: IFinalDecisionEntry = {
        type: "final_decision",
        timestamp: "2025-06-15T10:00:00.000+10:00",
        tool: "Bash",
        decision: "allow",
    };
    const entryB: IFinalDecisionEntry = {
        type: "final_decision",
        timestamp: "2025-06-15T10:00:00.001+10:00",
        tool: "Read",
        decision: "deny",
    };
    logger.log(entryA);
    logger.log(entryB);
    const entries = logger.getEntries();
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual(entryA);
    expect(entries[1]).toEqual(entryB);
});

test("CapturingAuditLogger.reset clears all accumulated entries", () => {
    const logger = new CapturingAuditLogger();
    const entry: IFinalDecisionEntry = {
        type: "final_decision",
        timestamp: "2025-06-15T10:00:00.000+10:00",
        tool: "Bash",
        decision: "allow",
    };
    logger.log(entry);
    expect(logger.getEntries()).toHaveLength(1);
    logger.reset();
    expect(logger.getEntries()).toHaveLength(0);
});

test("CapturingAuditLogger.getEntries returns a copy so mutations do not affect internal state", () => {
    const logger = new CapturingAuditLogger();
    const entry: IFinalDecisionEntry = {
        type: "final_decision",
        timestamp: "2025-06-15T10:00:00.000+10:00",
        tool: "Bash",
        decision: "allow",
    };
    logger.log(entry);
    const firstCopy = logger.getEntries();
    firstCopy.pop();
    expect(logger.getEntries()).toHaveLength(1);
});
