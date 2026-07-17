import { appendFileSync, existsSync, mkdirSync, readdirSync, rmSync } from "fs";
import { access, mkdir, writeFile } from "fs/promises";
import { join } from "path";

// Base interface shared by all audit log entry types.
export interface IAuditLogEntryBase {
    // Discriminator identifying which entry variant this is.
    type: string;
    // ISO 8601 local-time timestamp of when the entry was created.
    timestamp: string;
}

// Logged once per hook invocation, before any rule evaluation, capturing the incoming tool call.
export interface IToolRequestEntry extends IAuditLogEntryBase {
    // Discriminator for the tool_request variant.
    type: "tool_request";
    // The Claude Code tool name (e.g. "Bash", "Read").
    tool: string;
    // The raw tool input arguments.
    input: Record<string, unknown>;
    // The current working directory at hook invocation time.
    cwd: string;
}

// Logged once per non-abstaining rule match during tree evaluation.
export interface IRuleMatchEntry extends IAuditLogEntryBase {
    // Discriminator for the rule_match variant.
    type: "rule_match";
    // The source file the rule was loaded from, if known.
    ruleFile?: string;
    // The 1-based line number in ruleFile where this rule's entry begins, if known.
    ruleLine?: number;
    // The decision produced by this rule.
    decision: string;
    // Optional human-readable reason attached to the decision.
    reason?: string;
    // The reconstructed sub-command or path that this rule was matched against.
    cmd?: string;
    // Effective cwd when this match was recorded.
    cwd?: string;
    // Effective env when this match was recorded.
    env?: Record<string, string>;
}

// Logged once when every rule abstained on a node with no children, signalling that no rule
// recognised the node and the engine fell back to the default ask. Surfaces gaps
// in the user's permissions.yaml.
export interface INoRuleMatchEntry extends IAuditLogEntryBase {
    // Discriminator for the no_rule_match variant.
    type: "no_rule_match";
    // The discriminator of the AST node (e.g. "command", "read", "other").
    nodeType: string;
    // The reconstructed sub-command or path that no rule matched.
    cmd: string;
    // Effective cwd when the node was evaluated.
    cwd: string;
    // Effective env when the node was evaluated.
    env: Record<string, string>;
}

// Logged once per intermediate node after combining children and own-rule results.
export interface IAggregationEntry extends IAuditLogEntryBase {
    // Discriminator for the aggregation variant.
    type: "aggregation";
    // The reconstructed command string for this node.
    cmd: string;
    // The final combined decision after evaluating all rules and children.
    decision: string;
    // Optional human-readable reason attached to the decision.
    reason?: string;
}

// Logged once per hook invocation, just before returning the final decision.
export interface IFinalDecisionEntry extends IAuditLogEntryBase {
    // Discriminator for the final_decision variant.
    type: "final_decision";
    // The Claude Code tool name.
    tool: string;
    // The reconstructed command or file path from the tool input.
    cmd?: string;
    // The final decision returned by the engine.
    decision: string;
    // Optional human-readable reason attached to the decision.
    reason?: string;
}

// Logged when a permissions config file is loaded at hook startup.
export interface IConfigLoadEntry extends IAuditLogEntryBase {
    // Discriminator for the config_load variant.
    type: "config_load";
    // Display path of the config file (e.g. "~/.claude/permissions.yaml").
    filePath: string;
    // Number of compiled rules produced by this load.
    ruleCount: number;
}

// Logged once per PostToolUse hook invocation, capturing the tool execution result.
export interface IToolExecutionEntry extends IAuditLogEntryBase {
    // Discriminator for the tool_execution variant.
    type: "tool_execution";
    // The Claude Code tool name (e.g. "Bash", "Read").
    tool: string;
    // The raw tool input arguments.
    input: Record<string, unknown>;
    // The current working directory at hook invocation time.
    cwd: string;
    // The raw tool response payload.
    response: Record<string, unknown>;
    // Whether the tool reported an error in its response.
    isError: boolean;
}

// Union of all audit log entry variants.
export type IAuditLogEntry = IToolRequestEntry | IRuleMatchEntry | INoRuleMatchEntry | IAggregationEntry | IFinalDecisionEntry | IToolExecutionEntry | IConfigLoadEntry;

// Interface for objects that can receive audit log entries.
export interface IAuditLogger {
    // Appends one entry to the audit log.
    log(entry: IAuditLogEntry): void;
}

// ICommandOutcomeSource identifies why a command received its decision label.
export type ICommandOutcomeSource = "matched-rule" | "no-rule-match" | "deny-rule";

// ICommandOutcome records one command outcome for pending prompt formatting.
export interface ICommandOutcome {

    // Reconstructed command string for this node.
    cmd: string;

    // Uppercase decision label: ALLOW, DENY, ASK, or NOMATCH.
    decision: string;

    // Source file of the matched rule, when present.
    ruleFile?: string;

    // 1-based line number in ruleFile, when present.
    ruleLine?: number;

    // Human-readable reason from the rule evaluation.
    reason?: string;

    // Why this outcome was assigned.
    source: ICommandOutcomeSource;

    // Effective working directory when the command is evaluated.
    cwd: string;

    // Environment variables visible when the command is evaluated.
    env: Record<string, string>;
}

// toLocalISOString formats a Date as an ISO 8601 string in local time with timezone offset
// (e.g. "2025-06-15T10:23:01.500+10:00"). Unlike Date.toISOString() this never produces a
// UTC "Z" suffix, so the offset always reflects the machine's local timezone.
export function toLocalISOString(date: Date): string {
    const offsetMinutes = -date.getTimezoneOffset();
    const sign = offsetMinutes >= 0 ? "+" : "-";
    const absOffset = Math.abs(offsetMinutes);
    const offsetHours = String(Math.floor(absOffset / 60)).padStart(2, "0");
    const offsetMins = String(absOffset % 60).padStart(2, "0");
    const year = date.getFullYear().toString();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    const hours = String(date.getHours()).padStart(2, "0");
    const minutes = String(date.getMinutes()).padStart(2, "0");
    const seconds = String(date.getSeconds()).padStart(2, "0");
    const ms = String(date.getMilliseconds()).padStart(3, "0");
    return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}.${ms}${sign}${offsetHours}:${offsetMins}`;
}

// resolveLogBaseDir returns the absolute path to the log directory for a given project root.
export function resolveLogBaseDir(projectDir: string): string {
    return join(projectDir, ".claude", "permissions-log");
}

// logDirGitignoreContents is the body written into the log directory's .gitignore. It ignores
// every file in the directory except the .gitignore itself, so the directory's contents stay
// out of version control in any repo that contains it while the .gitignore remains tracked
// (and therefore present on clone).
const logDirGitignoreContents = "*\n!.gitignore\n";

// ensureLogDirIgnored writes a self-ignoring .gitignore into the log base directory when one is
// not already present, creating the directory if needed. This makes any repo containing the log
// directory automatically exclude the audit log output from version control.
export async function ensureLogDirIgnored(logBaseDir: string): Promise<void> {
    const gitignorePath = join(logBaseDir, ".gitignore");

    try {
        await access(gitignorePath);
        return;
    }
    catch {
        // .gitignore is absent; fall through to create the directory and the file.
    }

    await mkdir(logBaseDir, { recursive: true });
    await writeFile(gitignorePath, logDirGitignoreContents);
}

// resolveJsonLogPath returns the machine-readable JSON Lines log file path.
// Format: <baseDir>/YYYY-MM/DD/HH.json, all components zero-padded, local time.
export function resolveJsonLogPath(baseDir: string, now: Date): string {
    const year = now.getFullYear().toString();
    const month = String(now.getMonth() + 1).padStart(2, "0");
    const day = String(now.getDate()).padStart(2, "0");
    const hour = String(now.getHours()).padStart(2, "0");
    return join(baseDir, `${year}-${month}`, day, `${hour}.json`);
}

// resolveTextLogPath returns the human-readable plain text log file path.
// Format: <baseDir>/YYYY-MM/DD/HH.log, all components zero-padded, local time.
export function resolveTextLogPath(baseDir: string, now: Date): string {
    const year = now.getFullYear().toString();
    const month = String(now.getMonth() + 1).padStart(2, "0");
    const day = String(now.getDate()).padStart(2, "0");
    const hour = String(now.getHours()).padStart(2, "0");
    return join(baseDir, `${year}-${month}`, day, `${hour}.log`);
}

// formatTextEntry formats a single audit log entry as a human-readable text line.
// Columns: HH:MM:SS  LABEL    <details>
// LABEL is padded to 9 characters. Only the time (HH:MM:SS) is shown, not the full timestamp.
export function formatTextEntry(entry: IAuditLogEntry): string {
    const time = entry.timestamp.slice(11, 19);

    switch (entry.type) {
        case "tool_request": {
            let inputSummary: string;
            if (typeof entry.input["command"] === "string") {
                inputSummary = entry.input["command"];
            }
            else if (typeof entry.input["file_path"] === "string") {
                inputSummary = entry.input["file_path"];
            }
            else {
                inputSummary = JSON.stringify(entry.input);
            }
            return `${time}  ${"TOOL".padEnd(9)}${entry.tool.padEnd(10)}"${inputSummary}"`;
        }
        case "rule_match": {
            const reasonPart = entry.reason ? ` "${entry.reason}"` : "";
            let content: string;
            if (entry.cmd !== undefined && entry.ruleFile) {
                const linePart = entry.ruleLine !== undefined ? `:${entry.ruleLine}` : "";
                content = `"${entry.cmd}" → ${entry.ruleFile}${linePart} → ${entry.decision}${reasonPart}`;
            }
            else if (entry.cmd !== undefined) {
                content = `"${entry.cmd}" → ${entry.decision}${reasonPart}`;
            }
            else if (entry.ruleFile) {
                const linePart = entry.ruleLine !== undefined ? `:${entry.ruleLine}` : "";
                content = `${entry.ruleFile}${linePart} → ${entry.decision}${reasonPart}`;
            }
            else {
                content = `→ ${entry.decision}${reasonPart}`;
            }
            return `${time}  ${"RULE".padEnd(9)}${"".padEnd(10)}${content}`;
        }
        case "no_rule_match": {
            return `${time}  ${"NOMATCH".padEnd(9)}${entry.nodeType.padEnd(10)}"${entry.cmd}"`;
        }
        case "aggregation": {
            const reasonPart = entry.reason ? ` "${entry.reason}"` : "";
            return `${time}  ${"NODE".padEnd(9)}${"".padEnd(10)}"${entry.cmd}" → ${entry.decision}${reasonPart}`;
        }
        case "final_decision": {
            const cmdPart = entry.cmd !== undefined ? `"${entry.cmd}" → ` : "→ ";
            const reasonPart = entry.reason ? ` "${entry.reason}"` : "";
            return `${time}  ${"RESULT".padEnd(9)}${entry.tool.padEnd(10)}${cmdPart}${entry.decision.toUpperCase()}${reasonPart}`;
        }
        case "config_load": {
            const ruleWord = entry.ruleCount === 1 ? "rule" : "rules";
            return `${time}  ${"CONFIG".padEnd(9)}${"".padEnd(10)}LOADED ${entry.filePath} (${entry.ruleCount} ${ruleWord})`;
        }
        case "tool_execution": {
            let executeSummary: string;
            if (typeof entry.input["command"] === "string") {
                executeSummary = entry.input["command"];
            }
            else if (typeof entry.input["file_path"] === "string") {
                executeSummary = entry.input["file_path"];
            }
            else {
                executeSummary = JSON.stringify(entry.input);
            }
            const errorPart = entry.isError ? " [ERROR]" : "";
            return `${time}  ${"EXECUTE".padEnd(9)}${entry.tool.padEnd(10)}"${executeSummary}"${errorPart}`;
        }
    }
}

// cleanupOldMonths removes month directories from baseDir whose month is more than 2
// months before the current month. The three most recent months (including the current one)
// are always kept. Entries that do not match the YYYY-MM pattern are left untouched.
// Silently returns if baseDir does not exist.
export function cleanupOldMonths(baseDir: string, now: Date): void {
    if (!existsSync(baseDir)) {
        return;
    }

    const currentMonthKey = now.getFullYear() * 12 + now.getMonth();

    for (const entry of readdirSync(baseDir)) {
        const match = entry.match(/^(\d{4})-(\d{2})$/);
        if (!match) {
            continue;
        }

        const entryYear = parseInt(match[1], 10);
        const entryMonth = parseInt(match[2], 10) - 1;
        const entryMonthKey = entryYear * 12 + entryMonth;

        if (entryMonthKey < currentMonthKey - 2) {
            rmSync(join(baseDir, entry), { recursive: true, force: true });
        }
    }
}

// NullAuditLogger is a no-op implementation of IAuditLogger used in tests and
// when CLAUDE_PROJECT_DIR is not set.
export class NullAuditLogger implements IAuditLogger {
    // log discards the entry without writing anything.
    log(_entry: IAuditLogEntry): void {
        // intentional no-op
    }
}

// CapturingAuditLogger is an IAuditLogger implementation that stores every entry
// passed to log() in memory, for use in analysis and testing contexts.
export class CapturingAuditLogger implements IAuditLogger {
    // The accumulated log entries in the order they were received.
    private _entries: IAuditLogEntry[] = [];

    // log appends entry to the internal accumulator.
    log(entry: IAuditLogEntry): void {
        this._entries.push(entry);
    }

    // getEntries returns a copy of all accumulated entries in order.
    getEntries(): IAuditLogEntry[] {
        return [...this._entries];
    }

    // reset clears all accumulated entries.
    reset(): void {
        this._entries = [];
    }
}

// FileAuditLogger writes each entry to both a JSON Lines file (HH.json) and a
// human-readable plain text file (HH.log), creating directories as needed.
export class FileAuditLogger implements IAuditLogger {
    // The base directory under which YYYY-MM/DD/ files are written.
    private readonly baseDir: string;
    // The timestamp used to derive the log file paths for this invocation.
    private readonly now: Date;

    constructor(baseDir: string, now: Date) {
        this.baseDir = baseDir;
        this.now = now;
    }

    // log appends entry to the JSON Lines file and its text representation to the plain text file.
    log(entry: IAuditLogEntry): void {
        const jsonPath = resolveJsonLogPath(this.baseDir, this.now);
        mkdirSync(join(jsonPath, ".."), { recursive: true });
        appendFileSync(jsonPath, JSON.stringify(entry) + "\n");
        const textPath = resolveTextLogPath(this.baseDir, this.now);
        appendFileSync(textPath, formatTextEntry(entry) + "\n");
    }
}

// createFileAuditLogger is a factory that constructs a FileAuditLogger for the given
// log base directory and current timestamp.
export function createFileAuditLogger(logBaseDir: string, now: Date): FileAuditLogger {
    return new FileAuditLogger(logBaseDir, now);
}

// createLogger constructs a FileAuditLogger for a hook invocation, pruning old month
// directories before returning. projectDir is the value of CLAUDE_PROJECT_DIR, which
// Claude Code always injects into hook processes.
export function createLogger(projectDir: string, now: Date): FileAuditLogger {
    const logBaseDir = resolveLogBaseDir(projectDir);
    cleanupOldMonths(logBaseDir, now);
    return createFileAuditLogger(logBaseDir, now);
}

// logConfigLoad writes a config_load entry to the supplied audit logger.
export function logConfigLoad(logger: IAuditLogger, displayPath: string, ruleCount: number): void {
    logger.log({
        type: "config_load",
        timestamp: toLocalISOString(new Date()),
        filePath: displayPath,
        ruleCount,
    });
}
