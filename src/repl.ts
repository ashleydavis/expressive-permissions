import * as readline from "readline";
import { analyzePermission, IAnalysisResult } from "./analyze";
import { IAuditLogEntry, formatTextEntry } from "./audit-log";
import { homedir } from "os";

// homeDir is resolved once at module load time.
const homeDir = homedir();

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
export async function runOnce(input: string, cwd: string, projectDir: string, replHomeDir: string): Promise<void> {
    const result = await analyzePermission(input, cwd, projectDir, replHomeDir);
    const traceOutput = formatTrace(result.trace);
    if (traceOutput !== "") {
        process.stdout.write(traceOutput + "\n");
    }
    process.stdout.write(formatVerdict(result) + "\n");
}

// ReplCommandKind enumerates the discrete command variants produced by parseReplCommand.
export type ReplCommandKind = "empty" | "quit" | "set-cwd" | "set-project" | "analyze";

// IReplCommandEmpty represents a blank input line that should reprompt without action.
export interface IReplCommandEmpty {
    // Discriminator for the empty variant.
    kind: "empty";
}

// IReplCommandQuit represents a request to exit the REPL session.
export interface IReplCommandQuit {
    // Discriminator for the quit variant.
    kind: "quit";
}

// IReplCommandSetCwd represents a request to change the runtime cwd only.
export interface IReplCommandSetCwd {
    // Discriminator for the set-cwd variant.
    kind: "set-cwd";
    // The new cwd path supplied by the user (already trimmed of surrounding whitespace).
    path: string;
}

// IReplCommandSetProject represents a request to change both the project dir and cwd.
export interface IReplCommandSetProject {
    // Discriminator for the set-project variant.
    kind: "set-project";
    // The new project-dir path supplied by the user (also used as the new cwd).
    path: string;
}

// IReplCommandAnalyze represents a tool-call input to analyze through the engine.
export interface IReplCommandAnalyze {
    // Discriminator for the analyze variant.
    kind: "analyze";
    // The raw tool-call input string (trimmed but otherwise unmodified).
    input: string;
}

// ReplCommand is the discriminated union of every command that the REPL line handler dispatches on.
export type ReplCommand = IReplCommandEmpty | IReplCommandQuit | IReplCommandSetCwd | IReplCommandSetProject | IReplCommandAnalyze;

// parseReplCommand classifies a raw REPL input line into a ReplCommand variant.
// Recognised prefixes: :quit/:q, :cwd <path>, :project <path>, :proj <path>.
// Anything else is treated as a tool-call input for analysis.
export function parseReplCommand(line: string): ReplCommand {
    const trimmed = line.trim();

    if (trimmed === "") {
        return { kind: "empty" };
    }

    if (trimmed === ":quit" || trimmed === ":q") {
        return { kind: "quit" };
    }

    if (trimmed.startsWith(":cwd ")) {
        return { kind: "set-cwd", path: trimmed.slice(":cwd ".length).trim() };
    }

    if (trimmed.startsWith(":project ")) {
        return { kind: "set-project", path: trimmed.slice(":project ".length).trim() };
    }

    if (trimmed.startsWith(":proj ")) {
        return { kind: "set-project", path: trimmed.slice(":proj ".length).trim() };
    }

    return { kind: "analyze", input: trimmed };
}

// runRepl starts an interactive REPL session. On each line it analyzes the input and
// prints the trace and verdict. :quit/:q exits, :cwd <path> changes the runtime cwd,
// and :project <path> (alias :proj) changes both the project dir and the cwd together.
export async function runRepl(initialProjectDir: string, initialCwd: string, replHomeDir: string): Promise<void> {
    let currentProjectDir = initialProjectDir;
    let currentCwd = initialCwd;

    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });

    process.stdout.write(
        `${ANSI.bold}permissions REPL${ANSI.reset}\n` +
        `${ANSI.dim}project: ${currentProjectDir}${ANSI.reset}\n` +
        `${ANSI.dim}cwd:     ${currentCwd}${ANSI.reset}\n` +
        `Type a command to analyze, :project <path> to set project+cwd, :cwd <path> to change cwd only, :quit to exit.\n\n`
    );

    const prompt = (): void => {
        rl.question("permissions> ", handleLine);
    };

    const handleLine = (line: string): void => {
        const command = parseReplCommand(line);

        if (command.kind === "empty") {
            prompt();
            return;
        }

        if (command.kind === "quit") {
            rl.close();
            return;
        }

        if (command.kind === "set-cwd") {
            currentCwd = command.path;
            process.stdout.write(`${ANSI.dim}cwd changed to: ${currentCwd}${ANSI.reset}\n`);
            prompt();
            return;
        }

        if (command.kind === "set-project") {
            currentProjectDir = command.path;
            currentCwd = command.path;
            process.stdout.write(`${ANSI.dim}project changed to: ${currentProjectDir}${ANSI.reset}\n`);
            process.stdout.write(`${ANSI.dim}cwd changed to:     ${currentCwd}${ANSI.reset}\n`);
            prompt();
            return;
        }

        runOnce(command.input, currentCwd, currentProjectDir, replHomeDir).then(() => {
            process.stdout.write("\n");
            prompt();
        });
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
        runOnce(process.argv[2], process.cwd(), projectDir, homeDir).then(() => {
            process.exit(0);
        });
    }
    else {
        runRepl(projectDir, process.cwd(), homeDir);
    }
}
