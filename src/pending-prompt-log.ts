import { createHash } from "crypto";
import { access, mkdir, readdir, stat, unlink, writeFile } from "fs/promises";
import { join } from "path";
import { describeNode } from "./build-ast";
import { ILeafEvaluation, isLeaf } from "./interpret";
import { cdRule } from "./rules/builtin/cd";
import { envPrefixRule } from "./rules/builtin/env-prefix";
import { envSetRule } from "./rules/builtin/env-set";
import { exportRule } from "./rules/builtin/export";
import {
    AstNode,
    IBinOp,
    IEnvironment,
    IPostToolUseCall,
    IToolCall,
} from "./types";

// ILeafOutcomeSource identifies why a leaf received its decision label.
export type ILeafOutcomeSource = "matched-rule" | "no-rule-match" | "deny-rule";

// ILeafOutcome holds the permission label and rule attribution for one leaf sub-command.
export interface ILeafOutcome {
    // Uppercase decision label: ALLOW, DENY, ASK, or NOMATCH.
    decision: string;
    // Source file of the matched rule, when present.
    ruleFile?: string;
    // 1-based line number in ruleFile, when present.
    ruleLine?: number;
    // Human-readable reason from the rule or trace entry.
    reason?: string;
    // Why this outcome was assigned.
    source?: ILeafOutcomeSource;
}

// ILeafContext holds simulated cwd and env at the point a leaf command runs.
export interface ILeafContext {
    // Effective working directory when the leaf executes.
    cwd: string;
    // Environment variables visible to the leaf.
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
    // Environment variables visible at the trigger leaf, when non-empty.
    env: Record<string, string> | undefined;
    // Outcome recorded for the trigger leaf.
    outcome: ILeafOutcome | undefined;
}

// EMPTY_TOOL_CALL is a placeholder for builtin rule invocations during env simulation.
const EMPTY_TOOL_CALL: IToolCall = {
    tool_name: "Bash",
    tool_input: { command: "" },
    cwd: "/",
};

// resolvePendingDir returns the directory for pending approval detail files.
export function resolvePendingDir(projectDir: string): string {
    return join(projectDir, ".claude", "permissions-log", "pending");
}

// computePendingPromptKey returns a stable filename key for a tool call.
export function computePendingPromptKey(call: IToolCall | IPostToolUseCall): string {
    const payload = JSON.stringify({
        tool_name: call.tool_name,
        tool_input: call.tool_input,
        cwd: call.cwd,
    });
    return createHash("sha256").update(payload).digest("hex").slice(0, 16);
}

// summarizeToolInput extracts a single-line summary from a tool call input.
function summarizeToolInput(call: IToolCall | IPostToolUseCall): string {
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

// buildLeafOutcomeMap indexes leaf outcomes from evaluation records collected during interpret.
export function buildLeafOutcomeMap(evaluations: ILeafEvaluation[]): Map<string, ILeafOutcome> {
    const outcomeMap = new Map<string, ILeafOutcome>();

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

// applyLeafEnvEffects returns the leaf execution context and env after built-in env/cd updates.
function applyLeafEnvEffects(node: AstNode, env: IEnvironment): { leafContext: ILeafContext; envOut: IEnvironment } {
    let runningEnv = env;
    const prefixOutcome = envPrefixRule(node, env, EMPTY_TOOL_CALL);
    if (prefixOutcome.scopedEnv !== undefined) {
        runningEnv = prefixOutcome.scopedEnv;
    }

    const leafContext: ILeafContext = {
        cwd: runningEnv.cwd,
        env: { ...runningEnv.env },
    };

    let envOut = runningEnv;
    const cdOutcome = cdRule(node, runningEnv, EMPTY_TOOL_CALL);
    if (cdOutcome.env !== undefined) {
        envOut = cdOutcome.env;
    }
    const setOutcome = envSetRule(node, runningEnv, EMPTY_TOOL_CALL);
    if (setOutcome.env !== undefined) {
        envOut = setOutcome.env;
    }
    const exportOutcome = exportRule(node, runningEnv, EMPTY_TOOL_CALL);
    if (exportOutcome.env !== undefined) {
        envOut = exportOutcome.env;
    }

    return { leafContext, envOut };
}

// simWalkEnv walks the AST threading environment the same way interpret does, recording leaf contexts.
function simWalkEnv(node: AstNode, env: IEnvironment, leafContextMap: Map<string, ILeafContext>): IEnvironment {
    if (isLeaf(node)) {
        const { leafContext, envOut } = applyLeafEnvEffects(node, env);
        leafContextMap.set(describeNode(node), leafContext);
        return envOut;
    }

    if (node.type === "bash") {
        return simWalkEnv(node.ast, env, leafContextMap);
    }

    if (node.type === "xargs") {
        return simWalkEnv(node.child, env, leafContextMap);
    }

    if (node.type === "for_loop") {
        let lastEnv = env;
        for (const item of node.items) {
            const iterEnv: IEnvironment = {
                ...env,
                env: { ...env.env, [node.variable]: item },
            };
            lastEnv = simWalkEnv(node.body, iterEnv, leafContextMap);
        }
        return env;
    }

    if (node.type === "while_loop") {
        const conditionEnv = simWalkEnv(node.condition, env, leafContextMap);
        simWalkEnv(node.body, conditionEnv, leafContextMap);
        return conditionEnv;
    }

    if (node.type === "group") {
        const bodyEnv = simWalkEnv(node.body, env, leafContextMap);
        if (node.style === "brace") {
            return bodyEnv;
        }
        return env;
    }

    if (node.type === "case_statement") {
        for (const clause of node.clauses) {
            simWalkEnv(clause.body, env, leafContextMap);
        }
        return env;
    }

    if (node.type === "if_statement") {
        const conditionEnv = simWalkEnv(node.condition, env, leafContextMap);
        simWalkEnv(node.thenBranch, conditionEnv, leafContextMap);
        if (node.elseBranch !== undefined) {
            simWalkEnv(node.elseBranch, conditionEnv, leafContextMap);
        }
        return conditionEnv;
    }

    const binop = node as IBinOp;

    if (binop.op === ";" || binop.op === "&&") {
        const leftEnv = simWalkEnv(binop.left, env, leafContextMap);
        return simWalkEnv(binop.right, leftEnv, leafContextMap);
    }

    simWalkEnv(binop.left, env, leafContextMap);
    simWalkEnv(binop.right, env, leafContextMap);
    return env;
}

// simulateLeafEnvironments returns effective cwd/env for each leaf keyed by describeNode output.
export function simulateLeafEnvironments(root: AstNode, env0: IEnvironment): Map<string, ILeafContext> {
    const leafContextMap = new Map<string, ILeafContext>();
    simWalkEnv(root, env0, leafContextMap);
    return leafContextMap;
}

// flattenSequential expands && and ; chains into an ordered leaf list.
function flattenSequential(node: AstNode): AstNode[] {
    if (node.type === "binop" && (node.op === "&&" || node.op === ";")) {
        return [...flattenSequential(node.left), ...flattenSequential(node.right)];
    }
    if (node.type === "bash") {
        return flattenSequential(node.ast);
    }
    if (isLeaf(node)) {
        return [node];
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
function formatRuleLine(outcome: ILeafOutcome): string | undefined {
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
    outcome: ILeafOutcome | undefined,
    leafContext: ILeafContext | undefined,
    hookCwd: string,
    prefix: string,
    isLast: boolean,
    lines: string[]
): void {
    lines.push(`${prefix}│`);
    const indent = outcomeIndent(prefix, isLast);

    if (leafContext !== undefined && leafContext.cwd !== hookCwd) {
        lines.push(`${indent}cwd: ${leafContext.cwd}`);
    }

    if (leafContext !== undefined && Object.keys(leafContext.env).length > 0) {
        lines.push(`${indent}env: ${formatEnvSummary(leafContext.env)}`);
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
    node: AstNode,
    prefix: string,
    isLast: boolean,
    leafOutcomeMap: Map<string, ILeafOutcome>,
    leafContextMap: Map<string, ILeafContext>,
    hookCwd: string,
    lines: string[]
): void {
    const connector = isLast ? "└── " : "├── ";
    const childPrefix = isLast ? "    " : "│   ";

    if (node.type === "bash") {
        appendTreeLines(node.ast, prefix, isLast, leafOutcomeMap, leafContextMap, hookCwd, lines);
        return;
    }

    if (node.type === "xargs") {
        appendTreeLines(node.child, prefix, isLast, leafOutcomeMap, leafContextMap, hookCwd, lines);
        return;
    }

    if (node.type === "while_loop") {
        lines.push(`${prefix}${connector}${truncateLabel(describeNode(node), 80)}`);
        appendTreeLines(node.body, `${prefix}${childPrefix}`, isLast, leafOutcomeMap, leafContextMap, hookCwd, lines);
        if (!isLast) {
            lines.push(`${prefix}│`);
        }
        return;
    }

    if (node.type === "if_statement") {
        lines.push(`${prefix}${connector}${truncateLabel(describeNode(node), 80)}`);
        const hasElseBranch = node.elseBranch !== undefined;
        appendTreeLines(node.thenBranch, `${prefix}${childPrefix}`, !hasElseBranch && isLast, leafOutcomeMap, leafContextMap, hookCwd, lines);
        const elseBranch = node.elseBranch;
        if (elseBranch !== undefined) {
            appendTreeLines(elseBranch, `${prefix}${childPrefix}`, isLast, leafOutcomeMap, leafContextMap, hookCwd, lines);
        }
        if (!isLast) {
            lines.push(`${prefix}│`);
        }
        return;
    }

    if (node.type === "group") {
        lines.push(`${prefix}${connector}${truncateLabel(describeNode(node), 80)}`);
        appendTreeLines(node.body, `${prefix}${childPrefix}`, isLast, leafOutcomeMap, leafContextMap, hookCwd, lines);
        if (!isLast) {
            lines.push(`${prefix}│`);
        }
        return;
    }

    if (node.type === "binop" && node.op !== "&&" && node.op !== ";") {
        renderCompoundTree(node, prefix, isLast, leafOutcomeMap, leafContextMap, hookCwd, lines);
        return;
    }

    if (node.type === "binop" && (node.op === "&&" || node.op === ";")) {
        const parts = flattenSequential(node);
        if (parts.length > 1) {
            lines.push(`${prefix}${connector}${truncateLabel(describeNode(node), 80)}`);
            for (let index = 0; index < parts.length; index++) {
                appendTreeLines(parts[index], `${prefix}${childPrefix}`, index === parts.length - 1, leafOutcomeMap, leafContextMap, hookCwd, lines);
            }
            if (!isLast) {
                lines.push(`${prefix}│`);
            }
            return;
        }
    }

    if (isLeaf(node)) {
        lines.push(`${prefix}${connector}${truncateLabel(describeNode(node), 80)}`);
        const cmd = describeNode(node);
        appendOutcomeLines(
            leafOutcomeMap.get(cmd),
            leafContextMap.get(cmd),
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

    renderCompoundTree(node, prefix, isLast, leafOutcomeMap, leafContextMap, hookCwd, lines);
}

// renderCompoundTree renders pipe and other binary nodes with left/right children.
function renderCompoundTree(
    node: AstNode,
    prefix: string,
    isLast: boolean,
    leafOutcomeMap: Map<string, ILeafOutcome>,
    leafContextMap: Map<string, ILeafContext>,
    hookCwd: string,
    lines: string[]
): void {
    const connector = isLast ? "└── " : "├── ";
    const childPrefix = isLast ? "    " : "│   ";
    lines.push(`${prefix}${connector}${truncateLabel(describeNode(node), 80)}`);

    if (node.type === "binop") {
        appendTreeLines(node.left, `${prefix}${childPrefix}`, false, leafOutcomeMap, leafContextMap, hookCwd, lines);
        appendTreeLines(node.right, `${prefix}${childPrefix}`, true, leafOutcomeMap, leafContextMap, hookCwd, lines);
        if (!isLast) {
            lines.push(`${prefix}│`);
        }
        return;
    }

    if (node.type === "while_loop") {
        appendTreeLines(node.body, `${prefix}${childPrefix}`, true, leafOutcomeMap, leafContextMap, hookCwd, lines);
        return;
    }

    if (node.type === "if_statement") {
        const hasElseBranch = node.elseBranch !== undefined;
        appendTreeLines(node.thenBranch, `${prefix}${childPrefix}`, !hasElseBranch, leafOutcomeMap, leafContextMap, hookCwd, lines);
        const elseBranch = node.elseBranch;
        if (elseBranch !== undefined) {
            appendTreeLines(elseBranch, `${prefix}${childPrefix}`, true, leafOutcomeMap, leafContextMap, hookCwd, lines);
        }
        return;
    }

    if (node.type === "group") {
        appendTreeLines(node.body, `${prefix}${childPrefix}`, true, leafOutcomeMap, leafContextMap, hookCwd, lines);
        return;
    }

    if (node.type === "bash") {
        appendTreeLines(node.ast, `${prefix}${childPrefix}`, true, leafOutcomeMap, leafContextMap, hookCwd, lines);
    }
}

// formatPendingPromptTree renders the sub-command ASCII tree block content.
export function formatPendingPromptTree(
    root: AstNode,
    leafOutcomeMap: Map<string, ILeafOutcome>,
    leafContextMap: Map<string, ILeafContext>,
    hookCwd: string
): string {
    const lines: string[] = [];
    lines.push(truncateLabel(describeNode(root), 80));

    if (root.type === "binop" && (root.op === "&&" || root.op === ";")) {
        const parts = flattenSequential(root);
        for (let index = 0; index < parts.length; index++) {
            appendTreeLines(parts[index], "", index === parts.length - 1, leafOutcomeMap, leafContextMap, hookCwd, lines);
        }
    }
    else if (root.type === "binop") {
        renderCompoundTree(root, "", true, leafOutcomeMap, leafContextMap, hookCwd, lines);
    }
    else {
        appendTreeLines(root, "", true, leafOutcomeMap, leafContextMap, hookCwd, lines);
    }

    return lines.join("\n");
}

// decisionPriority returns a numeric rank for picking the strictest leaf outcome.
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
function sourceLabelForOutcome(outcome: ILeafOutcome): string {
    if (outcome.source === "no-rule-match") {
        return "no rule matched";
    }
    if (outcome.source === "deny-rule") {
        return "deny rule";
    }
    return "matched rule";
}

// resolveVerdictTrigger finds the strictest leaf that drove the final decision.
export function resolveVerdictTrigger(
    leafOutcomeMap: Map<string, ILeafOutcome>,
    leafContextMap: Map<string, ILeafContext>,
    root: AstNode,
    hookCwd: string,
    decisionReason: string | undefined
): IVerdictTrigger {
    let bestCmd = describeNode(root);
    let bestOutcome: ILeafOutcome | undefined = leafOutcomeMap.get(bestCmd);
    let bestPriority = bestOutcome !== undefined ? decisionPriority(bestOutcome.decision) : 0;

    for (const [cmd, outcome] of leafOutcomeMap.entries()) {
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

    const leafContext = leafContextMap.get(bestCmd);
    let cwd: string | undefined;
    if (leafContext !== undefined && leafContext.cwd !== hookCwd) {
        cwd = leafContext.cwd;
    }

    let env: Record<string, string> | undefined;
    if (leafContext !== undefined && Object.keys(leafContext.env).length > 0) {
        env = leafContext.env;
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
export function formatContextBlock(call: IToolCall, env0: IEnvironment): string {
    const envKeys = Object.keys(env0.env).sort();
    if (envKeys.length === 0) {
        return call.cwd;
    }

    const lines = [call.cwd, ""];
    for (const key of envKeys) {
        lines.push(`${key}=${env0.env[key]}`);
    }
    return lines.join("\n");
}

// appendVerdictOutcomeLines appends labeled decision/rule/reason lines for one outcome.
function appendVerdictOutcomeLines(lines: string[], outcome: ILeafOutcome | undefined): void {
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
export function formatPendingPromptMarkdown(
    call: IToolCall,
    root: AstNode,
    leafEvaluations: ILeafEvaluation[],
    decision: string,
    reason: string | undefined,
    pendingSince: Date
): string {
    const env0: IEnvironment = {
        cwd: call.cwd,
        cwdResolved: true,
        env: {},
    };
    const leafOutcomeMap = buildLeafOutcomeMap(leafEvaluations);
    const leafContextMap = simulateLeafEnvironments(root, env0);
    const treeBlock = formatPendingPromptTree(root, leafOutcomeMap, leafContextMap, call.cwd);
    const trigger = resolveVerdictTrigger(leafOutcomeMap, leafContextMap, root, call.cwd, reason);
    const contextBlock = formatContextBlock(call, env0);

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

// writePendingPrompt writes pending/<key>.md for an ask decision.
export async function writePendingPrompt(
    projectDir: string,
    call: IToolCall,
    root: AstNode,
    leafEvaluations: ILeafEvaluation[],
    decision: string,
    reason: string | undefined,
    pendingSince: Date
): Promise<void> {
    const pendingDir = resolvePendingDir(projectDir);
    await mkdir(pendingDir, { recursive: true });
    const key = computePendingPromptKey(call);
    const filePath = join(pendingDir, `${key}.md`);
    const content = formatPendingPromptMarkdown(call, root, leafEvaluations, decision, reason, pendingSince);
    await writeFile(filePath, content, "utf-8");
}

// removePendingPrompt deletes pending/<key>.md when the tool executes.
export async function removePendingPrompt(projectDir: string, call: IPostToolUseCall): Promise<void> {
    const pendingDir = resolvePendingDir(projectDir);
    const key = computePendingPromptKey(call);
    const filePath = join(pendingDir, `${key}.md`);
    try {
        await access(filePath);
    }
    catch {
        return;
    }
    await unlink(filePath);
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
