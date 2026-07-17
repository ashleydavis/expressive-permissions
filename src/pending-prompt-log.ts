import { mkdir, readdir, stat, unlink, writeFile } from "fs/promises";
import { join } from "path";
import {
    IAuditLogEntry,
    ICommandOutcome,
    ICommandOutcomeSource,
    IRuleMatchEntry,
} from "./audit-log";
import { IAstNode } from "./ast";
import { BinopAstNode } from "./ast-nodes/binop-ast-node";
import { BashAstNode } from "./ast-nodes/bash-ast-node";
import { pickStrictest } from "./ast-nodes/ast-node";
import { IContext } from "./context";
import { IDecision } from "./rules/rule";
import { IToolCall } from "./types";

// STALE_PENDING_PROMPT_MAX_AGE_DAYS is how long denied or ignored pending files are kept.
export const STALE_PENDING_PROMPT_MAX_AGE_DAYS = 1;

// PENDING_PROMPT_DESCRIPTION_MAX_LENGTH caps the command summary segment in pending filenames.
const PENDING_PROMPT_DESCRIPTION_MAX_LENGTH = 60;

// ICommandDecisionSource identifies why a command received its decision label.
export type ICommandDecisionSource = "matched-rule" | "no-rule-match" | "deny-rule";

// ICommandDecision holds the permission label and rule attribution for one command.
export interface ICommandDecision {
    // Uppercase decision label: ALLOW, DENY, ASK, or NOMATCH.
    decision: string;
    // Source file of the matched rule, when present.
    ruleFile?: string;
    // 1-based line number in ruleFile, when present.
    ruleLine?: number;
    // Human-readable reason from the rule or trace entry.
    reason?: string;
    // Why this outcome was assigned.
    source?: ICommandDecisionSource;
}

// ICommandContext holds simulated cwd and env at the point a command runs.
export interface ICommandContext {
    // Effective working directory when the command executes.
    cwd: string;
    // Environment variables visible to the command.
    env: Record<string, string>;
}

// IVerdictTrigger identifies the sub-command that drove the final verdict.
export interface IVerdictTrigger {
    // Reconstructed sub-command string.
    cmd: string;
    // Human-readable source label for the verdict line.
    sourceLabel: string;
    // Reason attached to the triggering outcome.
    reason: string | undefined;
    // Effective cwd of the trigger when it differs from the hook cwd.
    cwd: string | undefined;
    // Environment variables visible at the trigger command, when non-empty.
    env: Record<string, string> | undefined;
    // Outcome recorded for the trigger command.
    outcome: ICommandDecision | undefined;
}

// resolvePendingDir returns the directory for pending approval detail files.
export function resolvePendingDir(projectDir: string): string {
    return join(projectDir, ".claude", "permissions-log", "pending");
}

// Return the AST child nodes in walk order.
function childNodes(node: IAstNode): IAstNode[] {

    if (!node.children) {
        return [];
    }

    if ("_" in node.children) {
        const positionalChildren = node.children._;
        if (Array.isArray(positionalChildren)) {
            return positionalChildren;
        }
    }

    const namedChildren: IAstNode[] = [];
    for (const childValue of Object.values(node.children)) {
        if (childValue && !Array.isArray(childValue)) {
            namedChildren.push(childValue);
        }
    }

    return namedChildren;
}

// formatPendingPromptFileTimestamp renders yyyy-mm-dd-hh-ss for pending detail filenames.
export function formatPendingPromptFileTimestamp(date: Date): string {
    const year = date.getFullYear().toString();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    const hours = String(date.getHours()).padStart(2, "0");
    const seconds = String(date.getSeconds()).padStart(2, "0");
    return `${year}-${month}-${day}-${hours}-${seconds}`;
}

// sanitizePendingPromptDescription converts command text into a filesystem-safe slug segment.
export function sanitizePendingPromptDescription(text: string): string {
    let sanitized = text.toLowerCase();
    sanitized = sanitized.replace(/[^a-z0-9]+/g, "-");
    sanitized = sanitized.replace(/-+/g, "-");
    sanitized = sanitized.replace(/^-|-$/g, "");
    if (sanitized.length > PENDING_PROMPT_DESCRIPTION_MAX_LENGTH) {
        sanitized = sanitized.slice(0, PENDING_PROMPT_DESCRIPTION_MAX_LENGTH);
    }
    return sanitized;
}

// buildPendingPromptFileName builds `<timestamp>-<sanitized-summary>.md` for a pending detail file.
export function buildPendingPromptFileName(call: IToolCall, pendingSince: Date): string {
    const timestampPart = formatPendingPromptFileTimestamp(pendingSince);
    const commandSummary = summarizeToolInput(call);
    let descriptionPart = sanitizePendingPromptDescription(commandSummary);
    if (descriptionPart.length === 0) {
        descriptionPart = sanitizePendingPromptDescription(call.tool_name);
    }
    if (descriptionPart.length === 0) {
        descriptionPart = "tool";
    }
    return `${timestampPart}-${descriptionPart}.md`;
}

// resolvePendingPromptFilePath picks a non-colliding path under pending/ for a new detail file.
export async function resolvePendingPromptFilePath(pendingDir: string, baseFileName: string): Promise<string> {
    const extensionIndex = baseFileName.lastIndexOf(".md");
    const baseName = baseFileName.slice(0, extensionIndex);
    let suffix = 0;
    while (true) {
        const fileName = suffix === 0 ? baseFileName : `${baseName}-${suffix}.md`;
        const filePath = join(pendingDir, fileName);
        try {
            await stat(filePath);
            suffix = suffix + 1;
        }
        catch {
            return filePath;
        }
    }
}

// summarizeToolInput picks a short human-readable summary from tool input fields.
function summarizeToolInput(call: IToolCall): string {
    if (typeof call.tool_input["command"] === "string") {
        return call.tool_input["command"];
    }
    if (typeof call.tool_input["file_path"] === "string") {
        return call.tool_input["file_path"];
    }
    return JSON.stringify(call.tool_input);
}

// formatLocalTimestamp formats a Date as local ISO 8601 with timezone offset.
function formatLocalTimestamp(date: Date): string {
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
    const millis = String(date.getMilliseconds()).padStart(3, "0");
    return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}.${millis}${sign}${offsetHours}:${offsetMins}`;
}

// buildCommandDecisionMap indexes command decisions from evaluation records.
export function buildCommandDecisionMap(evaluations: ICommandOutcome[]): Map<string, ICommandDecision> {
    const outcomeMap = new Map<string, ICommandDecision>();

    for (const evaluation of evaluations) {
        outcomeMap.set(evaluation.cmd, {
            decision: evaluation.decision,
            ruleFile: evaluation.ruleFile,
            ruleLine: evaluation.ruleLine,
            reason: evaluation.reason,
            source: evaluation.source,
        });
    }

    return outcomeMap;
}

// buildCommandContextMap indexes command cwd/env from evaluation records collected during evaluate.
export function buildCommandContextMap(evaluations: ICommandOutcome[]): Map<string, ICommandContext> {
    const commandContextMap = new Map<string, ICommandContext>();

    for (const evaluation of evaluations) {
        commandContextMap.set(evaluation.cmd, {
            cwd: evaluation.cwd,
            env: { ...evaluation.env },
        });
    }

    return commandContextMap;
}

// IPendingCommandMatchBuffer holds command rule_match entries waiting to become one command outcome.
interface IPendingCommandMatchBuffer {

    // Command source string.
    cmd: string;

    // Effective cwd carried on the command events.
    cwd: string;

    // Effective env carried on the command events.
    env: Record<string, string>;

    // Command rule_match entries for this command, in order.
    matches: IRuleMatchEntry[];
}

// Compare two env maps for equality used when grouping command audit events.
function envMapsEqual(left: Record<string, string>, right: Record<string, string>): boolean {

    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    if (leftKeys.length !== rightKeys.length) {
        return false;
    }

    for (const key of leftKeys) {
        if (left[key] !== right[key]) {
            return false;
        }
    }

    return true;
}

// Build one command outcome from a completed buffer of command rule_match entries.
function commandOutcomeFromMatches(buffer: IPendingCommandMatchBuffer): ICommandOutcome {

    const decisions: IDecision[] = [];
    for (const match of buffer.matches) {
        decisions.push({
            action: match.decision,
            reason: match.reason,
        });
    }

    const picked = pickStrictest(decisions);
    if (!picked) {
        return {
            cmd: buffer.cmd,
            decision: "NOMATCH",
            source: "no-rule-match",
            cwd: buffer.cwd,
            env: { ...buffer.env },
        };
    }

    let chosen = buffer.matches.find((match) => {
        return match.decision === picked.action && match.reason === picked.reason;
    });
    if (!chosen) {
        chosen = buffer.matches.find((match) => match.decision === picked.action);
    }

    let source: ICommandOutcomeSource = "matched-rule";
    if (picked.action === "deny") {
        source = "deny-rule";
    }

    return {
        cmd: buffer.cmd,
        decision: picked.action.toUpperCase(),
        ruleFile: chosen?.ruleFile,
        ruleLine: chosen?.ruleLine,
        reason: picked.reason,
        source,
        cwd: buffer.cwd,
        env: { ...buffer.env },
    };
}

// Unwrap evaluate audit entries into the command outcomes used by pending approval markdown.
export function commandOutcomesFromAuditEntries(entries: IAuditLogEntry[]): ICommandOutcome[] {

    const commandOutcomes: ICommandOutcome[] = [];
    let pending: IPendingCommandMatchBuffer | undefined;

    for (const entry of entries) {
        if (entry.type === "no_rule_match") {
            if (pending) {
                commandOutcomes.push(commandOutcomeFromMatches(pending));
                pending = undefined;
            }
            commandOutcomes.push({
                cmd: entry.cmd,
                decision: "NOMATCH",
                source: "no-rule-match",
                cwd: entry.cwd,
                env: { ...entry.env },
            });
            continue;
        }

        if (entry.type === "rule_match") {
            const cmd = entry.cmd ?? "";
            const cwd = entry.cwd ?? "";
            const env = entry.env ?? {};
            if (
                pending
                && (
                    pending.cmd !== cmd
                    || pending.cwd !== cwd
                    || !envMapsEqual(pending.env, env)
                )
            ) {
                commandOutcomes.push(commandOutcomeFromMatches(pending));
                pending = undefined;
            }

            if (!pending) {
                pending = {
                    cmd,
                    cwd,
                    env: { ...env },
                    matches: [],
                };
            }

            pending.matches.push(entry);
            continue;
        }

        if (entry.type === "aggregation") {
            if (pending) {
                commandOutcomes.push(commandOutcomeFromMatches(pending));
                pending = undefined;
            }
        }
    }

    if (pending) {
        commandOutcomes.push(commandOutcomeFromMatches(pending));
    }

    return commandOutcomes;
}

// flattenSequential expands && and ; chains into an ordered command-or-compound list.
function flattenSequential(node: IAstNode): IAstNode[] {

    if (node.type === "binop") {
        const binop = node as BinopAstNode;
        if (binop.op === "&&" || binop.op === ";") {
            return [
                ...flattenSequential(binop.children.left),
                ...flattenSequential(binop.children.right),
            ];
        }
    }

    if (node.type === "bash") {
        const bashNode = node as BashAstNode;
        return flattenSequential(bashNode.children.command);
    }

    return [node];
}

// truncateLabel shortens a tree label for the root summary line.
function truncateLabel(label: string, maxLength: number): string {
    if (label.length <= maxLength) {
        return label;
    }
    return label.slice(0, maxLength - 1) + "…";
}

// formatEnvSummary renders sorted env key=value pairs joined for display.
function formatEnvSummary(env: Record<string, string>): string {
    const envKeys = Object.keys(env).sort();
    const parts: string[] = [];
    for (const key of envKeys) {
        parts.push(`${key}=${env[key]}`);
    }
    return parts.join(", ");
}

// formatRuleLine renders a labeled rule reference line, or undefined when omitted.
function formatRuleLine(outcome: ICommandDecision): string | undefined {
    if (outcome.source === "no-rule-match") {
        return undefined;
    }
    if (outcome.reason === "set environment variable") {
        return undefined;
    }
    if (outcome.ruleFile !== undefined) {
        if (outcome.ruleLine !== undefined) {
            return `rule: ${outcome.ruleFile}:${outcome.ruleLine}`;
        }
        return `rule: ${outcome.ruleFile}`;
    }
    return "rule: (builtin)";
}

// outcomeIndent returns the prefix for labeled outcome lines under a tree node.
function outcomeIndent(prefix: string, isLast: boolean): string {
    if (isLast) {
        return `${prefix}      `;
    }
    return `${prefix}│     `;
}

// appendOutcomeLines renders cwd/env/decision/rule/reason lines for one tree node.
function appendOutcomeLines(
    outcome: ICommandDecision | undefined,
    commandContext: ICommandContext | undefined,
    hookCwd: string,
    prefix: string,
    isLast: boolean,
    lines: string[]
): void {
    lines.push(`${prefix}│`);
    const indent = outcomeIndent(prefix, isLast);

    if (commandContext !== undefined && commandContext.cwd !== hookCwd) {
        lines.push(`${indent}cwd: ${commandContext.cwd}`);
    }

    if (commandContext !== undefined && Object.keys(commandContext.env).length > 0) {
        lines.push(`${indent}env: ${formatEnvSummary(commandContext.env)}`);
    }

    if (outcome === undefined) {
        return;
    }

    lines.push(`${indent}decision: ${outcome.decision}`);
    const ruleLine = formatRuleLine(outcome);
    if (ruleLine !== undefined) {
        lines.push(`${indent}${ruleLine}`);
    }
    if (outcome.reason !== undefined && outcome.reason !== "") {
        lines.push(`${indent}reason: "${outcome.reason}"`);
    }
}

// appendTreeLines renders one AST node and its children into tree lines.
function appendTreeLines(
    node: IAstNode,
    prefix: string,
    isLast: boolean,
    commandDecisionMap: Map<string, ICommandDecision>,
    commandContextMap: Map<string, ICommandContext>,
    hookCwd: string,
    lines: string[]
): void {
    const connector = isLast ? "└── " : "├── ";
    const childPrefix = isLast ? "    " : "│   ";

    if (node.type === "bash") {
        const bashNode = node as BashAstNode;
        appendTreeLines(
            bashNode.children.command,
            prefix,
            isLast,
            commandDecisionMap,
            commandContextMap,
            hookCwd,
            lines
        );
        return;
    }

    if (node.type === "binop") {
        const binop = node as BinopAstNode;
        if (binop.op === "&&" || binop.op === ";") {
            const parts = flattenSequential(node);
            if (parts.length > 1) {
                lines.push(`${prefix}${connector}${truncateLabel(node.source, 80)}`);
                for (let index = 0; index < parts.length; index++) {
                    appendTreeLines(
                        parts[index],
                        `${prefix}${childPrefix}`,
                        index === parts.length - 1,
                        commandDecisionMap,
                        commandContextMap,
                        hookCwd,
                        lines
                    );
                }
                if (!isLast) {
                    lines.push(`${prefix}│`);
                }
                return;
            }
        }
    }

    if (!node.children) {
        lines.push(`${prefix}${connector}${truncateLabel(node.source, 80)}`);
        appendOutcomeLines(
            commandDecisionMap.get(node.source),
            commandContextMap.get(node.source),
            hookCwd,
            prefix,
            isLast,
            lines
        );
        if (!isLast) {
            lines.push(`${prefix}│`);
        }
        return;
    }

    lines.push(`${prefix}${connector}${truncateLabel(node.source, 80)}`);
    const children = childNodes(node);
    for (let index = 0; index < children.length; index++) {
        appendTreeLines(
            children[index],
            `${prefix}${childPrefix}`,
            index === children.length - 1,
            commandDecisionMap,
            commandContextMap,
            hookCwd,
            lines
        );
    }
    if (!isLast) {
        lines.push(`${prefix}│`);
    }
}

// formatPendingPromptTree renders the sub-command ASCII tree block content.
export function formatPendingPromptTree(
    root: IAstNode,
    commandDecisionMap: Map<string, ICommandDecision>,
    commandContextMap: Map<string, ICommandContext>,
    hookCwd: string
): string {
    const lines: string[] = [];
    lines.push(truncateLabel(root.source, 80));

    const displayRoot = root.type === "bash"
        ? (root as BashAstNode).children.command
        : root;

    if (displayRoot.type === "binop") {
        const binop = displayRoot as BinopAstNode;
        if (binop.op === "&&" || binop.op === ";") {
            const parts = flattenSequential(displayRoot);
            for (let index = 0; index < parts.length; index++) {
                appendTreeLines(
                    parts[index],
                    "",
                    index === parts.length - 1,
                    commandDecisionMap,
                    commandContextMap,
                    hookCwd,
                    lines
                );
            }
            return lines.join("\n");
        }
    }

    appendTreeLines(displayRoot, "", true, commandDecisionMap, commandContextMap, hookCwd, lines);
    return lines.join("\n");
}

// decisionPriority returns a numeric rank for picking the strictest command outcome.
function decisionPriority(decision: string): number {
    if (decision === "DENY") {
        return 3;
    }
    if (decision === "ASK" || decision === "NOMATCH") {
        return 2;
    }
    return 1;
}

// sourceLabelForOutcome maps an outcome source to the verdict parenthetical text.
function sourceLabelForOutcome(outcome: ICommandDecision): string {
    if (outcome.source === "no-rule-match") {
        return "no rule matched";
    }
    if (outcome.source === "deny-rule") {
        return "deny rule";
    }
    return "matched rule";
}

// resolveVerdictTrigger finds the strictest command that drove the final decision.
export function resolveVerdictTrigger(
    commandDecisionMap: Map<string, ICommandDecision>,
    commandContextMap: Map<string, ICommandContext>,
    root: IAstNode,
    hookCwd: string,
    decisionReason: string | undefined
): IVerdictTrigger {
    let bestCmd = root.source;
    let bestOutcome: ICommandDecision | undefined = commandDecisionMap.get(bestCmd);
    let bestPriority = bestOutcome !== undefined ? decisionPriority(bestOutcome.decision) : 0;

    for (const [cmd, outcome] of commandDecisionMap.entries()) {
        const priority = decisionPriority(outcome.decision);
        if (priority > bestPriority) {
            bestPriority = priority;
            bestCmd = cmd;
            bestOutcome = outcome;
        }
    }

    let reason = decisionReason;
    if (bestOutcome !== undefined && bestOutcome.reason !== undefined) {
        reason = bestOutcome.reason;
    }

    const commandContext = commandContextMap.get(bestCmd);
    let cwd: string | undefined;
    if (commandContext !== undefined && commandContext.cwd !== hookCwd) {
        cwd = commandContext.cwd;
    }

    let env: Record<string, string> | undefined;
    if (commandContext !== undefined && Object.keys(commandContext.env).length > 0) {
        env = commandContext.env;
    }

    const sourceLabel = bestOutcome !== undefined ? sourceLabelForOutcome(bestOutcome) : "no rule matched";

    return {
        cmd: bestCmd,
        sourceLabel,
        reason,
        cwd,
        env,
        outcome: bestOutcome,
    };
}

// formatContextBlock renders the Context section body with hook cwd and hook-time env vars.
export function formatContextBlock(call: IToolCall, context0: IContext): string {
    const envKeys = Object.keys(context0.env).sort();
    if (envKeys.length === 0) {
        return call.cwd;
    }

    const lines = [call.cwd, ""];
    for (const key of envKeys) {
        lines.push(`${key}=${context0.env[key]}`);
    }
    return lines.join("\n");
}

// appendVerdictOutcomeLines appends labeled decision/rule/reason lines for one outcome.
function appendVerdictOutcomeLines(lines: string[], outcome: ICommandDecision | undefined): void {
    if (outcome === undefined) {
        return;
    }

    lines.push(`decision: ${outcome.decision}`);
    const ruleLine = formatRuleLine(outcome);
    if (ruleLine !== undefined) {
        lines.push(ruleLine);
    }
    if (outcome.reason !== undefined && outcome.reason !== "") {
        lines.push(`reason: "${outcome.reason}"`);
    }
}

// formatVerdictBlock renders the Verdict fenced block content.
function formatVerdictBlock(trigger: IVerdictTrigger, decision: string, hookCwd: string): string {
    const lines: string[] = [];
    lines.push(`decision: ${decision.toUpperCase()}`);
    lines.push(`source: ${trigger.sourceLabel}`);

    if (trigger.outcome !== undefined && trigger.outcome.source !== "no-rule-match") {
        const ruleLine = formatRuleLine(trigger.outcome);
        if (ruleLine !== undefined) {
            lines.push(ruleLine);
        }
    }

    if (trigger.reason !== undefined && trigger.reason !== "") {
        lines.push(`reason: "${trigger.reason}"`);
    }

    lines.push(`project directory: ${hookCwd}`);
    lines.push("");
    lines.push(`cmd: ${trigger.cmd}`);

    if (trigger.cwd !== undefined) {
        lines.push(`command directory: ${trigger.cwd}`);
    }

    if (trigger.env !== undefined) {
        lines.push(`env: ${formatEnvSummary(trigger.env)}`);
    }

    appendVerdictOutcomeLines(lines, trigger.outcome);
    return lines.join("\n");
}

// formatPendingPromptMarkdown builds the full pending approval detail file.
export async function formatPendingPromptMarkdown(
    call: IToolCall,
    root: IAstNode,
    commandOutcomes: ICommandOutcome[],
    decision: string,
    reason: string | undefined,
    pendingSince: Date
): Promise<string> {
    const context0: IContext = {
        cwd: call.cwd,
        cwdResolved: true,
        env: {},
    };
    const commandDecisionMap = buildCommandDecisionMap(commandOutcomes);
    const commandContextMap = buildCommandContextMap(commandOutcomes);
    const treeBlock = formatPendingPromptTree(root, commandDecisionMap, commandContextMap, call.cwd);
    const trigger = resolveVerdictTrigger(commandDecisionMap, commandContextMap, root, call.cwd, reason);
    const contextBlock = formatContextBlock(call, context0);

    const sections: string[] = [];
    sections.push(`# ${call.tool_name} — ${decision.toUpperCase()}`);
    sections.push("");
    sections.push(`Pending since ${formatLocalTimestamp(pendingSince)}`);
    sections.push("");
    sections.push("## Verdict");
    sections.push("");
    sections.push("```");
    sections.push(formatVerdictBlock(trigger, decision, call.cwd));
    sections.push("```");
    sections.push("");
    sections.push("## Command");
    sections.push("");
    sections.push("```");
    sections.push(summarizeToolInput(call));
    sections.push("```");
    sections.push("");
    sections.push("## Context");
    sections.push("");
    sections.push(contextBlock);
    sections.push("");
    sections.push("## Parsed command tree");
    sections.push("");
    sections.push("```");
    sections.push(treeBlock);
    sections.push("```");
    sections.push("");

    return sections.join("\n");
}

// writePendingPrompt writes a dated pending detail file for an ask decision.
export async function writePendingPrompt(
    projectDir: string,
    call: IToolCall,
    root: IAstNode,
    commandOutcomes: ICommandOutcome[],
    decision: string,
    reason: string | undefined,
    pendingSince: Date
): Promise<void> {
    const pendingDir = resolvePendingDir(projectDir);
    await mkdir(pendingDir, { recursive: true });
    const baseFileName = buildPendingPromptFileName(call, pendingSince);
    const filePath = await resolvePendingPromptFilePath(pendingDir, baseFileName);
    const content = await formatPendingPromptMarkdown(
        call,
        root,
        commandOutcomes,
        decision,
        reason,
        pendingSince
    );
    await writeFile(filePath, content, "utf-8");
}

// cleanupStalePendingPrompts removes pending detail files older than maxAgeDays.
export async function cleanupStalePendingPrompts(projectDir: string, now: Date, maxAgeDays: number): Promise<void> {
    const pendingDir = resolvePendingDir(projectDir);
    let fileNames: string[];
    try {
        fileNames = await readdir(pendingDir);
    }
    catch {
        return;
    }

    const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;

    for (const fileName of fileNames) {
        if (!fileName.endsWith(".md")) {
            continue;
        }
        const filePath = join(pendingDir, fileName);
        const fileStat = await stat(filePath);
        const ageMs = now.getTime() - fileStat.mtimeMs;
        if (ageMs > maxAgeMs) {
            await unlink(filePath);
        }
    }
}
