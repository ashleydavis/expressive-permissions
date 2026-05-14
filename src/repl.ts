import * as readline from "readline";
import { analyzePermission, IAnalysisResult } from "./analyze";
import { IAuditLogEntry, formatTextEntry } from "./audit-log";

// ANSI holds terminal escape codes used for colorised output.
const ANSI = {
    green: "\x1b[32m",
    red: "\x1b[31m",
    yellow: "\x1b[33m",
    dim: "\x1b[2m",
    bold: "\x1b[1m",
    reset: "\x1b[0m",
};

// colorForDecision returns the ANSI color code for a given decision string.
export function colorForDecision(decision: string): string {
    if (decision === "allow") {
        return ANSI.green;
    }
    if (decision === "deny") {
        return ANSI.red;
    }
    if (decision === "ask") {
        return ANSI.yellow;
    }
    return ANSI.dim;
}

// formatTrace formats audit log entries for terminal display. config_load and
// tool_request entries are suppressed as they add noise without showing rule matches.
export function formatTrace(entries: IAuditLogEntry[]): string {
    const lines: string[] = [];
    for (const entry of entries) {
        if (entry.type === "config_load" || entry.type === "tool_request") {
            continue;
        }
        lines.push(`${ANSI.dim}  ${formatTextEntry(entry)}${ANSI.reset}`);
    }
    return lines.join("\n");
}

// formatVerdict produces the final verdict line showing the colored, bolded decision
// word and an optional dim reason.
export function formatVerdict(result: IAnalysisResult): string {
    const color = colorForDecision(result.decision);
    const decisionWord = `${color}${ANSI.bold}${result.decision.toUpperCase()}${ANSI.reset}`;
    if (result.reason !== undefined && result.reason !== "") {
        return `${decisionWord}${ANSI.dim} — ${result.reason}${ANSI.reset}`;
    }
    return decisionWord;
}

// runOnce analyzes the input and prints the trace followed by the verdict.
export function runOnce(input: string, cwd: string, projectDir: string): void {
    const result = analyzePermission(input, cwd, projectDir);
    const traceOutput = formatTrace(result.trace);
    if (traceOutput !== "") {
        process.stdout.write(traceOutput + "\n");
    }
    process.stdout.write(formatVerdict(result) + "\n");
}

// runRepl starts an interactive REPL session. On each line it analyzes the input and
// prints the trace and verdict. :quit/:q exits, :cwd <path> changes the working directory.
export async function runRepl(projectDir: string, initialCwd: string): Promise<void> {
    let currentCwd = initialCwd;

    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });

    process.stdout.write(
        `${ANSI.bold}permissions REPL${ANSI.reset}\n` +
        `${ANSI.dim}project: ${projectDir}${ANSI.reset}\n` +
        `${ANSI.dim}cwd:     ${currentCwd}${ANSI.reset}\n` +
        `Type a command to analyze, :cwd <path> to change directory, :quit to exit.\n\n`
    );

    const prompt = (): void => {
        rl.question("permissions> ", handleLine);
    };

    const handleLine = (line: string): void => {
        const trimmed = line.trim();

        if (trimmed === "") {
            prompt();
            return;
        }

        if (trimmed === ":quit" || trimmed === ":q") {
            rl.close();
            return;
        }

        if (trimmed.startsWith(":cwd ")) {
            currentCwd = trimmed.slice(":cwd ".length).trim();
            process.stdout.write(`${ANSI.dim}cwd changed to: ${currentCwd}${ANSI.reset}\n`);
            prompt();
            return;
        }

        runOnce(trimmed, currentCwd, projectDir);
        process.stdout.write("\n");
        prompt();
    };

    await new Promise<void>((resolve) => {
        rl.on("close", () => {
            process.stdout.write("\n");
            resolve();
        });
        prompt();
    });
}

// Guard prevents auto-invocation when imported by tests.
if (process.env["NODE_ENV"] !== "test") {
    const projectDir = process.env["CLAUDE_PROJECT_DIR"] ?? process.cwd();

    if (process.argv[2] !== undefined) {
        runOnce(process.argv[2], process.cwd(), projectDir);
        process.exit(0);
    }
    else {
        runRepl(projectDir, process.cwd());
    }
}
