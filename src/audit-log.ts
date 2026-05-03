import { appendFileSync, existsSync, mkdirSync, readdirSync, rmSync } from "fs";
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
    // The type field of the AST node that was evaluated.
    nodeType: string;
    // The name of the rule that produced the decision, if available.
    ruleName?: string;
    // The decision produced by this rule.
    decision: string;
    // Optional human-readable reason attached to the decision.
    reason?: string;
}

// Logged once per intermediate node after combining children and own-rule results.
export interface IAggregationEntry extends IAuditLogEntryBase {
    // Discriminator for the aggregation variant.
    type: "aggregation";
    // The type field of the intermediate AST node.
    nodeType: string;
    // The binary operator token for binop nodes (e.g. "&&", "||", ";", "|").
    op?: string;
    // The aggregated decision produced by all children.
    childrenDecision: string;
    // The decision produced by this node's own rules (may be "abstain").
    ownDecision: string;
    // The final combined decision after layering own rules onto children.
    combined: string;
}

// Logged once per hook invocation, just before returning the final decision.
export interface IFinalDecisionEntry extends IAuditLogEntryBase {
    // Discriminator for the final_decision variant.
    type: "final_decision";
    // The Claude Code tool name.
    tool: string;
    // The final decision returned by the engine.
    decision: string;
    // Optional human-readable reason attached to the decision.
    reason?: string;
}

// Union of all audit log entry variants.
export type IAuditLogEntry = IToolRequestEntry | IRuleMatchEntry | IAggregationEntry | IFinalDecisionEntry;

// Interface for objects that can receive audit log entries.
export interface IAuditLogger {
    // Appends one entry to the audit log.
    log(entry: IAuditLogEntry): void;
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

// resolveLogPath returns the local-time-based log file path for the given base directory and timestamp.
// Format: <baseDir>/YYYY-MM/DD/HH.log, all components zero-padded.
export function resolveLogPath(baseDir: string, now: Date): string {
    const year = now.getFullYear().toString();
    const month = String(now.getMonth() + 1).padStart(2, "0");
    const day = String(now.getDate()).padStart(2, "0");
    const hour = String(now.getHours()).padStart(2, "0");
    return join(baseDir, `${year}-${month}`, day, `${hour}.log`);
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

// FileAuditLogger writes each entry as a JSON line to the local-time-keyed log file,
// creating directories as needed.
export class FileAuditLogger implements IAuditLogger {
    // The base directory under which YYYY-MM/DD/HH.log files are written.
    private readonly baseDir: string;
    // The timestamp used to derive the log file path for this invocation.
    private readonly now: Date;

    constructor(baseDir: string, now: Date) {
        this.baseDir = baseDir;
        this.now = now;
    }

    // log serialises entry as a JSON line and appends it to the current hour's log file.
    log(entry: IAuditLogEntry): void {
        const logPath = resolveLogPath(this.baseDir, this.now);
        mkdirSync(join(logPath, ".."), { recursive: true });
        appendFileSync(logPath, JSON.stringify(entry) + "\n");
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
