import { join } from "path";
import { decide } from "./interpret";
import { createLogger } from "./audit-log";
import { ToolCall } from "./types";
import { resolveDebugLogPath, appendDebugBlock, logDebugError, IDebugField } from "./debug-log";
import { RuleLayer, FileLayer, RuleRegistry } from "./rule-registry";
import { builtinRules } from "./rules";
import { loadHomeConfigRules, loadProjectConfigRules } from "./load-config";

// hookEventName identifies the Claude Code hook event this runner handles.
const hookEventName = "PreToolUse";

// readStdin reads all of stdin and returns it as a UTF-8 string.
export async function readStdin(): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
        chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks).toString("utf-8");
}

// runHook parses the ToolCall from stdin, runs the permission decision, and writes
// the hookSpecificOutput to stdout, then exits 0. On any error it writes to stderr and exits 1.
export async function runHook(): Promise<void> {
    let logPath: string | undefined;
    try {
        const rawStdin = await readStdin();
        const call = JSON.parse(rawStdin) as ToolCall;
        const projectDir = process.env["CLAUDE_PROJECT_DIR"];
        if (!projectDir) {
            throw new Error("CLAUDE_PROJECT_DIR is not set");
        }
        logPath = resolveDebugLogPath(projectDir);
        await appendDebugBlock(logPath, "[PRE-HOOK ENTRY]", [
            { key: "tool_call", value: call },
            { key: "CLAUDE_PROJECT_DIR", value: projectDir },
            { key: "process.env", value: process.env },
        ]);
        const logger = createLogger(projectDir, new Date());
        const homeFilePath = process.env["HOME"] !== undefined
            ? join(process.env["HOME"], ".claude", "permissions.yaml")
            : undefined;
        const projectFilePath = join(projectDir, ".claude", "permissions.yaml");
        const registry = new RuleRegistry([
            new RuleLayer(builtinRules),
            new FileLayer(loadHomeConfigRules, homeFilePath, "~/.claude/permissions.yaml", logger),
            new FileLayer(loadProjectConfigRules, projectFilePath, ".claude/permissions.yaml", logger),
        ]);
        const decision = decide(call, logger, registry);
        const permissionDecision = decision.action;
        const permissionDecisionReason = "reason" in decision ? decision.reason : undefined;
        const exitFields: IDebugField[] = [{ key: "decision", value: permissionDecision }];
        if (permissionDecisionReason !== undefined) {
            exitFields.push({ key: "reason", value: permissionDecisionReason });
        }
        await appendDebugBlock(logPath, "[PRE-HOOK EXIT]", exitFields);
        process.stdout.write(
            JSON.stringify({ hookSpecificOutput: { hookEventName, permissionDecision, permissionDecisionReason } }) + "\n"
        );
        process.exit(0);
    }
    catch (hookError) {
        await logDebugError(logPath, hookError);
        process.stderr.write(String(hookError) + "\n");
        process.exit(1);
    }
}

// Guard lets the module be imported by unit tests without auto-invoking in Jest.
if (process.env["NODE_ENV"] !== "test") {
    runHook();
}
