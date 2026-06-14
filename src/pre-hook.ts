import { decide } from "./interpret";
import { createLogger, ensureLogDirIgnored, resolveLogBaseDir } from "./audit-log";
import { IToolCall } from "./types";
// Debug log file production disabled. Restore to re-enable the debug log.
// import { resolveDebugLogPath, appendDebugBlock, logDebugError, IDebugField } from "./debug-log";
import { RuleLayer, FileLayer, IRuleLayer, RuleRegistry } from "./rule-registry";
import { builtinRules } from "./rules";
import { loadHomeConfigRules, loadProjectConfigRules, discoverHomeConfigDirFiles, discoverProjectConfigDirFiles, makeConfigFileLoader } from "./load-config";
import { loadCommandDescriptors } from "./load-commands";
import { homedir } from "os";

// hookEventName identifies the Claude Code hook event this runner handles.
const hookEventName = "PreToolUse";

// homeDir is resolved once at module load time so all invocations within this process share it.
const homeDir = homedir();

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
    // Debug log file production disabled. Restore to re-enable the debug log.
    // let logPath: string | undefined;
    try {
        const rawStdin = await readStdin();
        const call = JSON.parse(rawStdin) as IToolCall;
        const projectDir = process.env["CLAUDE_PROJECT_DIR"];
        if (!projectDir) {
            throw new Error("CLAUDE_PROJECT_DIR is not set");
        }
        // Debug log file production disabled. Restore to re-enable the debug log.
        // logPath = resolveDebugLogPath(projectDir);
        // await appendDebugBlock(logPath, "[PRE-HOOK ENTRY]", [
        //     { key: "tool_call", value: call },
        //     { key: "CLAUDE_PROJECT_DIR", value: projectDir },
        //     { key: "process.env", value: process.env },
        // ]);
        const logger = createLogger(projectDir, new Date());
        await ensureLogDirIgnored(resolveLogBaseDir(projectDir));
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
        const descriptors = await loadCommandDescriptors(homeDir, projectDir);
        const decision = decide(call, logger, registry, descriptors);
        const permissionDecision = decision.action;
        const permissionDecisionReason = "reason" in decision ? decision.reason : undefined;
        // Debug log file production disabled. Restore to re-enable the debug log.
        // const exitFields: IDebugField[] = [{ key: "decision", value: permissionDecision }];
        // if (permissionDecisionReason !== undefined) {
        //     exitFields.push({ key: "reason", value: permissionDecisionReason });
        // }
        // await appendDebugBlock(logPath, "[PRE-HOOK EXIT]", exitFields);
        process.stdout.write(
            JSON.stringify({ hookSpecificOutput: { hookEventName, permissionDecision, permissionDecisionReason } }) + "\n"
        );
        process.exit(0);
    }
    catch (hookError) {
        // Debug log file production disabled. Restore to re-enable the debug log.
        // await logDebugError(logPath, hookError);
        process.stderr.write(String(hookError) + "\n");
        process.exit(1);
    }
}

// Guard lets the module be imported by unit tests without auto-invoking in Jest.
if (process.env["NODE_ENV"] !== "test") {
    runHook();
}
