import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { spawnSync } from "child_process";
import { tmpdir } from "os";
import { parse, stringify } from "yaml";

// ITestCaseInput describes the tool call input fields in a test case YAML file.
interface ITestCaseInput {
    // The Claude Code tool name (e.g. "Bash", "Read")
    tool_name: string;
    // The tool-specific input arguments
    tool_input: Record<string, unknown>;
    // The working directory for the tool call
    cwd: string;
}

// IAuditLogExpectedEntry describes one expected audit log entry to assert against.
// Only the listed fields are checked; extra fields in the actual entry are ignored.
interface IAuditLogExpectedEntry {
    // The type discriminator for this entry (e.g. "tool_request", "final_decision").
    type: string;
    // Additional fields to match against the parsed log entry.
    [key: string]: string;
}

// ITestCaseExpected describes the expected outcome fields in a test case YAML file.
interface ITestCaseExpected {
    // The expected permissionDecision value (allow, deny, or ask)
    decision: string;
    // When present, the permissionDecisionReason must match exactly
    reason?: string;
    // When present, the newest log file must contain matching entries for each item.
    audit_log?: IAuditLogExpectedEntry[];
}

// ITestCase describes the full structure of a test case YAML file.
interface ITestCase {
    // Human-readable description of what the test verifies
    description: string;
    // The tool call input fed to hook.ts via stdin
    input: ITestCaseInput;
    // Written verbatim as project/.claude/permissions.yaml for the test run
    rules: Record<string, unknown>;
    // The expected outputs from hook.ts
    expected: ITestCaseExpected;
}

// IHookSpecificOutput describes the hookSpecificOutput field in hook.ts stdout JSON.
interface IHookSpecificOutput {
    // The hook event name
    hookEventName: string;
    // The permission decision returned by the engine
    permissionDecision: string;
    // Optional human-readable reason attached to the decision
    permissionDecisionReason?: string;
}

// IHookOutput describes the full JSON object written to stdout by hook.ts.
interface IHookOutput {
    // The tool-specific output payload
    hookSpecificOutput: IHookSpecificOutput;
}

// findNewestLogFile recursively walks baseDir and returns the path of the most recently
// modified .log file, or null if none exist.
function findNewestLogFile(baseDir: string): string | null {
    let newestPath: string | null = null;
    let newestMtime = 0;

    function walk(dirPath: string): void {
        let entries: string[];
        try {
            entries = readdirSync(dirPath);
        }
        catch {
            return;
        }
        for (const entry of entries) {
            const fullPath = join(dirPath, entry);
            const stat = statSync(fullPath);
            if (stat.isDirectory()) {
                walk(fullPath);
            }
            else if (entry.endsWith(".log") && stat.mtimeMs > newestMtime) {
                newestMtime = stat.mtimeMs;
                newestPath = fullPath;
            }
        }
    }

    walk(baseDir);
    return newestPath;
}

// runTest parses one test case YAML file, spawns hook.ts with the test input, and
// compares the output to the expected values. Returns true on pass, false on fail.
function runTest(testFilePath: string): boolean {
    const content = readFileSync(testFilePath, "utf-8");
    const testCase = parse(content) as ITestCase;
    const tmpDir = mkdtempSync(join(tmpdir(), "claude-e2e-"));

    try {
        const homeDir = join(tmpDir, "home");
        const projectDir = join(tmpDir, "project");
        const claudeDir = join(projectDir, ".claude");

        mkdirSync(homeDir, { recursive: true });
        mkdirSync(claudeDir, { recursive: true });

        writeFileSync(join(claudeDir, "permissions.yaml"), stringify(testCase.rules));

        const inputJson = JSON.stringify(testCase.input);

        const testEnv: Record<string, string> = {};
        for (const [key, value] of Object.entries(process.env)) {
            if (key !== "NODE_ENV" && value !== undefined) {
                testEnv[key] = value;
            }
        }
        testEnv["HOME"] = homeDir;
        testEnv["CLAUDE_PROJECT_DIR"] = projectDir;

        const hookPath = join(__dirname, "..", "src", "hook.ts");
        const result = spawnSync("bun", [hookPath], {
            input: inputJson,
            env: testEnv,
            encoding: "utf-8",
        });

        if (result.status !== 0) {
            process.stdout.write(`FAIL: ${testCase.description}\n`);
            process.stdout.write(`  hook.ts exited with status ${result.status}\n`);
            if (result.stderr) {
                process.stdout.write(`  stderr: ${result.stderr}\n`);
            }
            return false;
        }

        const output = JSON.parse(result.stdout) as IHookOutput;
        const actualDecision = output.hookSpecificOutput.permissionDecision;
        const actualReason = output.hookSpecificOutput.permissionDecisionReason;

        if (actualDecision !== testCase.expected.decision) {
            process.stdout.write(`FAIL: ${testCase.description}\n`);
            process.stdout.write(`  decision: expected "${testCase.expected.decision}", got "${actualDecision}"\n`);
            return false;
        }

        if (testCase.expected.reason !== undefined && actualReason !== testCase.expected.reason) {
            process.stdout.write(`FAIL: ${testCase.description}\n`);
            process.stdout.write(`  reason: expected "${testCase.expected.reason}", got "${String(actualReason)}"\n`);
            return false;
        }

        if (testCase.expected.audit_log !== undefined) {
            const logBaseDir = join(projectDir, ".claude", "permissions-log");
            const logFile = findNewestLogFile(logBaseDir);
            if (!logFile) {
                process.stdout.write(`FAIL: ${testCase.description}\n`);
                process.stdout.write(`  audit_log: no log file found under ${logBaseDir}\n`);
                return false;
            }
            const logLines = readFileSync(logFile, "utf-8").split("\n").filter(Boolean);
            const logEntries: Record<string, string>[] = logLines.map(
                (line: string) => JSON.parse(line) as Record<string, string>
            );
            for (const expectedEntry of testCase.expected.audit_log) {
                const matchingEntry = logEntries.find((actualEntry: Record<string, string>) =>
                    Object.entries(expectedEntry).every(
                        ([entryKey, entryValue]) => actualEntry[entryKey] === entryValue
                    )
                );
                if (!matchingEntry) {
                    process.stdout.write(`FAIL: ${testCase.description}\n`);
                    process.stdout.write(`  audit_log: no entry matching ${JSON.stringify(expectedEntry)}\n`);
                    return false;
                }
            }
        }

        process.stdout.write(`PASS: ${testCase.description}\n`);
        return true;
    }
    finally {
        rmSync(tmpDir, { recursive: true, force: true });
    }
}

// main reads the test file path from argv[2] and exits 0 on pass or 1 on fail.
function main(): void {
    const testFilePath = process.argv[2];
    if (!testFilePath) {
        process.stderr.write("Usage: bun run src/run-e2e-test.ts <test-file.yaml>\n");
        process.exit(1);
    }

    const passed = runTest(testFilePath);
    process.exit(passed ? 0 : 1);
}

main();
