import { appendFile, mkdir } from "fs/promises";
import { join } from "path";
import { toLocalISOString } from "./audit-log";

// resolveDebugLogPath returns the path to the plain-text debug log file
// for the given project root: <projectDir>/.claude/permissions-debug.log.
export function resolveDebugLogPath(projectDir: string): string {
    return join(projectDir, ".claude", "permissions-debug.log");
}

// IDebugField is a key-value pair logged as a field within a debug block.
// String values are written as-is; all other values are JSON-serialized with indentation.
export interface IDebugField {
    // The label printed before the colon.
    key: string;
    // The value to serialize and print.
    value: unknown;
}

// appendDebugBlock writes a timestamped multi-line block to the debug log file.
// The header line is prefixed with a local ISO timestamp. Each field is written as
// "  key: value"; object values are pretty-printed with JSON.stringify and each
// resulting line is indented two spaces. A single appendFile call writes the block.
export async function appendDebugBlock(logPath: string, header: string, fields: IDebugField[]): Promise<void> {
    await mkdir(join(logPath, ".."), { recursive: true });
    const timestamp = toLocalISOString(new Date());
    const formattedLines: string[] = [`${timestamp} ${header}`];
    for (const field of fields) {
        const serialized = typeof field.value === "string" ? field.value : JSON.stringify(field.value, null, 2);
        const valueLines = serialized.split("\n");
        formattedLines.push(`  ${field.key}: ${valueLines[0]}`);
        for (let index = 1; index < valueLines.length; index++) {
            formattedLines.push(`  ${valueLines[index]}`);
        }
    }
    await appendFile(logPath, formattedLines.join("\n") + "\n");
}

// logDebugError writes an [ERROR] entry to the debug log (when logPath is known)
// and unconditionally writes the error to process.stdout.
export async function logDebugError(logPath: string | undefined, error: unknown): Promise<void> {
    const errorMessage = String(error);
    if (logPath !== undefined) {
        await appendDebugBlock(logPath, "[ERROR]", [{ key: "error", value: errorMessage }]);
    }
    process.stdout.write(`[ERROR] ${errorMessage}\n`);
}
