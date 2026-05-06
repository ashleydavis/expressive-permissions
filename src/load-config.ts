import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { parse } from "yaml";
import picomatch from "picomatch";
import { Rule, RuleOutcome, AstNode, Environment, ToolCall, ABSTAIN, Decision, Command } from "./types";

// Valid decide values in YAML config
type DecideValue = "allow" | "deny" | "ask" | "abstain";

// Union of all possible values within a YAML entry
type IEntryValue = string | boolean | string[] | Record<string, string> | IYamlEntry | IYamlEntry[] | INotFields;

// Describes a file content match: the file must exist and contain the given substring.
export interface IFileMatch {
    // Substring that must appear somewhere in the file's contents
    contains: string;
}

// Inverted match block: rule fires only when all enclosed fields do NOT all match simultaneously.
// Excludes decision/meta fields (decide, reason, rules) and tool-specific fields (host, tool).
export interface INotFields {
    // Positional arg matcher (same semantics as IYamlEntry.cmd)
    cmd?: string | string[];
    // OR form of cmd
    "cmd-in"?: string[];
    // Flag matcher (same semantics as IYamlEntry.options)
    options?: string[] | Record<string, string | boolean>;
    // OR form of options
    "options-in"?: string[];
    // Glob or regex pattern matched against env.cwd
    cwd?: string;
    // OR form of cwd
    "cwd-in"?: string[];
    // Map of env var name -> glob pattern; all must match
    env?: Record<string, string>;
    // Glob pattern matched against node.file_path (file tool nodes only)
    path?: string;
    // OR form of path
    "path-in"?: string[];
    // Map of file path → IFileMatch (or true for existence-only); all must match
    file?: Record<string, IFileMatch | true>;
}

// A YAML rule entry with optional matcher fields, a decide outcome, and optional subcommand keys
export interface IYamlEntry {
    // The decision to return when this entry matches
    decide?: string;
    // Positional arg matcher (cmd): string is split on whitespace, each token matches cmd[cmdOffset+i] in order (AND); array matches cmd[cmdOffset+i] per index (AND)
    cmd?: string | string[];
    // OR form of cmd: any positional from cmdOffset onwards matches any listed pattern
    "cmd-in"?: string[];
    // Flag matcher: all listed flag alias groups must be present (AND); object values may be string patterns or boolean true (presence check)
    options?: string[] | Record<string, string | boolean>;
    // OR form of options: any listed flag alias group must be present
    "options-in"?: string[];
    // Glob pattern matched against env.cwd
    cwd?: string;
    // OR form of cwd: cwd matches any listed pattern
    "cwd-in"?: string[];
    // When true/false, restricts match to resolved/unresolved cwd; omit to match either
    cwd_resolved?: boolean;
    // Map of env var name → glob pattern; all must match
    env?: Record<string, string>;
    // Glob pattern matched against node.file_path (read/write/edit/multiedit rules)
    path?: string;
    // OR form of path: path matches any listed pattern
    "path-in"?: string[];
    // Glob pattern matched against the webfetch URL's hostname
    host?: string;
    // List of hostname globs; OR semantics (webfetch rules)
    "host-in"?: string[];
    // Pattern matched against the MCP tool name
    tool?: string;
    // OR form of tool: tool name matches any listed pattern
    "tool-in"?: string[];
    // Human-readable explanation shown to the user when the rule fires
    reason?: string;
    // Nested sub-rules evaluated when this entry's conditions match (mutually exclusive with decide)
    rules?: IYamlEntry[];
    // Inverted fields block: rule fires only when enclosed fields do NOT all match
    not?: INotFields;
    // Map of file path → IFileMatch (or true for existence-only); all must match for the rule to fire
    file?: Record<string, IFileMatch | true>;
    // Dynamic subcommand keys (any key not in KNOWN_FIELDS)
    [key: string]: IEntryValue | undefined;
}

// Top-level structure of the permissions YAML file
export interface IYamlConfig {
    // Bash tool rules keyed by binary name
    bash?: Record<string, IYamlEntry | IYamlEntry[]>;
    // Read tool rules
    read?: IYamlEntry | IYamlEntry[];
    // Write tool rules
    write?: IYamlEntry | IYamlEntry[];
    // Edit tool rules
    edit?: IYamlEntry | IYamlEntry[];
    // MultiEdit tool rules
    multi_edit?: IYamlEntry | IYamlEntry[];
    // WebFetch tool rules
    webfetch?: IYamlEntry | IYamlEntry[];
    // MCP tool rules
    mcp?: IYamlEntry | IYamlEntry[];
}

// Fields that are matcher/control fields and NOT subcommand keys
const KNOWN_FIELDS = new Set(["decide", "reason", "rules", "not", "file", "cmd", "cmd-in", "options", "options-in", "cwd", "cwd-in", "cwd_resolved", "env", "path", "path-in", "host", "host-in", "tool", "tool-in"]);

// All accepted values for the decide field
const VALID_DECIDE_VALUES = new Set<string>(["allow", "deny", "ask", "abstain"]);

// A single validation problem found while inspecting a permissions YAML config.
export interface IConfigError {
    // Dot-path to the offending key (e.g. "bash.git.remote.decide").
    path: string;
    // Human-readable description of what is wrong and how to fix it.
    message: string;
}

// Normalises a YAML section value: plain object → single-entry list; array → as-is
function normalizeToList(value: IYamlEntry | IYamlEntry[]): IYamlEntry[] {
    if (Array.isArray(value)) {
        return value;
    }
    return [value];
}

// Converts a DecideValue string to the typed Decision object, forwarding reason to deny/ask decisions
function mapDecision(decide: DecideValue, reason?: string): Decision {
    if (decide === "allow") {
        return { action: "allow", reason };
    }
    if (decide === "deny") {
        return { action: "deny", reason };
    }
    if (decide === "abstain") {
        return { action: "abstain" };
    }
    return { action: "ask", reason };
}

// Returns true when value matches the picomatch pattern.
// For patterns ending in "/**", the base directory itself is excluded (must be a strict child).
function matchesGlob(pattern: string, value: string): boolean {
    if (pattern.endsWith("/**") && value === pattern.slice(0, -3)) {
        return false;
    }
    return picomatch(pattern)(value);
}

// Matches value against pattern: dispatches to RegExp for /.../ patterns, otherwise calls picomatch.
function matchesPattern(pattern: string, value: string): boolean {
    if (pattern.length >= 2 && pattern.startsWith("/") && pattern.endsWith("/")) {
        return new RegExp(pattern.slice(1, -1)).test(value);
    }
    return matchesGlob(pattern, value);
}

// Returns true when env.cwd matches the cwd/cwd-in entry fields
function matchesCwd(entry: IYamlEntry, env: Environment): boolean {
    if (entry["cwd-in"] !== undefined) {
        return entry["cwd-in"].some((pattern: string) => matchesPattern(pattern, env.cwd));
    }
    if (entry.cwd !== undefined) {
        return matchesPattern(entry.cwd, env.cwd);
    }
    return true;
}

// Returns true when env.cwdResolved matches the cwd_resolved entry field; omitting matches either
function matchesCwdResolved(entry: IYamlEntry, env: Environment): boolean {
    if (entry.cwd_resolved === undefined) {
        return true;
    }
    return entry.cwd_resolved === env.cwdResolved;
}

// Expands ~ to the home directory and resolves relative paths against CLAUDE_PROJECT_DIR (falling back to cwd).
function homePath(rawPath: string): string {
    if (rawPath.startsWith("~")) {
        return homedir() + rawPath.slice(1);
    }
    if (!rawPath.startsWith("/")) {
        const projectDir = process.env["CLAUDE_PROJECT_DIR"] ?? process.cwd();
        return join(projectDir, rawPath);
    }
    return rawPath;
}

// Evaluates a file: field map; returns "match" when all entries pass, "file-absent" if any file is missing,
// or "no-match" if a file exists but its contents do not satisfy the contains check.
export function evaluateFileField(file: Record<string, IFileMatch | true>): "match" | "no-match" | "file-absent" {
    for (const [rawPath, fileMatch] of Object.entries(file)) {
        const expandedPath = homePath(rawPath);
        if (!existsSync(expandedPath)) {
            return "file-absent";
        }
        if (fileMatch === true) {
            continue;
        }
        const content = readFileSync(expandedPath, "utf8");
        if (!content.includes(fileMatch.contains)) {
            return "no-match";
        }
    }
    return "match";
}

// Returns true when the entry's file: field is absent or all its checks pass.
export function matchesFileField(entry: IYamlEntry): boolean {
    if (entry.file === undefined) {
        return true;
    }
    return evaluateFileField(entry.file) === "match";
}

// Returns true when all env var patterns in the entry match the current environment vars
function matchesEnvVars(entry: IYamlEntry, env: Environment): boolean {
    if (entry.env === undefined) {
        return true;
    }
    for (const [varName, pattern] of Object.entries(entry.env)) {
        const actualValue = env.env[varName];
        if (actualValue === undefined) {
            return false;
        }
        if (!matchesPattern(pattern, actualValue)) {
            return false;
        }
    }
    return true;
}

// Expands an alias expression like "r|recursive" into all alias strings
function expandAliases(aliasExpr: string): string[] {
    return aliasExpr.split("|");
}

// Returns true when any alias in the aliasExpr is present as a key in namedOptions
function flagPresent(aliasExpr: string, namedOptions: Record<string, string | boolean>): boolean {
    return expandAliases(aliasExpr).some((alias: string) => alias in namedOptions);
}

// Returns the value of the first matching alias key in namedOptions, or undefined if none found
function flagValue(aliasExpr: string, namedOptions: Record<string, string | boolean>): string | boolean | undefined {
    for (const alias of expandAliases(aliasExpr)) {
        if (alias in namedOptions) {
            return namedOptions[alias];
        }
    }
    return undefined;
}

// Returns true when the options/options-in entry fields match the given Command node's flags
function matchesOptions(entry: IYamlEntry, node: Command): boolean {
    if (entry["options-in"] !== undefined) {
        return entry["options-in"].some((aliasExpr: string) => flagPresent(aliasExpr, node.options));
    }

    if (entry.options === undefined) {
        return true;
    }

    if (Array.isArray(entry.options)) {
        // All listed flags must be present (AND semantics)
        return entry.options.every((aliasExpr: string) => flagPresent(aliasExpr, node.options));
    }

    // Object: flag-value matching; all keys must match their value pattern (or boolean true means presence check)
    for (const [aliasExpr, pattern] of Object.entries(entry.options)) {
        if (typeof pattern !== "string") {
            if (!flagPresent(aliasExpr, node.options)) {
                return false;
            }
        }
        else {
            const val = flagValue(aliasExpr, node.options);
            if (val === undefined) {
                return false;
            }
            if (typeof val !== "string") {
                return false;
            }
            if (!matchesPattern(pattern, val)) {
                return false;
            }
        }
    }
    return true;
}

// Returns true when the cmd/cmd-in entry fields match the positional arguments at the given offset
function matchesCmd(entry: IYamlEntry, node: Command, cmdOffset: number): boolean {
    const cmdArray = Array.isArray(node.cmd) ? node.cmd : [node.cmd];

    if (entry["cmd-in"] !== undefined) {
        const slice = cmdArray.slice(cmdOffset);
        return entry["cmd-in"].some((pattern: string) =>
            slice.some((positional: string) => matchesPattern(pattern, positional))
        );
    }

    if (entry.cmd !== undefined) {
        // Normalise to an array: an array is used as-is; a string is split on whitespace
        // so "* describe-*" matches cmd[offset] against "*" and cmd[offset+1] against "describe-*".
        const patterns: string[] = Array.isArray(entry.cmd)
            ? entry.cmd
            : (entry.cmd as string).trim().split(/\s+/);

        for (let idx = 0; idx < patterns.length; idx++) {
            const target = cmdArray[cmdOffset + idx];
            if (target === undefined) {
                return false;
            }
            if (!matchesPattern(patterns[idx], target)) {
                return false;
            }
        }
        return true;
    }

    return true;
}

// Strictest-wins aggregation: deny > ask > allow > abstain
export function aggregateOutcomes(firstOutcome: RuleOutcome, secondOutcome: RuleOutcome): RuleOutcome {
    const firstAction = firstOutcome.decision.action;
    const secondAction = secondOutcome.decision.action;
    if (firstAction === "deny") {
        return firstOutcome;
    }
    if (secondAction === "deny") {
        return secondOutcome;
    }
    if (firstAction === "ask") {
        return firstOutcome;
    }
    if (secondAction === "ask") {
        return secondOutcome;
    }
    if (firstAction === "allow") {
        return firstOutcome;
    }
    if (secondAction === "allow") {
        return secondOutcome;
    }
    return firstOutcome;
}

// Returns true when cmdArray starts with every element of subcommandPath
function matchesSubcommandPath(cmdArray: string[], subcommandPath: string[]): boolean {
    if (cmdArray.length < subcommandPath.length) {
        return false;
    }
    for (let idx = 0; idx < subcommandPath.length; idx++) {
        if (cmdArray[idx] !== subcommandPath[idx]) {
            return false;
        }
    }
    return true;
}

// Compiles one bash rule for a specific binary + subcommand path + entry
function buildBashRule(binary: string, subcommandPath: string[], entry: IYamlEntry): Rule {
    const decision = mapDecision(entry.decide as DecideValue, entry.reason);
    const pathLabel = subcommandPath.length > 0 ? `:${subcommandPath.join(":")}` : "";
    const ruleName = `yaml:${binary}${pathLabel}:${entry.decide}`;
    const cmdOffset = subcommandPath.length;

    const rule: Rule = function(node: AstNode, env: Environment, _call: ToolCall): RuleOutcome {
        if (node.type !== "command") {
            return ABSTAIN;
        }
        if (node.binary !== binary) {
            return ABSTAIN;
        }

        const cmdArray = Array.isArray(node.cmd) ? node.cmd : [node.cmd];

        if (!matchesSubcommandPath(cmdArray, subcommandPath)) {
            return ABSTAIN;
        }
        if (!matchesCmd(entry, node, cmdOffset)) {
            return ABSTAIN;
        }
        if (!matchesOptions(entry, node)) {
            return ABSTAIN;
        }
        if (entry.host !== undefined || entry["host-in"] !== undefined) {
            const urlArg = cmdArray[cmdOffset];
            const hostname = urlArg !== undefined ? extractHost(urlArg) : "";
            if (entry["host-in"] !== undefined) {
                const hostIn = entry["host-in"] as string[];
                if (!hostIn.some((pattern: string) => matchesPattern(pattern, hostname))) {
                    return ABSTAIN;
                }
            }
            else if (entry.host !== undefined) {
                if (!matchesPattern(entry.host, hostname)) {
                    return ABSTAIN;
                }
            }
        }
        if (!matchesCwd(entry, env)) {
            return ABSTAIN;
        }
        if (!matchesCwdResolved(entry, env)) {
            return ABSTAIN;
        }
        if (!matchesEnvVars(entry, env)) {
            return ABSTAIN;
        }
        if (!matchesFileField(entry)) {
            return ABSTAIN;
        }
        if (entry.not !== undefined && notFieldsAllMatch(entry.not, node, env, cmdOffset)) {
            return ABSTAIN;
        }

        return { decision };
    };

    Object.defineProperty(rule, "name", { value: ruleName });
    return rule;
}

// Runs each sub-rule in order, aggregating outcomes strictest-wins; stops early on deny
function runSubRules(subRules: Rule[], node: AstNode, env: Environment, call: ToolCall): RuleOutcome {
    let result: RuleOutcome = ABSTAIN;
    for (const subRule of subRules) {
        const outcome = subRule(node, env, call);
        result = aggregateOutcomes(result, outcome);
        if (result.decision.action === "deny") {
            break;
        }
    }
    return result;
}

// Builds a scoped bash rule: checks parent conditions, then aggregates sub-rules without consuming positionals
export function buildBashScopedRule(binary: string, subcommandPath: string[], entry: IYamlEntry): Rule {
    const subRules = compileBashBinary(binary, entry.rules!, subcommandPath);
    const pathLabel = subcommandPath.length > 0 ? `:${subcommandPath.join(":")}` : "";
    const ruleName = `yaml:${binary}${pathLabel}:scoped`;
    const cmdOffset = subcommandPath.length;

    const rule: Rule = function(node: AstNode, env: Environment, call: ToolCall): RuleOutcome {
        if (node.type !== "command") {
            return ABSTAIN;
        }
        if (node.binary !== binary) {
            return ABSTAIN;
        }

        const cmdArray = Array.isArray(node.cmd) ? node.cmd : [node.cmd];

        if (!matchesSubcommandPath(cmdArray, subcommandPath)) {
            return ABSTAIN;
        }
        if (!matchesCmd(entry, node, cmdOffset)) {
            return ABSTAIN;
        }
        if (!matchesOptions(entry, node)) {
            return ABSTAIN;
        }
        if (!matchesCwd(entry, env)) {
            return ABSTAIN;
        }
        if (!matchesCwdResolved(entry, env)) {
            return ABSTAIN;
        }
        if (!matchesEnvVars(entry, env)) {
            return ABSTAIN;
        }
        if (!matchesFileField(entry)) {
            return ABSTAIN;
        }
        if (entry.not !== undefined && notFieldsAllMatch(entry.not, node, env, cmdOffset)) {
            return ABSTAIN;
        }

        return runSubRules(subRules, node, env, call);
    };

    Object.defineProperty(rule, "name", { value: ruleName });
    return rule;
}

// Recursively compiles all rules for a binary and its subcommand hierarchy
export function compileBashBinary(binary: string, entries: IYamlEntry[], subcommandPath: string[]): Rule[] {
    const compiledRules: Rule[] = [];

    for (const entry of entries) {
        if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
            continue;
        }
        const subcommandKeys = Object.keys(entry).filter((key: string) => !KNOWN_FIELDS.has(key));

        if (entry.rules !== undefined) {
            compiledRules.push(buildBashScopedRule(binary, subcommandPath, entry));
        }
        else if (typeof entry.decide === "string") {
            compiledRules.push(buildBashRule(binary, subcommandPath, entry));
        }

        for (const subKey of subcommandKeys) {
            const subValue = entry[subKey] as IYamlEntry | IYamlEntry[];
            const subEntries = normalizeToList(subValue);
            compiledRules.push(...compileBashBinary(binary, subEntries, [...subcommandPath, subKey]));
        }
    }

    return compiledRules;
}

// Compiles rules for the bash section of the YAML config
function compileBashSection(bashSection: Record<string, IYamlEntry | IYamlEntry[]>): Rule[] {
    const compiledRules: Rule[] = [];
    for (const [binary, value] of Object.entries(bashSection)) {
        const entries = normalizeToList(value);
        compiledRules.push(...compileBashBinary(binary, entries, []));
    }
    return compiledRules;
}

// Returns true when filePath matches the path/path-in entry fields
function matchesPath(entry: IYamlEntry, filePath: string): boolean {
    if (entry["path-in"] !== undefined) {
        return entry["path-in"].some((pattern: string) => matchesPattern(pattern, filePath));
    }
    if (entry.path !== undefined) {
        return matchesPattern(entry.path, filePath);
    }
    return true;
}

// Returns true when all applicable fields in a not: block simultaneously match the given node and env.
// Used to invert rule matches: if this returns true, the rule is suppressed (returns ABSTAIN / false).
// cmd/options are only evaluated for Command nodes; path/path-in only for nodes with file_path.
// Special case: if not.file is set and the file is absent, returns true (neither rule fires).
export function notFieldsAllMatch(not: INotFields, node: AstNode, env: Environment, cmdOffset: number): boolean {
    if (not.file !== undefined) {
        const fileResult = evaluateFileField(not.file);
        if (fileResult === "file-absent") {
            return true;
        }
        if (fileResult === "no-match") {
            return false;
        }
    }
    if (node.type === "command") {
        if (!matchesCmd(not as IYamlEntry, node as Command, cmdOffset)) {
            return false;
        }
        if (!matchesOptions(not as IYamlEntry, node as Command)) {
            return false;
        }
    }
    if (!matchesCwd(not as IYamlEntry, env)) {
        return false;
    }
    if (!matchesEnvVars(not as IYamlEntry, env)) {
        return false;
    }
    if ("file_path" in node) {
        const filePath = (node as { file_path: string }).file_path;
        if (!matchesPath(not as IYamlEntry, filePath)) {
            return false;
        }
    }
    return true;
}

// Returns true when the node and entry conditions all match for a file-based tool rule
function matchesFileEntry(nodeType: string, entry: IYamlEntry, node: AstNode, env: Environment): boolean {
    if (node.type !== nodeType) {
        return false;
    }
    if (!("file_path" in node)) {
        return false;
    }
    const filePath = (node as { file_path: string }).file_path;
    if (!matchesPath(entry, filePath)) {
        return false;
    }
    if (!matchesCwd(entry, env)) {
        return false;
    }
    if (!matchesCwdResolved(entry, env)) {
        return false;
    }
    if (!matchesEnvVars(entry, env)) {
        return false;
    }
    if (!matchesFileField(entry)) {
        return false;
    }
    if (entry.not !== undefined && notFieldsAllMatch(entry.not, node, env, 0)) {
        return false;
    }
    return true;
}

// Compiles one rule for a file-path-based tool (read/write/edit/multiedit)
function buildFileRule(nodeType: string, entry: IYamlEntry): Rule {
    const decision = mapDecision(entry.decide as DecideValue, entry.reason);
    const ruleName = `yaml:${nodeType}:${entry.decide}`;

    const rule: Rule = function(node: AstNode, env: Environment, _call: ToolCall): RuleOutcome {
        if (!matchesFileEntry(nodeType, entry, node, env)) {
            return ABSTAIN;
        }
        return { decision };
    };

    Object.defineProperty(rule, "name", { value: ruleName });
    return rule;
}

// Extracts the hostname from a URL string; returns empty string on parse failure
function extractHost(url: string): string {
    try {
        return new URL(url).hostname;
    } catch {
        return "";
    }
}

// Returns true when the node and entry conditions all match for a webfetch rule
function matchesWebFetchEntry(entry: IYamlEntry, node: AstNode, env: Environment): boolean {
    if (node.type !== "other" || node.tool_name !== "WebFetch") {
        return false;
    }
    const url = typeof node.tool_input["url"] === "string" ? node.tool_input["url"] : "";
    const hostname = extractHost(url);
    if (entry.host !== undefined && !matchesPattern(entry.host, hostname)) {
        return false;
    }
    if (entry["host-in"] !== undefined) {
        const hostIn = entry["host-in"] as string[];
        if (!hostIn.some((pattern: string) => matchesPattern(pattern, hostname))) {
            return false;
        }
    }
    if (!matchesCwd(entry, env)) {
        return false;
    }
    if (!matchesCwdResolved(entry, env)) {
        return false;
    }
    if (!matchesEnvVars(entry, env)) {
        return false;
    }
    if (!matchesFileField(entry)) {
        return false;
    }
    if (entry.not !== undefined && notFieldsAllMatch(entry.not, node, env, 0)) {
        return false;
    }
    return true;
}

// Compiles one rule for a webfetch entry
function buildWebFetchRule(entry: IYamlEntry): Rule {
    const decision = mapDecision(entry.decide as DecideValue, entry.reason);
    const ruleName = `yaml:webfetch:${entry.decide}`;

    const rule: Rule = function(node: AstNode, env: Environment, _call: ToolCall): RuleOutcome {
        if (!matchesWebFetchEntry(entry, node, env)) {
            return ABSTAIN;
        }
        return { decision };
    };

    Object.defineProperty(rule, "name", { value: ruleName });
    return rule;
}

// Returns true when the node and entry conditions all match for an MCP tool rule
function matchesMcpEntry(entry: IYamlEntry, node: AstNode, env: Environment): boolean {
    if (node.type !== "other") {
        return false;
    }
    if (entry["tool-in"] !== undefined) {
        const toolIn = entry["tool-in"] as string[];
        if (!toolIn.some((pattern: string) => matchesPattern(pattern, node.tool_name))) {
            return false;
        }
    }
    if (entry.tool !== undefined && !matchesPattern(entry.tool, node.tool_name)) {
        return false;
    }
    if (!matchesCwd(entry, env)) {
        return false;
    }
    if (!matchesCwdResolved(entry, env)) {
        return false;
    }
    if (!matchesEnvVars(entry, env)) {
        return false;
    }
    if (!matchesFileField(entry)) {
        return false;
    }
    if (entry.not !== undefined && notFieldsAllMatch(entry.not, node, env, 0)) {
        return false;
    }
    return true;
}

// Compiles one rule for an MCP tool entry
function buildMcpRule(entry: IYamlEntry): Rule {
    const decision = mapDecision(entry.decide as DecideValue, entry.reason);
    const ruleName = `yaml:mcp:${entry.decide}`;

    const rule: Rule = function(node: AstNode, env: Environment, _call: ToolCall): RuleOutcome {
        if (!matchesMcpEntry(entry, node, env)) {
            return ABSTAIN;
        }
        return { decision };
    };

    Object.defineProperty(rule, "name", { value: ruleName });
    return rule;
}

// Compiles a list of entries into rules, dispatching each to the leaf or scoped builder
function compileEntries(entries: IYamlEntry[], buildLeaf: (entry: IYamlEntry) => Rule, buildScoped: (entry: IYamlEntry) => Rule): Rule[] {
    const compiledRules: Rule[] = [];
    for (const entry of entries) {
        if (entry.rules !== undefined) {
            compiledRules.push(buildScoped(entry));
        }
        else if (typeof entry.decide === "string") {
            compiledRules.push(buildLeaf(entry));
        }
    }
    return compiledRules;
}

// Compiles sub-entries for a file scoped rule, dispatching to scoped or plain builder
export function compileFileEntries(nodeType: string, entries: IYamlEntry[]): Rule[] {
    return compileEntries(entries, (entry) => buildFileRule(nodeType, entry), (entry) => buildFileScopedRule(nodeType, entry));
}

// Builds a scoped file rule: checks parent conditions, then aggregates sub-rules
export function buildFileScopedRule(nodeType: string, entry: IYamlEntry): Rule {
    const subRules = compileFileEntries(nodeType, entry.rules!);
    const ruleName = `yaml:${nodeType}:scoped`;

    const rule: Rule = function(node: AstNode, env: Environment, call: ToolCall): RuleOutcome {
        if (!matchesFileEntry(nodeType, entry, node, env)) {
            return ABSTAIN;
        }
        return runSubRules(subRules, node, env, call);
    };

    Object.defineProperty(rule, "name", { value: ruleName });
    return rule;
}

// Compiles sub-entries for a webfetch scoped rule
export function compileWebFetchEntries(entries: IYamlEntry[]): Rule[] {
    return compileEntries(entries, buildWebFetchRule, buildWebFetchScopedRule);
}

// Builds a scoped webfetch rule: checks parent conditions, then aggregates sub-rules
export function buildWebFetchScopedRule(entry: IYamlEntry): Rule {
    const subRules = compileWebFetchEntries(entry.rules!);
    const ruleName = `yaml:webfetch:scoped`;

    const rule: Rule = function(node: AstNode, env: Environment, call: ToolCall): RuleOutcome {
        if (!matchesWebFetchEntry(entry, node, env)) {
            return ABSTAIN;
        }
        return runSubRules(subRules, node, env, call);
    };

    Object.defineProperty(rule, "name", { value: ruleName });
    return rule;
}

// Compiles sub-entries for an MCP scoped rule
export function compileMcpEntries(entries: IYamlEntry[]): Rule[] {
    return compileEntries(entries, buildMcpRule, buildMcpScopedRule);
}

// Builds a scoped MCP rule: checks parent conditions, then aggregates sub-rules
export function buildMcpScopedRule(entry: IYamlEntry): Rule {
    const subRules = compileMcpEntries(entry.rules!);
    const ruleName = `yaml:mcp:scoped`;

    const rule: Rule = function(node: AstNode, env: Environment, call: ToolCall): RuleOutcome {
        if (!matchesMcpEntry(entry, node, env)) {
            return ABSTAIN;
        }
        return runSubRules(subRules, node, env, call);
    };

    Object.defineProperty(rule, "name", { value: ruleName });
    return rule;
}

// Compiles all rules from the non-bash sections (read, write, edit, multi_edit, webfetch, mcp)
function compileNonBashSections(config: IYamlConfig): Rule[] {
    const compiledRules: Rule[] = [];

    const fileSections: Array<[string, string]> = [
        ["read", "read"],
        ["write", "write"],
        ["edit", "edit"],
        ["multi_edit", "multiedit"],
    ];

    for (const [sectionKey, nodeType] of fileSections) {
        const sectionValue = (config as Record<string, IYamlEntry | IYamlEntry[] | undefined>)[sectionKey];
        if (sectionValue === undefined) {
            continue;
        }
        const entries = normalizeToList(sectionValue);
        for (const entry of entries) {
            if (entry.rules !== undefined) {
                compiledRules.push(buildFileScopedRule(nodeType, entry));
            }
            else if (typeof entry.decide === "string") {
                compiledRules.push(buildFileRule(nodeType, entry));
            }
        }
    }

    if (config.webfetch !== undefined) {
        const entries = normalizeToList(config.webfetch);
        for (const entry of entries) {
            if (entry.rules !== undefined) {
                compiledRules.push(buildWebFetchScopedRule(entry));
            }
            else {
                compiledRules.push(buildWebFetchRule(entry));
            }
        }
    }

    if (config.mcp !== undefined) {
        const entries = normalizeToList(config.mcp);
        for (const entry of entries) {
            if (entry.rules !== undefined) {
                compiledRules.push(buildMcpScopedRule(entry));
            }
            else {
                compiledRules.push(buildMcpRule(entry));
            }
        }
    }

    return compiledRules;
}

// Rewrites a single cwd pattern that starts with "./" by replacing the prefix with baseDir
export function resolveCwdPattern(pattern: string, baseDir: string): string {
    if (pattern.startsWith("./")) {
        return baseDir + "/" + pattern.slice(2);
    }
    return pattern;
}

// Walks a single IYamlEntry (and its subcommand children) and rewrites "./" cwd patterns to absolute paths
export function resolveEntryCwdPatterns(entry: IYamlEntry, baseDir: string): void {
    if (typeof entry.cwd === "string") {
        entry.cwd = resolveCwdPattern(entry.cwd, baseDir);
    }
    if (Array.isArray(entry["cwd-in"])) {
        entry["cwd-in"] = entry["cwd-in"].map((pattern: string) => resolveCwdPattern(pattern, baseDir));
    }
    if (entry.not !== undefined) {
        if (typeof entry.not.cwd === "string") {
            entry.not.cwd = resolveCwdPattern(entry.not.cwd, baseDir);
        }
        if (Array.isArray(entry.not["cwd-in"])) {
            entry.not["cwd-in"] = entry.not["cwd-in"].map((pattern: string) => resolveCwdPattern(pattern, baseDir));
        }
    }
    if (Array.isArray(entry.rules)) {
        for (const subEntry of entry.rules) {
            resolveEntryCwdPatterns(subEntry, baseDir);
        }
    }
    for (const key of Object.keys(entry)) {
        if (KNOWN_FIELDS.has(key)) {
            continue;
        }
        const subValue = entry[key] as IYamlEntry | IYamlEntry[];
        if (Array.isArray(subValue)) {
            for (const subEntry of subValue) {
                resolveEntryCwdPatterns(subEntry, baseDir);
            }
        }
        else if (typeof subValue === "object" && subValue !== null) {
            resolveEntryCwdPatterns(subValue, baseDir);
        }
    }
}

// Walks every IYamlEntry in config and rewrites "./" cwd patterns to absolute paths under baseDir
export function resolveRelativeCwdPatterns(config: IYamlConfig, baseDir: string): void {
    if (config.bash !== undefined) {
        for (const entries of Object.values(config.bash)) {
            for (const entry of normalizeToList(entries)) {
                resolveEntryCwdPatterns(entry, baseDir);
            }
        }
    }
    const sectionKeys = ["read", "write", "edit", "multi_edit", "webfetch", "mcp"] as const;
    for (const sectionKey of sectionKeys) {
        const sectionValue = (config as Record<string, IYamlEntry | IYamlEntry[] | undefined>)[sectionKey];
        if (sectionValue !== undefined) {
            for (const entry of normalizeToList(sectionValue)) {
                resolveEntryCwdPatterns(entry, baseDir);
            }
        }
    }
}

// Reads and parses a YAML file; returns null if the file does not exist
function readYamlFile(filePath: string): IYamlConfig | null {
    if (!existsSync(filePath)) {
        return null;
    }
    const content = readFileSync(filePath, "utf-8");
    return parse(content) as IYamlConfig;
}

// Recursively validates a single rule entry and appends any problems to errors.
// path is the dot-path string used in error messages (e.g. "bash.git[0].log[0]").
function validateEntry(entry: IYamlEntry, path: string, errors: IConfigError[]): void {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
        errors.push({ path, message: `expected a rule entry object but got ${Array.isArray(entry) ? "array" : typeof entry}` });
        return;
    }
    if (entry.decide !== undefined && !VALID_DECIDE_VALUES.has(entry.decide as string)) {
        errors.push({ path: `${path}.decide`, message: `invalid decide value '${entry.decide}': must be one of allow, deny, ask, abstain` });
    }
    if (entry.decide !== undefined && entry.rules !== undefined) {
        errors.push({ path, message: `'decide' and 'rules' are mutually exclusive; 'decide' will be ignored` });
    }
    const subcommandKeys = Object.keys(entry).filter((key: string) => !KNOWN_FIELDS.has(key));
    if (entry.decide === undefined && entry.rules === undefined && subcommandKeys.length === 0) {
        errors.push({ path, message: `entry has neither 'decide', 'rules', nor subcommand keys and will always abstain` });
    }
    if (entry.rules !== undefined) {
        for (let index = 0; index < entry.rules.length; index++) {
            validateEntry(entry.rules[index], `${path}.rules[${index}]`, errors);
        }
    }
    for (const subKey of subcommandKeys) {
        const subValue = entry[subKey];
        if (typeof subValue !== "object" || subValue === null) {
            errors.push({ path: `${path}.${subKey}`, message: `subcommand value must be a rule entry object or list of rule entries, got ${typeof subValue}` });
            continue;
        }
        if (Array.isArray(subValue)) {
            for (let index = 0; index < subValue.length; index++) {
                const item = (subValue as IEntryValue[])[index];
                if (typeof item !== "object" || item === null || Array.isArray(item)) {
                    errors.push({ path: `${path}.${subKey}[${index}]`, message: `expected a rule entry object but got ${Array.isArray(item) ? "array" : typeof item}` });
                    continue;
                }
                validateEntry(item as IYamlEntry, `${path}.${subKey}[${index}]`, errors);
            }
        }
        else {
            validateEntry(subValue as IYamlEntry, `${path}.${subKey}`, errors);
        }
    }
}

// validateConfig inspects a fully parsed IYamlConfig and returns a list of IConfigError
// describing any problems found. An empty list means no issues were detected.
export function validateConfig(config: IYamlConfig): IConfigError[] {
    const errors: IConfigError[] = [];
    if (config.bash !== undefined) {
        for (const [binary, value] of Object.entries(config.bash)) {
            const entries = normalizeToList(value);
            for (let index = 0; index < entries.length; index++) {
                validateEntry(entries[index], `bash.${binary}[${index}]`, errors);
            }
        }
    }
    const nonBashSections = ["read", "write", "edit", "multi_edit", "webfetch", "mcp"];
    for (const section of nonBashSections) {
        const sectionValue = (config as Record<string, IYamlEntry | IYamlEntry[] | undefined>)[section];
        if (sectionValue === undefined) {
            continue;
        }
        const entries = normalizeToList(sectionValue);
        for (let index = 0; index < entries.length; index++) {
            validateEntry(entries[index], `${section}[${index}]`, errors);
        }
    }
    return errors;
}

// Compiles all rules from a merged config object
function compileConfig(config: IYamlConfig): Rule[] {
    const compiledRules: Rule[] = [];

    if (config.bash !== undefined) {
        compiledRules.push(...compileBashSection(config.bash));
    }

    compiledRules.push(...compileNonBashSections(config));

    return compiledRules;
}

// Loads .claude/permissions.yaml from home and project dirs, merges (project beats home),
// compiles each entry into Rule closures, and returns the combined list.
// Returns [] when env vars are absent or files are missing.
export function loadConfigRules(): Rule[] {
    let homeConfig: IYamlConfig = {};
    let projectConfig: IYamlConfig = {};

    const homeDir = process.env["HOME"];
    if (homeDir !== undefined) {
        const homeYaml = readYamlFile(join(homeDir, ".claude", "permissions.yaml"));
        if (homeYaml !== null) {
            resolveRelativeCwdPatterns(homeYaml, homeDir);
            homeConfig = homeYaml;
        }
    }

    const projectDir = process.env["CLAUDE_PROJECT_DIR"];
    if (projectDir !== undefined) {
        const projectYaml = readYamlFile(join(projectDir, ".claude", "permissions.yaml"));
        if (projectYaml !== null) {
            resolveRelativeCwdPatterns(projectYaml, projectDir);
            projectConfig = projectYaml;
        }
    }

    const merged: IYamlConfig = { ...homeConfig, ...projectConfig };
    const configErrors = validateConfig(merged);
    for (const configError of configErrors) {
        process.stderr.write(`[CONFIG ERROR] ${configError.path}: ${configError.message}\n`);
    }
    return compileConfig(merged);
}
