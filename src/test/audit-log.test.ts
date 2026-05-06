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
    toLocalISOString,
    IFinalDecisionEntry,
    IToolRequestEntry,
    IRuleMatchEntry,
    IAggregationEntry,
    IToolExecutionEntry,
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
    expect(formatTextEntry(entry)).toBe("10:23:01  TOOL     Bash: ls -la");
});

test("formatTextEntry tool_request with file_path shows tool and path", () => {
    const entry: IToolRequestEntry = {
        type: "tool_request",
        timestamp: "2025-06-15T10:23:01.000+10:00",
        tool: "Read",
        input: { file_path: "/project/src/main.ts" },
        cwd: "/home/user",
    };
    expect(formatTextEntry(entry)).toBe("10:23:01  TOOL     Read: /project/src/main.ts");
});

test("formatTextEntry tool_request with unknown input falls back to JSON", () => {
    const entry: IToolRequestEntry = {
        type: "tool_request",
        timestamp: "2025-06-15T10:23:01.000+10:00",
        tool: "Other",
        input: { foo: "bar" },
        cwd: "/home/user",
    };
    expect(formatTextEntry(entry)).toBe('10:23:01  TOOL     Other: {"foo":"bar"}');
});

test("formatTextEntry rule_match allow with ruleName shows ALLOW and rule", () => {
    const entry: IRuleMatchEntry = {
        type: "rule_match",
        timestamp: "2025-06-15T10:23:01.000+10:00",
        nodeType: "command",
        ruleName: "ls",
        decision: "allow",
    };
    expect(formatTextEntry(entry)).toBe("10:23:01  ALLOW    rule:ls  node:command");
});

test("formatTextEntry rule_match deny with reason shows DENY, rule, and reason", () => {
    const entry: IRuleMatchEntry = {
        type: "rule_match",
        timestamp: "2025-06-15T10:23:01.000+10:00",
        nodeType: "command",
        ruleName: "rm",
        decision: "deny",
        reason: "rm is not allowed",
    };
    expect(formatTextEntry(entry)).toBe('10:23:01  DENY     rule:rm  node:command  "rm is not allowed"');
});

test("formatTextEntry rule_match ask with reason shows ASK", () => {
    const entry: IRuleMatchEntry = {
        type: "rule_match",
        timestamp: "2025-06-15T10:23:01.000+10:00",
        nodeType: "command",
        ruleName: "catch-all",
        decision: "ask",
        reason: "please confirm",
    };
    expect(formatTextEntry(entry)).toBe('10:23:01  ASK      rule:catch-all  node:command  "please confirm"');
});

test("formatTextEntry rule_match without ruleName omits rule: part", () => {
    const entry: IRuleMatchEntry = {
        type: "rule_match",
        timestamp: "2025-06-15T10:23:01.000+10:00",
        nodeType: "command",
        decision: "allow",
    };
    expect(formatTextEntry(entry)).toBe("10:23:01  ALLOW    node:command");
});

test("formatTextEntry rule_match with cmd includes cmd in output", () => {
    const entry: IRuleMatchEntry = {
        type: "rule_match",
        timestamp: "2025-06-15T10:23:01.000+10:00",
        nodeType: "command",
        ruleName: "head-allow",
        decision: "allow",
        cmd: "head -5 foo.csv",
    };
    expect(formatTextEntry(entry)).toBe('10:23:01  ALLOW    rule:head-allow  node:command  cmd:"head -5 foo.csv"');
});

test("formatTextEntry rule_match with cmd and reason shows cmd before reason", () => {
    const entry: IRuleMatchEntry = {
        type: "rule_match",
        timestamp: "2025-06-15T10:23:01.000+10:00",
        nodeType: "command",
        ruleName: "head-allow",
        decision: "allow",
        reason: "Readonly file access",
        cmd: "head -5 foo.csv",
    };
    expect(formatTextEntry(entry)).toBe('10:23:01  ALLOW    rule:head-allow  node:command  cmd:"head -5 foo.csv"  "Readonly file access"');
});

test("formatTextEntry rule_match without cmd omits cmd part", () => {
    const entry: IRuleMatchEntry = {
        type: "rule_match",
        timestamp: "2025-06-15T10:23:01.000+10:00",
        nodeType: "command",
        ruleName: "head-allow",
        decision: "allow",
        reason: "Readonly file access",
    };
    expect(formatTextEntry(entry)).toBe('10:23:01  ALLOW    rule:head-allow  node:command  "Readonly file access"');
});

test("formatTextEntry aggregation with op shows all fields", () => {
    const entry: IAggregationEntry = {
        type: "aggregation",
        timestamp: "2025-06-15T10:23:01.000+10:00",
        nodeType: "binop",
        op: "&&",
        childrenDecision: "deny",
        ownDecision: "abstain",
        combined: "deny",
    };
    expect(formatTextEntry(entry)).toBe("10:23:01  AGG      node:binop  op:&&  children:deny  own:abstain  → deny");
});

test("formatTextEntry aggregation without op omits op part", () => {
    const entry: IAggregationEntry = {
        type: "aggregation",
        timestamp: "2025-06-15T10:23:01.000+10:00",
        nodeType: "bash",
        childrenDecision: "allow",
        ownDecision: "abstain",
        combined: "allow",
    };
    expect(formatTextEntry(entry)).toBe("10:23:01  AGG      node:bash  children:allow  own:abstain  → allow");
});

test("formatTextEntry final_decision without reason shows RESULT", () => {
    const entry: IFinalDecisionEntry = {
        type: "final_decision",
        timestamp: "2025-06-15T10:23:01.000+10:00",
        tool: "Bash",
        decision: "allow",
    };
    expect(formatTextEntry(entry)).toBe("10:23:01  RESULT   Bash → ALLOW");
});

test("formatTextEntry final_decision with reason shows reason", () => {
    const entry: IFinalDecisionEntry = {
        type: "final_decision",
        timestamp: "2025-06-15T10:23:01.000+10:00",
        tool: "Bash",
        decision: "deny",
        reason: "rm is not allowed",
    };
    expect(formatTextEntry(entry)).toBe('10:23:01  RESULT   Bash → DENY  "rm is not allowed"');
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
    expect(formatTextEntry(entry)).toBe("10:23:01  EXECUTE  Bash: ls -la");
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
    expect(formatTextEntry(entry)).toBe("10:23:01  EXECUTE  Bash: rm -rf /  [ERROR]");
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
    expect(formatTextEntry(entry)).toBe("10:23:01  EXECUTE  Read: /project/src/main.ts");
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
