import { createLogger } from "./audit-log";
import { IPostToolUseCall } from "./types";
import { toLocalISOString } from "./audit-log";
// Debug log file production disabled. Restore to re-enable the debug log.
// import { resolveDebugLogPath, appendDebugBlock, logDebugError } from "./debug-log";

// readPostStdin reads all of stdin and returns it as a UTF-8 string.
export async function readPostStdin(): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
        chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks).toString("utf-8");
}

// runPostHook parses the IPostToolUseCall from stdin, logs a tool_execution audit entry, and exits 0.
// On any error it writes to stderr and exits 1.
export async function runPostHook(): Promise<void> {
    // Debug log file production disabled. Restore to re-enable the debug log.
    // let logPath: string | undefined;
    try {
        const call = JSON.parse(await readPostStdin()) as IPostToolUseCall;
        const projectDir = process.env["CLAUDE_PROJECT_DIR"];
        if (!projectDir) {
            throw new Error("CLAUDE_PROJECT_DIR is not set");
        }
        // Debug log file production disabled. Restore to re-enable the debug log.
        // logPath = resolveDebugLogPath(projectDir);
        // await appendDebugBlock(logPath, "[POST-HOOK ENTRY]", [
        //     { key: "tool_call", value: call },
        //     { key: "process.env", value: process.env },
        // ]);
        const logger = createLogger(projectDir, new Date());
        const isError = typeof call.tool_response["isError"] === "boolean"
            ? call.tool_response["isError"] as boolean
            : false;
        logger.log({
            type: "tool_execution",
            timestamp: toLocalISOString(new Date()),
            tool: call.tool_name,
            input: call.tool_input as Record<string, unknown>,
            cwd: call.cwd,
            response: call.tool_response,
            isError,
        });
        // Debug log file production disabled. Restore to re-enable the debug log.
        // await appendDebugBlock(logPath, "[POST-HOOK EXIT]", [
        //     { key: "tool", value: call.tool_name },
        //     { key: "isError", value: isError },
        // ]);
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
    runPostHook();
}
