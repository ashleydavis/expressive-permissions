import { readFileSync, existsSync, readdirSync, statSync } from "fs";
import { join, resolve } from "path";
import { homedir } from "os";
import { parseDocument, isMap, isSeq, isPair, isScalar, Node } from "yaml";
import picomatch from "picomatch";
import { IRule, IRuleOutcome, AstNode, IEnvironment, IToolCall, ABSTAIN, Decision, ICommand } from "./types";

// Valid decide values in YAML config
type DecideValue = "allow" | "deny" | "ask" | "abstain";

// Union of all possible values within a YAML entry
type IEntryValue = string | number | boolean | string[] | Record<string, string> | IYamlEntry | IYamlEntry[] | INotFields;

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
    // The display path of the YAML file this entry was parsed from, set during parsing
    sourceFile?: string;
    // 1-based line number in the source YAML file where this entry begins, set during parsing
    sourceLine?: number;
}

// Top-level structure of the permissions YAML file. The named fields below are the recognised
// "sections"; any additional top-level keys are interpreted as tool-name rules (matched against
// the Claude Code tool name via picomatch). Tool rules are declared as top-level keys
// (e.g. `Grep:`, `"mcp__*__delete_*":`).
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
    // Top-level tool-name keys are accessed via Object.keys() at runtime; they do not appear
    // on this typed interface. Any string key that is not a recognised section is treated as
    // a tool-name pattern matched via picomatch.
}

// Fields that are matcher/control fields and NOT subcommand keys
const KNOWN_FIELDS = new Set(["decide", "reason", "rules", "not", "file", "cmd", "cmd-in", "options", "options-in", "cwd", "cwd-in", "cwd_resolved", "env", "path", "path-in", "host", "host-in", "tool", "tool-in", "sourceLine", "sourceFile"]);

// Top-level YAML keys that are recognised section names (handled by dedicated dispatch).
// Anything outside this set, and outside KNOWN_FIELDS, becomes a tool-name rule. KNOWN_FIELDS
// names appearing at the top level (e.g. a stray `decide: allow`) are rejected by validateConfig
// rather than silently becoming a tool named "decide".
const KNOWN_SECTIONS = new Set(["bash", "read", "write", "edit", "multi_edit", "webfetch"]);

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
// `dot: true` is passed to picomatch so that "*" and "**" traverse hidden segments
// (e.g. ".claude-plugin", ".git"); users expect "./**" to mean "any path under here",
// not "any path that doesn't pass through a dotfile".
function matchesGlob(pattern: string, value: string): boolean {
    if (pattern.endsWith("/**") && value === pattern.slice(0, -3)) {
        return false;
    }
    return picomatch(pattern, { dot: true })(value);
}

// Path-aware glob match for resolved absolute paths. Same as matchesGlob but, for patterns
// ending in "/**", the base directory itself counts as a match. Used by path-aware cmd: matching
// where "<proj>/**" should cover "<proj>" itself (so "find ." run from the project root is allowed).
function matchesPathGlob(pattern: string, value: string): boolean {
    if (pattern.endsWith("/**") && value === pattern.slice(0, -3)) {
        return true;
    }
    return picomatch(pattern, { dot: true })(value);
}

// Matches value against pattern: dispatches to RegExp for /.../ patterns, otherwise calls picomatch.
function matchesPattern(pattern: string, value: string): boolean {
    if (pattern.length >= 2 && pattern.startsWith("/") && pattern.endsWith("/")) {
        return new RegExp(pattern.slice(1, -1)).test(value);
    }
    return matchesGlob(pattern, value);
}

// Returns true when env.cwd matches the cwd/cwd-in entry fields
function matchesCwd(entry: IYamlEntry, env: IEnvironment): boolean {
    if (entry["cwd-in"] !== undefined) {
        return entry["cwd-in"].some((pattern: string) => matchesPattern(pattern, env.cwd));
    }
    if (entry.cwd !== undefined) {
        return matchesPattern(entry.cwd, env.cwd);
    }
    return true;
}

// Returns true when env.cwdResolved matches the cwd_resolved entry field; omitting matches either
function matchesCwdResolved(entry: IYamlEntry, env: IEnvironment): boolean {
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
function matchesEnvVars(entry: IYamlEntry, env: IEnvironment): boolean {
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
function matchesOptions(entry: IYamlEntry, node: ICommand): boolean {
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

// Returns true when value matches pattern using path-aware semantics if the pattern is a
// path-style pattern (./* or /*), otherwise falls through to the string-glob matchesPattern.
// Used inside matchesCmd to dispatch per pattern–arg pair. The resolved pattern is assumed
// to already be absolute (rewritten at load time by resolveCmdPathPattern); the value is
// resolved against env.cwd here so positional args like "." or "src/foo" become absolute.
function matchesCmdPattern(pattern: string, arg: string, env: IEnvironment): boolean {
    if (!isCmdPathPattern(pattern)) {
        return matchesPattern(pattern, arg);
    }
    const resolvedArg = resolve(env.cwd, arg);
    return matchesPathGlob(pattern, resolvedArg);
}

// Returns true when the cmd/cmd-in entry fields match the positional arguments at the given offset.
// env is threaded in so path-aware patterns (./* or /*) can resolve relative positional args
// against env.cwd before matching.
function matchesCmd(entry: IYamlEntry, node: ICommand, cmdOffset: number, env: IEnvironment): boolean {
    const cmdArray = Array.isArray(node.cmd) ? node.cmd : [node.cmd];

    if (entry["cmd-in"] !== undefined) {
        const slice = cmdArray.slice(cmdOffset);
        return entry["cmd-in"].some((pattern: string) =>
            slice.some((positional: string) => matchesCmdPattern(pattern, positional, env))
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
            if (!matchesCmdPattern(patterns[idx], target, env)) {
                return false;
            }
        }
        return true;
    }

    return true;
}

// Strictest-wins aggregation: deny > ask > allow > abstain
export function aggregateOutcomes(firstOutcome: IRuleOutcome, secondOutcome: IRuleOutcome): IRuleOutcome {
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
function buildBashRule(binary: string, subcommandPath: string[], entry: IYamlEntry): IRule {
    const decision = mapDecision(entry.decide as DecideValue, entry.reason);
    const pathLabel = subcommandPath.length > 0 ? `:${subcommandPath.join(":")}` : "";
    const ruleName = `yaml:${binary}${pathLabel}:${entry.decide}`;
    const cmdOffset = subcommandPath.length;

    const rule: IRule = function(node: AstNode, env: IEnvironment, _call: IToolCall): IRuleOutcome {
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
        if (!matchesCmd(entry, node, cmdOffset, env)) {
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
    rule.ruleFile = entry.sourceFile;
    rule.ruleLine = entry.sourceLine;
    return rule;
}

// Runs each sub-rule in order, aggregating outcomes strictest-wins; stops early on deny
function runSubRules(subRules: IRule[], node: AstNode, env: IEnvironment, call: IToolCall): IRuleOutcome {
    let result: IRuleOutcome = ABSTAIN;
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
export function buildBashScopedRule(binary: string, subcommandPath: string[], entry: IYamlEntry): IRule {
    const subRules = compileBashBinary(binary, entry.rules!, subcommandPath);
    const pathLabel = subcommandPath.length > 0 ? `:${subcommandPath.join(":")}` : "";
    const ruleName = `yaml:${binary}${pathLabel}:scoped`;
    const cmdOffset = subcommandPath.length;

    const rule: IRule = function(node: AstNode, env: IEnvironment, call: IToolCall): IRuleOutcome {
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
        if (!matchesCmd(entry, node, cmdOffset, env)) {
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
    rule.ruleFile = entry.sourceFile;
    rule.ruleLine = entry.sourceLine;
    return rule;
}

// Recursively compiles all rules for a binary and its subcommand hierarchy
export function compileBashBinary(binary: string, entries: IYamlEntry[], subcommandPath: string[]): IRule[] {
    const compiledRules: IRule[] = [];

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
function compileBashSection(bashSection: Record<string, IYamlEntry | IYamlEntry[]>): IRule[] {
    const compiledRules: IRule[] = [];
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
export function notFieldsAllMatch(not: INotFields, node: AstNode, env: IEnvironment, cmdOffset: number): boolean {
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
        if (!matchesCmd(not as IYamlEntry, node as ICommand, cmdOffset, env)) {
            return false;
        }
        if (!matchesOptions(not as IYamlEntry, node as ICommand)) {
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
function matchesFileEntry(nodeType: string, entry: IYamlEntry, node: AstNode, env: IEnvironment): boolean {
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
function buildFileRule(nodeType: string, entry: IYamlEntry): IRule {
    const decision = mapDecision(entry.decide as DecideValue, entry.reason);
    const ruleName = `yaml:${nodeType}:${entry.decide}`;

    const rule: IRule = function(node: AstNode, env: IEnvironment, _call: IToolCall): IRuleOutcome {
        if (!matchesFileEntry(nodeType, entry, node, env)) {
            return ABSTAIN;
        }
        return { decision };
    };

    Object.defineProperty(rule, "name", { value: ruleName });
    rule.ruleFile = entry.sourceFile;
    rule.ruleLine = entry.sourceLine;
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
function matchesWebFetchEntry(entry: IYamlEntry, node: AstNode, env: IEnvironment): boolean {
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
function buildWebFetchRule(entry: IYamlEntry): IRule {
    const decision = mapDecision(entry.decide as DecideValue, entry.reason);
    const ruleName = `yaml:webfetch:${entry.decide}`;

    const rule: IRule = function(node: AstNode, env: IEnvironment, _call: IToolCall): IRuleOutcome {
        if (!matchesWebFetchEntry(entry, node, env)) {
            return ABSTAIN;
        }
        return { decision };
    };

    Object.defineProperty(rule, "name", { value: ruleName });
    rule.ruleFile = entry.sourceFile;
    rule.ruleLine = entry.sourceLine;
    return rule;
}

// Returns true when the node and entry conditions all match for a tool-name rule
function matchesMcpEntry(entry: IYamlEntry, node: AstNode, env: IEnvironment): boolean {
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

// Compiles one rule for a tool-name entry (matches against IToolCall.tool_name)
function buildMcpRule(entry: IYamlEntry): IRule {
    const decision = mapDecision(entry.decide as DecideValue, entry.reason);
    const ruleName = `yaml:tool:${entry.decide}`;

    const rule: IRule = function(node: AstNode, env: IEnvironment, _call: IToolCall): IRuleOutcome {
        if (!matchesMcpEntry(entry, node, env)) {
            return ABSTAIN;
        }
        return { decision };
    };

    Object.defineProperty(rule, "name", { value: ruleName });
    rule.ruleFile = entry.sourceFile;
    rule.ruleLine = entry.sourceLine;
    return rule;
}

// Compiles a list of entries into rules, dispatching each to the leaf or scoped builder
function compileEntries(entries: IYamlEntry[], buildLeaf: (entry: IYamlEntry) => IRule, buildScoped: (entry: IYamlEntry) => IRule): IRule[] {
    const compiledRules: IRule[] = [];
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
export function compileFileEntries(nodeType: string, entries: IYamlEntry[]): IRule[] {
    return compileEntries(entries, (entry) => buildFileRule(nodeType, entry), (entry) => buildFileScopedRule(nodeType, entry));
}

// Builds a scoped file rule: checks parent conditions, then aggregates sub-rules
export function buildFileScopedRule(nodeType: string, entry: IYamlEntry): IRule {
    const subRules = compileFileEntries(nodeType, entry.rules!);
    const ruleName = `yaml:${nodeType}:scoped`;

    const rule: IRule = function(node: AstNode, env: IEnvironment, call: IToolCall): IRuleOutcome {
        if (!matchesFileEntry(nodeType, entry, node, env)) {
            return ABSTAIN;
        }
        return runSubRules(subRules, node, env, call);
    };

    Object.defineProperty(rule, "name", { value: ruleName });
    rule.ruleFile = entry.sourceFile;
    rule.ruleLine = entry.sourceLine;
    return rule;
}

// Compiles sub-entries for a webfetch scoped rule
export function compileWebFetchEntries(entries: IYamlEntry[]): IRule[] {
    return compileEntries(entries, buildWebFetchRule, buildWebFetchScopedRule);
}

// Builds a scoped webfetch rule: checks parent conditions, then aggregates sub-rules
export function buildWebFetchScopedRule(entry: IYamlEntry): IRule {
    const subRules = compileWebFetchEntries(entry.rules!);
    const ruleName = `yaml:webfetch:scoped`;

    const rule: IRule = function(node: AstNode, env: IEnvironment, call: IToolCall): IRuleOutcome {
        if (!matchesWebFetchEntry(entry, node, env)) {
            return ABSTAIN;
        }
        return runSubRules(subRules, node, env, call);
    };

    Object.defineProperty(rule, "name", { value: ruleName });
    rule.ruleFile = entry.sourceFile;
    rule.ruleLine = entry.sourceLine;
    return rule;
}

// Compiles a list of tool-name entries (used by both top-level keys and scoped sub-rules)
export function compileMcpEntries(entries: IYamlEntry[]): IRule[] {
    return compileEntries(entries, buildMcpRule, buildMcpScopedRule);
}

// Builds a scoped tool-name rule: checks parent conditions, then aggregates sub-rules
export function buildMcpScopedRule(entry: IYamlEntry): IRule {
    const subRules = compileMcpEntries(entry.rules!);
    const ruleName = `yaml:tool:scoped`;

    const rule: IRule = function(node: AstNode, env: IEnvironment, call: IToolCall): IRuleOutcome {
        if (!matchesMcpEntry(entry, node, env)) {
            return ABSTAIN;
        }
        return runSubRules(subRules, node, env, call);
    };

    Object.defineProperty(rule, "name", { value: ruleName });
    rule.ruleFile = entry.sourceFile;
    rule.ruleLine = entry.sourceLine;
    return rule;
}

// Compiles tool-name rules from top-level YAML keys that are not recognised sections.
// Each non-section, non-reserved key is treated as a tool-name pattern. If the entry omits
// both `tool` and `tool-in`, the key is set as the implicit `tool` matcher. When either field
// is present, the key becomes a human-readable label only and the explicit field drives matching.
// Sub-rules under a scoped entry inherit the parent key when they omit `tool`/`tool-in`,
// mirroring the bash-section convention where sub-rules inherit their parent binary.
export function compileTopLevelToolRules(config: IYamlConfig): IRule[] {
    const compiledRules: IRule[] = [];
    for (const key of Object.keys(config)) {
        if (KNOWN_SECTIONS.has(key)) {
            continue;
        }
        if (KNOWN_FIELDS.has(key)) {
            continue;
        }
        const sectionValue = (config as Record<string, IYamlEntry | IYamlEntry[] | undefined>)[key];
        if (sectionValue === undefined) {
            continue;
        }
        const entries = normalizeToList(sectionValue);
        for (const entry of entries) {
            if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
                continue;
            }
            if (entry.tool === undefined && entry["tool-in"] === undefined) {
                entry.tool = key;
            }
            if (Array.isArray(entry.rules)) {
                for (const subEntry of entry.rules) {
                    if (typeof subEntry !== "object" || subEntry === null || Array.isArray(subEntry)) {
                        continue;
                    }
                    if (subEntry.tool === undefined && subEntry["tool-in"] === undefined) {
                        subEntry.tool = key;
                    }
                }
            }
        }
        compiledRules.push(...compileMcpEntries(entries));
    }
    return compiledRules;
}

// Compiles all rules from the non-bash sections (read, write, edit, multi_edit, webfetch)
function compileNonBashSections(config: IYamlConfig): IRule[] {
    const compiledRules: IRule[] = [];

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

    return compiledRules;
}

// Rewrites a single cwd pattern that starts with "./" by replacing the prefix with baseDir
export function resolveCwdPattern(pattern: string, baseDir: string): string {
    if (pattern.startsWith("./")) {
        return baseDir + "/" + pattern.slice(2);
    }
    return pattern;
}

// Options for resolveEntryCwdPatterns / validateEntry to distinguish tool-name entries from
// bash entries. Tool-name entries do not have subcommand recursion; unknown keys on them are
// validation errors rather than sub-binary structure.
export interface IEntryWalkOptions {
    // When true, the entry is treated as a top-level tool-name rule: unknown keys are errors
    // (in validateEntry) and the subcommand-recursion branch is skipped (in resolveEntryCwdPatterns).
    isToolNameEntry: boolean;
}

// Walks a single IYamlEntry (and its subcommand children) and rewrites "./" cwd patterns to absolute paths.
// When called with isToolNameEntry=true the subcommand-recursion branch is skipped because tool-name
// entries do not have a sub-binary layer; only entry.rules sub-entries are walked.
export function resolveEntryCwdPatterns(entry: IYamlEntry, baseDir: string, options?: IEntryWalkOptions): void {
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
            resolveEntryCwdPatterns(subEntry, baseDir, options);
        }
    }
    if (options !== undefined && options.isToolNameEntry) {
        return;
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
    const sectionKeys = ["read", "write", "edit", "multi_edit", "webfetch"] as const;
    for (const sectionKey of sectionKeys) {
        const sectionValue = (config as Record<string, IYamlEntry | IYamlEntry[] | undefined>)[sectionKey];
        if (sectionValue !== undefined) {
            for (const entry of normalizeToList(sectionValue)) {
                resolveEntryCwdPatterns(entry, baseDir);
            }
        }
    }
    const toolNameOptions: IEntryWalkOptions = { isToolNameEntry: true };
    for (const key of Object.keys(config)) {
        if (KNOWN_SECTIONS.has(key)) {
            continue;
        }
        if (KNOWN_FIELDS.has(key)) {
            continue;
        }
        const sectionValue = (config as Record<string, IYamlEntry | IYamlEntry[] | undefined>)[key];
        if (sectionValue === undefined) {
            continue;
        }
        for (const entry of normalizeToList(sectionValue)) {
            resolveEntryCwdPatterns(entry, baseDir, toolNameOptions);
        }
    }
}

// Classifies a cmd: / cmd-in: pattern as path-aware (true) or string-glob/regex (false).
// Patterns starting with "./" or "/" are interpreted as paths, except regex patterns of the
// form "/.../" which are kept on the string-glob path so matchesPattern can dispatch to RegExp.
export function isCmdPathPattern(pattern: string): boolean {
    if (pattern.length >= 2 && pattern.startsWith("/") && pattern.endsWith("/")) {
        return false;
    }
    return pattern.startsWith("./") || pattern.startsWith("/");
}

// Rewrites a single cmd: / cmd-in: pattern that starts with "./" by replacing the prefix
// with the project directory. Absolute patterns are returned unchanged; non-path patterns
// (e.g. "foo-*") are also returned unchanged so the existing string-glob branch keeps working.
export function resolveCmdPathPattern(pattern: string, projectDir: string): string {
    if (pattern.startsWith("./")) {
        return projectDir + "/" + pattern.slice(2);
    }
    return pattern;
}

// Rewrites every positional pattern inside one cmd:/cmd-in: field through resolveCmdPathPattern.
// For the string form, tokens are split on whitespace, rewritten individually, then rejoined
// with single spaces so the downstream split inside matchesCmd produces the resolved patterns.
function rewriteCmdField(cmdField: string | string[], projectDir: string): string | string[] {
    if (Array.isArray(cmdField)) {
        return cmdField.map((pattern: string) => resolveCmdPathPattern(pattern, projectDir));
    }
    const tokens = cmdField.trim().split(/\s+/);
    const rewrittenTokens = tokens.map((token: string) => resolveCmdPathPattern(token, projectDir));
    return rewrittenTokens.join(" ");
}

// Walks one IYamlEntry (and its descendants) and rewrites every cmd: / cmd-in: (plus not.cmd
// and not.cmd-in) path-style pattern to its absolute form anchored at projectDir. Mirrors
// resolveEntryCwdPatterns. When called with isToolNameEntry=true the subcommand-recursion branch
// is skipped because tool-name entries do not have a sub-binary layer.
export function resolveEntryCmdPatterns(entry: IYamlEntry, projectDir: string, options?: IEntryWalkOptions): void {
    if (entry.cmd !== undefined) {
        entry.cmd = rewriteCmdField(entry.cmd, projectDir);
    }
    if (Array.isArray(entry["cmd-in"])) {
        entry["cmd-in"] = entry["cmd-in"].map((pattern: string) => resolveCmdPathPattern(pattern, projectDir));
    }
    if (entry.not !== undefined) {
        if (entry.not.cmd !== undefined) {
            entry.not.cmd = rewriteCmdField(entry.not.cmd, projectDir);
        }
        if (Array.isArray(entry.not["cmd-in"])) {
            entry.not["cmd-in"] = entry.not["cmd-in"].map((pattern: string) => resolveCmdPathPattern(pattern, projectDir));
        }
    }
    if (Array.isArray(entry.rules)) {
        for (const subEntry of entry.rules) {
            resolveEntryCmdPatterns(subEntry, projectDir, options);
        }
    }
    if (options !== undefined && options.isToolNameEntry) {
        return;
    }
    for (const key of Object.keys(entry)) {
        if (KNOWN_FIELDS.has(key)) {
            continue;
        }
        const subValue = entry[key] as IYamlEntry | IYamlEntry[];
        if (Array.isArray(subValue)) {
            for (const subEntry of subValue) {
                resolveEntryCmdPatterns(subEntry, projectDir);
            }
        }
        else if (typeof subValue === "object" && subValue !== null) {
            resolveEntryCmdPatterns(subValue, projectDir);
        }
    }
}

// Walks every IYamlEntry in config and rewrites "./"-prefixed cmd:/cmd-in: patterns to
// absolute paths under projectDir. Mirrors resolveRelativeCwdPatterns but anchors at the
// project directory rather than the file's own baseDir, so cmd: ./** in a home YAML still
// resolves to the project root.
export function resolveRelativeCmdPatterns(config: IYamlConfig, projectDir: string): void {
    if (config.bash !== undefined) {
        for (const entries of Object.values(config.bash)) {
            for (const entry of normalizeToList(entries)) {
                resolveEntryCmdPatterns(entry, projectDir);
            }
        }
    }
    const sectionKeys = ["read", "write", "edit", "multi_edit", "webfetch"] as const;
    for (const sectionKey of sectionKeys) {
        const sectionValue = (config as Record<string, IYamlEntry | IYamlEntry[] | undefined>)[sectionKey];
        if (sectionValue !== undefined) {
            for (const entry of normalizeToList(sectionValue)) {
                resolveEntryCmdPatterns(entry, projectDir);
            }
        }
    }
    const toolNameOptions: IEntryWalkOptions = { isToolNameEntry: true };
    for (const key of Object.keys(config)) {
        if (KNOWN_SECTIONS.has(key)) {
            continue;
        }
        if (KNOWN_FIELDS.has(key)) {
            continue;
        }
        const sectionValue = (config as Record<string, IYamlEntry | IYamlEntry[] | undefined>)[key];
        if (sectionValue === undefined) {
            continue;
        }
        for (const entry of normalizeToList(sectionValue)) {
            resolveEntryCmdPatterns(entry, projectDir, toolNameOptions);
        }
    }
}

// Expands ${{PROJECT_DIR}} and ${{HOME}} tokens in a single string value.
// Regex patterns (/.../  form) are returned unchanged. If a token is present but the
// corresponding env var is undefined, the literal token is left in place and a warning
// key is added to the warnings set so the caller can emit one stderr line per file.
function expandEnvTokens(
    value: string,
    projectDir: string | undefined,
    homeDir: string | undefined,
    displayFile: string,
    warnings: Set<string>
): string {
    if (value.length >= 2 && value.startsWith("/") && value.endsWith("/")) {
        return value;
    }
    let result = value;
    const projectDirToken = "${{PROJECT_DIR}}";
    const homeToken = "${{HOME}}";
    if (result.includes(projectDirToken)) {
        if (projectDir !== undefined) {
            result = result.split(projectDirToken).join(projectDir);
        }
        else {
            warnings.add(projectDirToken + "@" + displayFile);
        }
    }
    if (result.includes(homeToken)) {
        if (homeDir !== undefined) {
            result = result.split(homeToken).join(homeDir);
        }
        else {
            warnings.add(homeToken + "@" + displayFile);
        }
    }
    return result;
}

// Subset of IYamlEntry / INotFields fields that can contain ${{PROJECT_DIR}} / ${{HOME}} tokens.
// Both interfaces satisfy this structurally, allowing a single expand helper for entry and not: blocks.
interface IExpandableFields {
    // Positional arg matcher (string or array form)
    cmd?: string | string[];
    // OR form of cmd
    "cmd-in"?: string[];
    // Glob pattern matched against env.cwd
    cwd?: string;
    // OR form of cwd
    "cwd-in"?: string[];
    // Glob pattern matched against node.file_path
    path?: string;
    // OR form of path
    "path-in"?: string[];
    // Map of env var name → glob pattern
    env?: Record<string, string>;
    // Map of file path → IFileMatch or true
    file?: Record<string, IFileMatch | true>;
}

// Expands ${{PROJECT_DIR}} / ${{HOME}} tokens in all string-valued matcher fields of target in-place.
function expandMatcherFields(target: IExpandableFields, expand: (value: string) => string): void {
    if (typeof target.cmd === "string") {
        target.cmd = expand(target.cmd);
    }
    else if (Array.isArray(target.cmd)) {
        target.cmd = target.cmd.map(expand);
    }
    if (Array.isArray(target["cmd-in"])) {
        target["cmd-in"] = target["cmd-in"].map(expand);
    }
    if (typeof target.cwd === "string") {
        target.cwd = expand(target.cwd);
    }
    if (Array.isArray(target["cwd-in"])) {
        target["cwd-in"] = target["cwd-in"].map(expand);
    }
    if (typeof target.path === "string") {
        target.path = expand(target.path);
    }
    if (Array.isArray(target["path-in"])) {
        target["path-in"] = target["path-in"].map(expand);
    }
    if (target.env !== undefined) {
        const newEnv: Record<string, string> = {};
        for (const [envKey, envValue] of Object.entries(target.env)) {
            newEnv[envKey] = typeof envValue === "string" ? expand(envValue) : envValue;
        }
        target.env = newEnv;
    }
    if (target.file !== undefined) {
        const newFile: Record<string, IFileMatch | true> = {};
        for (const [fileKey, fileValue] of Object.entries(target.file)) {
            newFile[expand(fileKey)] = fileValue;
        }
        target.file = newFile;
    }
}

// Walks one IYamlEntry and rewrites every string-valued matcher field through expandEnvTokens.
// Recurses into not: blocks, rules: sub-entries, and (when isToolNameEntry is false) subcommand children.
export function expandEntryEnvTokens(
    entry: IYamlEntry,
    projectDir: string | undefined,
    homeDir: string | undefined,
    displayFile: string,
    warnings: Set<string>,
    options?: IEntryWalkOptions
): void {
    const expand = (value: string): string => expandEnvTokens(value, projectDir, homeDir, displayFile, warnings);
    expandMatcherFields(entry, expand);
    if (entry.not !== undefined) {
        expandMatcherFields(entry.not, expand);
    }
    if (Array.isArray(entry.rules)) {
        for (const subEntry of entry.rules) {
            expandEntryEnvTokens(subEntry, projectDir, homeDir, displayFile, warnings, options);
        }
    }
    if (options !== undefined && options.isToolNameEntry) {
        return;
    }
    for (const key of Object.keys(entry)) {
        if (KNOWN_FIELDS.has(key)) {
            continue;
        }
        const subValue = entry[key] as IYamlEntry | IYamlEntry[];
        if (Array.isArray(subValue)) {
            for (const subEntry of subValue) {
                expandEntryEnvTokens(subEntry, projectDir, homeDir, displayFile, warnings);
            }
        }
        else if (typeof subValue === "object" && subValue !== null) {
            expandEntryEnvTokens(subValue, projectDir, homeDir, displayFile, warnings);
        }
    }
}

// Walks all entries in config and expands ${{PROJECT_DIR}} / ${{HOME}} tokens in matcher fields.
// Emits one [CONFIG WARN] line to stderr per unique unresolved token+file combination.
export function expandConfigEnvTokens(
    config: IYamlConfig,
    projectDir: string | undefined,
    homeDir: string | undefined,
    displayFile: string
): void {
    const warnings = new Set<string>();

    if (config.bash !== undefined) {
        for (const entries of Object.values(config.bash)) {
            for (const entry of normalizeToList(entries)) {
                expandEntryEnvTokens(entry, projectDir, homeDir, displayFile, warnings);
            }
        }
    }
    const sectionKeys = ["read", "write", "edit", "multi_edit", "webfetch"] as const;
    for (const sectionKey of sectionKeys) {
        const sectionValue = (config as Record<string, IYamlEntry | IYamlEntry[] | undefined>)[sectionKey];
        if (sectionValue !== undefined) {
            for (const entry of normalizeToList(sectionValue)) {
                expandEntryEnvTokens(entry, projectDir, homeDir, displayFile, warnings);
            }
        }
    }
    const toolNameOptions: IEntryWalkOptions = { isToolNameEntry: true };
    for (const key of Object.keys(config)) {
        if (KNOWN_SECTIONS.has(key)) {
            continue;
        }
        if (KNOWN_FIELDS.has(key)) {
            continue;
        }
        const sectionValue = (config as Record<string, IYamlEntry | IYamlEntry[] | undefined>)[key];
        if (sectionValue === undefined) {
            continue;
        }
        for (const entry of normalizeToList(sectionValue)) {
            expandEntryEnvTokens(entry, projectDir, homeDir, displayFile, warnings, toolNameOptions);
        }
    }
    for (const warningKey of warnings) {
        const atIndex = warningKey.indexOf("@");
        const token = warningKey.slice(0, atIndex);
        process.stderr.write(`[CONFIG WARN] (${displayFile}) unresolved ${token}\n`);
    }
}

// lineOfOffset returns the 1-based line number for a character offset in a source string.
export function lineOfOffset(source: string, offset: number): number {
    let line = 1;
    for (let idx = 0; idx < offset; idx++) {
        if (source[idx] === "\n") {
            line++;
        }
    }
    return line;
}

// annotateLines walks a YAML AST node and the corresponding parsed JS value in parallel,
// stamping sourceFile and sourceLine onto each IYamlEntry object that has a decide field.
export function annotateLines(node: Node | null, jsValue: unknown, source: string, displayFile: string): void {
    if (isMap(node) && jsValue !== null && typeof jsValue === "object" && !Array.isArray(jsValue)) {
        const jsObj = jsValue as IYamlEntry;
        if ("decide" in jsObj && node.range) {
            jsObj.sourceFile = displayFile;
            jsObj.sourceLine = lineOfOffset(source, node.range[0]);
        }
        for (const pair of node.items) {
            if (!isPair(pair) || !isScalar(pair.key)) {
                continue;
            }
            const key = String(pair.key.value);
            if (key in jsObj) {
                annotateLines(pair.value as Node, jsObj[key] as unknown, source, displayFile);
            }
        }
    }
    else if (isSeq(node) && Array.isArray(jsValue)) {
        for (let idx = 0; idx < node.items.length; idx++) {
            annotateLines(node.items[idx] as Node, jsValue[idx], source, displayFile);
        }
    }
}

// Reads and parses a YAML file, annotating each entry with sourceFile and sourceLine.
// displayFile is the path shown in log output (e.g. ".claude/permissions.yaml").
// Returns null if the file does not exist. Throws on invalid YAML.
function readYamlFile(filePath: string, displayFile: string): IYamlConfig | null {
    if (!existsSync(filePath)) {
        return null;
    }
    const content = readFileSync(filePath, "utf-8");
    const doc = parseDocument(content);
    if (doc.errors.length > 0) {
        throw doc.errors[0];
    }
    const config: IYamlConfig = doc.toJS();
    annotateLines(doc.contents, config, content, displayFile);
    return config;
}

// Recursively validates a single rule entry and appends any problems to errors.
// path is the dot-path string used in error messages (e.g. "bash.git[0].log[0]").
// When called with isToolNameEntry=true, unknown keys are flagged as errors instead of being
// walked as bash sub-binary structure (tool-name rules have no sub-binary layer).
function validateEntry(entry: IYamlEntry, path: string, errors: IConfigError[], options?: IEntryWalkOptions): void {
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
    const isToolNameEntry = options !== undefined && options.isToolNameEntry;
    if (entry.decide === undefined && entry.rules === undefined && (isToolNameEntry || subcommandKeys.length === 0)) {
        errors.push({ path, message: `entry has neither 'decide', 'rules', nor subcommand keys and will always abstain` });
    }
    if (entry.rules !== undefined) {
        for (let index = 0; index < entry.rules.length; index++) {
            validateEntry(entry.rules[index], `${path}.rules[${index}]`, errors, options);
        }
    }
    if (isToolNameEntry) {
        for (const unknownKey of subcommandKeys) {
            errors.push({ path: `${path}.${unknownKey}`, message: `unknown field '${unknownKey}' on tool-name rule '${path}'` });
        }
        return;
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
// Validates: (a) bash section entries, (b) named file-tool sections (read/write/edit/multi_edit/webfetch),
// (c) top-level tool-name entries (any other top-level key), and (d) KNOWN_FIELDS collisions
// at the top level (e.g. a stray `decide: allow` instead of nesting under a tool name).
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
    const nonBashSections = ["read", "write", "edit", "multi_edit", "webfetch"];
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
    const toolNameOptions: IEntryWalkOptions = { isToolNameEntry: true };
    for (const key of Object.keys(config)) {
        if (KNOWN_SECTIONS.has(key)) {
            continue;
        }
        if (KNOWN_FIELDS.has(key)) {
            errors.push({
                path: key,
                message: `top-level key '${key}' is a reserved rule field; tool-name rules cannot use these as keys`,
            });
            continue;
        }
        const sectionValue = (config as Record<string, IYamlEntry | IYamlEntry[] | undefined>)[key];
        if (sectionValue === undefined) {
            continue;
        }
        const entries = normalizeToList(sectionValue);
        for (let index = 0; index < entries.length; index++) {
            const entryPath = index > 0 ? `${key}[${index}]` : key;
            validateEntry(entries[index], entryPath, errors, toolNameOptions);
        }
    }
    return errors;
}

// Compiles all rules from a merged config object
function compileConfig(config: IYamlConfig): IRule[] {
    const compiledRules: IRule[] = [];

    if (config.bash !== undefined) {
        compiledRules.push(...compileBashSection(config.bash));
    }

    compiledRules.push(...compileNonBashSections(config));
    compiledRules.push(...compileTopLevelToolRules(config));

    return compiledRules;
}

// loadConfigRulesFromFile reads and compiles a single YAML permissions file.
// displayFile is the path shown in log output. baseDir is used to resolve relative cwd patterns.
// Returns [] if the file does not exist.
export function loadConfigRulesFromFile(filePath: string, displayFile: string, baseDir: string): IRule[] {
    const config = readYamlFile(filePath, displayFile);
    if (config === null) {
        return [];
    }
    expandConfigEnvTokens(config, process.env["CLAUDE_PROJECT_DIR"], process.env["HOME"], displayFile);
    resolveRelativeCwdPatterns(config, baseDir);
    const projectDir = process.env["CLAUDE_PROJECT_DIR"];
    if (projectDir !== undefined) {
        resolveRelativeCmdPatterns(config, projectDir);
    }
    const configErrors = validateConfig(config);
    for (const configError of configErrors) {
        process.stderr.write(`[CONFIG ERROR] ${configError.path}: ${configError.message}\n`);
    }
    return compileConfig(config);
}

// loadHomeConfigRules loads rules from $HOME/.claude/permissions.yaml.
// Returns [] if HOME is unset or the file does not exist.
export function loadHomeConfigRules(): IRule[] {
    const homeDir = process.env["HOME"];
    if (homeDir === undefined) {
        return [];
    }
    return loadConfigRulesFromFile(
        join(homeDir, ".claude", "permissions.yaml"),
        "~/.claude/permissions.yaml",
        homeDir
    );
}

// loadProjectConfigRules loads rules from $CLAUDE_PROJECT_DIR/.claude/permissions.yaml.
// Returns [] if CLAUDE_PROJECT_DIR is unset or the file does not exist.
export function loadProjectConfigRules(): IRule[] {
    const projectDir = process.env["CLAUDE_PROJECT_DIR"];
    if (projectDir === undefined) {
        return [];
    }
    return loadConfigRulesFromFile(
        join(projectDir, ".claude", "permissions.yaml"),
        ".claude/permissions.yaml",
        projectDir
    );
}

// IConfigFileSource describes one discovered drop-in permissions file.
// Used by the directory-scan helpers and the FileLayer construction in pre-hook/analyze.
export interface IConfigFileSource {
    // Absolute path on disk to the YAML file.
    filePath: string;
    // Path used for log output (e.g. "~/.claude/permissions.d/aws.yaml").
    displayPath: string;
    // Base directory used to resolve "./" cwd patterns inside the file.
    baseDir: string;
}

// Returns true when entryName is a file that should be treated as a permissions drop-in.
// Excludes dotfiles and entries that are not regular files. The yaml/yml extension check is
// performed by the caller because it does not need the disk stat.
function isDropInFileCandidate(dirPath: string, entryName: string): boolean {
    if (entryName.startsWith(".")) {
        return false;
    }
    const stat = statSync(join(dirPath, entryName));
    return stat.isFile();
}

// discoverConfigDirFiles enumerates the YAML drop-in files inside dirPath and returns one
// IConfigFileSource per file. Files are sorted lexicographically. Returns [] when the directory
// does not exist or is not a directory.
export function discoverConfigDirFiles(dirPath: string, displayPrefix: string, baseDir: string): IConfigFileSource[] {
    if (!existsSync(dirPath)) {
        return [];
    }
    const dirStat = statSync(dirPath);
    if (!dirStat.isDirectory()) {
        return [];
    }
    const allEntries = readdirSync(dirPath);
    const matchingNames: string[] = [];
    for (const entryName of allEntries) {
        if (!entryName.endsWith(".yaml") && !entryName.endsWith(".yml")) {
            continue;
        }
        if (!isDropInFileCandidate(dirPath, entryName)) {
            continue;
        }
        matchingNames.push(entryName);
    }
    matchingNames.sort();
    const sources: IConfigFileSource[] = [];
    for (const name of matchingNames) {
        sources.push({
            filePath: join(dirPath, name),
            displayPath: displayPrefix + "/" + name,
            baseDir,
        });
    }
    return sources;
}

// discoverHomeConfigDirFiles enumerates $HOME/.claude/permissions.d/*.yaml drop-ins.
// Returns [] when HOME is unset or the directory does not exist.
export function discoverHomeConfigDirFiles(): IConfigFileSource[] {
    const homeDir = process.env["HOME"];
    if (homeDir === undefined) {
        return [];
    }
    return discoverConfigDirFiles(
        join(homeDir, ".claude", "permissions.d"),
        "~/.claude/permissions.d",
        homeDir
    );
}

// discoverProjectConfigDirFiles enumerates $CLAUDE_PROJECT_DIR/.claude/permissions.d/*.yaml drop-ins.
// Returns [] when CLAUDE_PROJECT_DIR is unset or the directory does not exist.
export function discoverProjectConfigDirFiles(): IConfigFileSource[] {
    const projectDir = process.env["CLAUDE_PROJECT_DIR"];
    if (projectDir === undefined) {
        return [];
    }
    return discoverConfigDirFiles(
        join(projectDir, ".claude", "permissions.d"),
        ".claude/permissions.d",
        projectDir
    );
}

// makeConfigFileLoader returns a no-arg loader closure suitable for FileLayer, using the
// fields of the given source to call loadConfigRulesFromFile.
export function makeConfigFileLoader(source: IConfigFileSource): () => IRule[] {
    return function configFileLoader(): IRule[] {
        return loadConfigRulesFromFile(source.filePath, source.displayPath, source.baseDir);
    };
}

// Loads .claude/permissions.yaml from home and project dirs, merges (project beats home),
// compiles each entry into Rule closures, and returns the combined list.
// Returns [] when env vars are absent or files are missing.
// Validation is performed per-file before merging so that errors in one file are detected
// even when the other file's keys would shallow-merge over them.
export function loadConfigRules(): IRule[] {
    let homeConfig: IYamlConfig = {};
    let projectConfig: IYamlConfig = {};

    const homeDir = process.env["HOME"];
    if (homeDir !== undefined) {
        const homeYaml = readYamlFile(join(homeDir, ".claude", "permissions.yaml"), "~/.claude/permissions.yaml");
        if (homeYaml !== null) {
            expandConfigEnvTokens(homeYaml, process.env["CLAUDE_PROJECT_DIR"], process.env["HOME"], "~/.claude/permissions.yaml");
            resolveRelativeCwdPatterns(homeYaml, homeDir);
            const homeProjectDir = process.env["CLAUDE_PROJECT_DIR"];
            if (homeProjectDir !== undefined) {
                resolveRelativeCmdPatterns(homeYaml, homeProjectDir);
            }
            const homeErrors = validateConfig(homeYaml);
            for (const configError of homeErrors) {
                process.stderr.write(`[CONFIG ERROR] (~/.claude/permissions.yaml) ${configError.path}: ${configError.message}\n`);
            }
            homeConfig = homeYaml;
        }
    }

    const projectDir = process.env["CLAUDE_PROJECT_DIR"];
    if (projectDir !== undefined) {
        const projectYaml = readYamlFile(join(projectDir, ".claude", "permissions.yaml"), ".claude/permissions.yaml");
        if (projectYaml !== null) {
            expandConfigEnvTokens(projectYaml, projectDir, process.env["HOME"], ".claude/permissions.yaml");
            resolveRelativeCwdPatterns(projectYaml, projectDir);
            resolveRelativeCmdPatterns(projectYaml, projectDir);
            const projectErrors = validateConfig(projectYaml);
            for (const configError of projectErrors) {
                process.stderr.write(`[CONFIG ERROR] (.claude/permissions.yaml) ${configError.path}: ${configError.message}\n`);
            }
            projectConfig = projectYaml;
        }
    }

    const merged: IYamlConfig = { ...homeConfig, ...projectConfig };
    if (homeConfig.bash !== undefined && projectConfig.bash !== undefined) {
        merged.bash = { ...homeConfig.bash, ...projectConfig.bash };
    }
    return compileConfig(merged);
}
