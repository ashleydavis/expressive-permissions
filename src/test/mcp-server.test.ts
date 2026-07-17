import { formatTraceForClaude } from "../mcp-server";
import {
    IAuditLogEntry,
    IConfigLoadEntry,
    IToolRequestEntry,
    IRuleMatchEntry,
    INoRuleMatchEntry,
    IFinalDecisionEntry,
} from "../audit-log";

// makeConfigLoadEntry builds a synthetic config_load audit log entry.
function makeConfigLoadEntry(): IConfigLoadEntry {
    return {
        type: "config_load",
        timestamp: "2025-06-15T10:00:00.000+10:00",
        filePath: "~/.claude/permissions.yaml",
        ruleCount: 3,
    };
}

// makeToolRequestEntry builds a synthetic tool_request audit log entry.
function makeToolRequestEntry(): IToolRequestEntry {
    return {
        type: "tool_request",
        timestamp: "2025-06-15T10:00:00.001+10:00",
        tool: "Bash",
        input: { command: "git status" },
        cwd: "/project",
    };
}

// makeRuleMatchEntry builds a synthetic rule_match audit log entry.
function makeRuleMatchEntry(): IRuleMatchEntry {
    return {
        type: "rule_match",
        timestamp: "2025-06-15T10:00:00.002+10:00",
        ruleFile: ".claude/permissions.yaml",
        ruleLine: 5,
        decision: "allow",
        reason: "git is allowed",
        cmd: "git status",
    };
}

// makeNoRuleMatchEntry builds a synthetic no_rule_match audit log entry.
function makeNoRuleMatchEntry(): INoRuleMatchEntry {
    return {
        type: "no_rule_match",
        timestamp: "2025-06-15T10:00:00.003+10:00",
        nodeType: "command",
        cmd: "ls /tmp",
        cwd: "/project",
        env: {},
    };
}

// makeFinalDecisionEntry builds a synthetic final_decision audit log entry.
function makeFinalDecisionEntry(): IFinalDecisionEntry {
    return {
        type: "final_decision",
        timestamp: "2025-06-15T10:00:00.004+10:00",
        tool: "Bash",
        cmd: "git status",
        decision: "allow",
    };
}

test("formatTraceForClaude excludes config_load entries", () => {
    const trace: IAuditLogEntry[] = [makeConfigLoadEntry(), makeFinalDecisionEntry()];
    const output = formatTraceForClaude(trace);
    expect(output).not.toContain("config_load");
    expect(output).not.toContain("LOADED");
});

test("formatTraceForClaude excludes tool_request entries", () => {
    const trace: IAuditLogEntry[] = [makeToolRequestEntry(), makeFinalDecisionEntry()];
    const output = formatTraceForClaude(trace);
    expect(output).not.toContain("tool_request");
    expect(output).not.toContain("TOOL");
});

test("formatTraceForClaude includes rule_match entries", () => {
    const trace: IAuditLogEntry[] = [makeRuleMatchEntry(), makeFinalDecisionEntry()];
    const output = formatTraceForClaude(trace);
    expect(output).toContain("rule_match");
});

test("formatTraceForClaude pads entry type to 14 characters before entry content", () => {
    const trace: IAuditLogEntry[] = [makeFinalDecisionEntry()];
    const output = formatTraceForClaude(trace);
    const firstLine = output.split("\n")[0];
    expect(firstLine.startsWith("final_decision")).toBe(true);
    expect(firstLine[14]).toBe(" ");
    expect(firstLine[15]).toBe(" ");
});

test("formatTraceForClaude with empty trace returns empty string", () => {
    const output = formatTraceForClaude([]);
    expect(output).toBe("");
});

test("formatTraceForClaude with only suppressed entries returns empty string", () => {
    const trace: IAuditLogEntry[] = [makeConfigLoadEntry(), makeToolRequestEntry()];
    const output = formatTraceForClaude(trace);
    expect(output).toBe("");
});

test("formatTraceForClaude produces one line per non-suppressed entry", () => {
    const trace: IAuditLogEntry[] = [
        makeConfigLoadEntry(),
        makeToolRequestEntry(),
        makeRuleMatchEntry(),
        makeNoRuleMatchEntry(),
        makeFinalDecisionEntry(),
    ];
    const output = formatTraceForClaude(trace);
    const lines = output.split("\n").filter((line) => line.length > 0);
    expect(lines).toHaveLength(3);
});
