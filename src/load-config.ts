import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { parse } from "yaml";
import picomatch from "picomatch";
import { Rule, RuleOutcome, AstNode, Environment, ToolCall, ABSTAIN, Decision, Command } from "./types";

// Valid decide values in YAML config
type DecideValue = "allow" | "deny" | "ask" | "abstain";

// Union of all possible values within a YAML entry
type IEntryValue = string | boolean | string[] | Record<string, string> | IYamlEntry | IYamlEntry[];

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
const KNOWN_FIELDS = new Set(["decide", "reason", "cmd", "cmd-in", "options", "options-in", "cwd", "cwd-in", "cwd_resolved", "env", "path", "path-in", "host", "host-in", "tool", "tool-in"]);

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

        return { decision };
    };

    Object.defineProperty(rule, "name", { value: ruleName });
    return rule;
}

// Recursively compiles all rules for a binary and its subcommand hierarchy
function compileBashBinary(binary: string, entries: IYamlEntry[], subcommandPath: string[]): Rule[] {
    const compiledRules: Rule[] = [];

    for (const entry of entries) {
        const subcommandKeys = Object.keys(entry).filter((key: string) => !KNOWN_FIELDS.has(key));

        if (typeof entry.decide === "string") {
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

// Compiles one rule for a file-path-based tool (read/write/edit/multiedit)
function buildFileRule(nodeType: string, entry: IYamlEntry): Rule {
    const decision = mapDecision(entry.decide as DecideValue, entry.reason);
    const ruleName = `yaml:${nodeType}:${entry.decide}`;

    const rule: Rule = function(node: AstNode, env: Environment, _call: ToolCall): RuleOutcome {
        if (node.type !== nodeType) {
            return ABSTAIN;
        }
        if (!("file_path" in node)) {
            return ABSTAIN;
        }

        const filePath = (node as { file_path: string }).file_path;

        if (!matchesPath(entry, filePath)) {
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

// Compiles one rule for a webfetch entry
function buildWebFetchRule(entry: IYamlEntry): Rule {
    const decision = mapDecision(entry.decide as DecideValue, entry.reason);
    const ruleName = `yaml:webfetch:${entry.decide}`;

    const rule: Rule = function(node: AstNode, env: Environment, _call: ToolCall): RuleOutcome {
        if (node.type !== "other" || node.tool_name !== "WebFetch") {
            return ABSTAIN;
        }

        const url = typeof node.tool_input["url"] === "string" ? node.tool_input["url"] : "";
        const hostname = extractHost(url);

        if (entry.host !== undefined && !matchesPattern(entry.host, hostname)) {
            return ABSTAIN;
        }
        if (entry["host-in"] !== undefined) {
            const hostIn = entry["host-in"] as string[];
            if (!hostIn.some((pattern: string) => matchesPattern(pattern, hostname))) {
                return ABSTAIN;
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

        return { decision };
    };

    Object.defineProperty(rule, "name", { value: ruleName });
    return rule;
}

// Compiles one rule for an MCP tool entry
function buildMcpRule(entry: IYamlEntry): Rule {
    const decision = mapDecision(entry.decide as DecideValue, entry.reason);
    const ruleName = `yaml:mcp:${entry.decide}`;

    const rule: Rule = function(node: AstNode, env: Environment, _call: ToolCall): RuleOutcome {
        if (node.type !== "other") {
            return ABSTAIN;
        }

        if (entry["tool-in"] !== undefined) {
            const toolIn = entry["tool-in"] as string[];
            if (!toolIn.some((pattern: string) => matchesPattern(pattern, node.tool_name))) {
                return ABSTAIN;
            }
        }
        if (entry.tool !== undefined && !matchesPattern(entry.tool, node.tool_name)) {
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

        return { decision };
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
            compiledRules.push(buildFileRule(nodeType, entry));
        }
    }

    if (config.webfetch !== undefined) {
        const entries = normalizeToList(config.webfetch);
        for (const entry of entries) {
            compiledRules.push(buildWebFetchRule(entry));
        }
    }

    if (config.mcp !== undefined) {
        const entries = normalizeToList(config.mcp);
        for (const entry of entries) {
            compiledRules.push(buildMcpRule(entry));
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
    return compileConfig(merged);
}
