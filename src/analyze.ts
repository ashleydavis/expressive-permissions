import { CapturingAuditLogger, IAuditLogEntry, IAuditLogger } from "./audit-log";
import { loadHomeConfigRules, loadProjectConfigRules, discoverHomeConfigDirFiles, discoverProjectConfigDirFiles, makeConfigFileLoader } from "./load-config";
import { RuleLayer, FileLayer, IRuleLayer, RuleRegistry } from "./rule-registry";
import { builtinRules } from "./rules";
import { decide } from "./interpret";
import { IToolCall } from "./types";

// IAnalysisResult holds the outcome of a single permission analysis pass.
export interface IAnalysisResult {
    // The final decision string: "allow", "deny", or "ask".
    decision: string;
    // The human-readable reason attached to the decision, if any.
    reason?: string;
    // All audit entries captured during evaluation.
    trace: IAuditLogEntry[];
}

// parseToolCallInput converts a user-supplied string into a ToolCall. The input
// may be prefixed (case-insensitive) to produce a non-Bash tool call:
//   "read <path>"     -> Read tool
//   "write <path>"    -> Write tool
//   "edit <path>"     -> Edit tool
//   "webfetch <url>"  -> WebFetch tool
//   "tool <name>"     -> generic other-tool call
//   anything else     -> Bash tool with command = full input
export function parseToolCallInput(input: string, cwd: string): IToolCall {
    const lower = input.toLowerCase();

    if (lower.startsWith("read ")) {
        const filePath = input.slice("read ".length);
        return { tool_name: "Read", tool_input: { file_path: filePath }, cwd };
    }

    if (lower.startsWith("write ")) {
        const filePath = input.slice("write ".length);
        return { tool_name: "Write", tool_input: { file_path: filePath, content: "" }, cwd };
    }

    if (lower.startsWith("edit ")) {
        const filePath = input.slice("edit ".length);
        return { tool_name: "Edit", tool_input: { file_path: filePath, old_string: "", new_string: "" }, cwd };
    }

    if (lower.startsWith("webfetch ")) {
        const url = input.slice("webfetch ".length);
        return { tool_name: "WebFetch", tool_input: { url }, cwd };
    }

    if (lower.startsWith("tool ")) {
        const toolName = input.slice("tool ".length);
        return { tool_name: toolName, tool_input: {}, cwd };
    }

    return { tool_name: "Bash", tool_input: { command: input }, cwd };
}

// buildAnalysisRegistry constructs a RuleRegistry with three layers: built-in rules,
// home config rules, and project config rules. Sets CLAUDE_PROJECT_DIR in process.env
// to projectDir before calling loaders, then restores the original value.
export function buildAnalysisRegistry(projectDir: string, logger: IAuditLogger): RuleRegistry {
    const originalProjectDir = process.env["CLAUDE_PROJECT_DIR"];
    process.env["CLAUDE_PROJECT_DIR"] = projectDir;

    const layers: IRuleLayer[] = [
        new RuleLayer(builtinRules),
        new FileLayer(loadHomeConfigRules, "~/.claude/permissions.yaml", logger),
    ];
    for (const homeDropInSource of discoverHomeConfigDirFiles()) {
        layers.push(new FileLayer(makeConfigFileLoader(homeDropInSource), homeDropInSource.displayPath, logger));
    }
    layers.push(new FileLayer(loadProjectConfigRules, ".claude/permissions.yaml", logger));
    for (const projectDropInSource of discoverProjectConfigDirFiles()) {
        layers.push(new FileLayer(makeConfigFileLoader(projectDropInSource), projectDropInSource.displayPath, logger));
    }
    const registry = new RuleRegistry(layers);

    if (originalProjectDir === undefined) {
        delete process.env["CLAUDE_PROJECT_DIR"];
    }
    else {
        process.env["CLAUDE_PROJECT_DIR"] = originalProjectDir;
    }

    return registry;
}

// analyzePermission parses the input string into a ToolCall, builds a fresh registry
// for projectDir, runs decide(), and returns the decision, reason, and full trace.
export function analyzePermission(input: string, cwd: string, projectDir: string): IAnalysisResult {
    const logger = new CapturingAuditLogger();
    const registry = buildAnalysisRegistry(projectDir, logger);
    const toolCall = parseToolCallInput(input, cwd);
    const decision = decide(toolCall, logger, registry);

    return {
        decision: decision.action,
        reason: "reason" in decision ? decision.reason : undefined,
        trace: logger.getEntries(),
    };
}
