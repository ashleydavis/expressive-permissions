import { decide } from "./interpret";
import { createLogger } from "./audit-log";
import { ToolCall } from "./types";

// Abort timer: kills the process if the hook takes longer than 5 seconds.
const abortTimer: NodeJS.Timeout = setTimeout(() => process.exit(1), 5000);
abortTimer.unref();

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
    try {
        const call = JSON.parse(await readStdin()) as ToolCall;
        const projectDir = process.env["CLAUDE_PROJECT_DIR"];
        if (!projectDir) {
            throw new Error("CLAUDE_PROJECT_DIR is not set");
        }
        const logger = createLogger(projectDir, new Date());
        const decision = decide(call, logger);
        const permissionDecision = decision.action;
        const permissionDecisionReason = "reason" in decision ? decision.reason : undefined;
        process.stdout.write(
            JSON.stringify({ hookSpecificOutput: { hookEventName, permissionDecision, permissionDecisionReason } }) + "\n"
        );
        process.exit(0);
    }
    catch (hookError) {
        process.stderr.write(String(hookError) + "\n");
        process.exit(1);
    }
}

// Guard lets the module be imported by unit tests without auto-invoking in Jest.
if (process.env["NODE_ENV"] !== "test") {
    runHook();
}
