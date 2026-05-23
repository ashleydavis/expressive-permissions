import { readFileSync, mkdirSync, writeFileSync, rmSync, readdirSync, statSync, cpSync, lstatSync } from "fs";
import { join, dirname } from "path";
import { spawnSync } from "child_process";
import { parse, stringify } from "yaml";

// ITestCaseInput describes the tool call input fields in a test case YAML file.
interface ITestCaseInput {
    // The Claude Code tool name (e.g. "Bash", "Read")
    tool_name: string;
    // The tool-specific input arguments
    tool_input: Record<string, unknown>;
    // The working directory for the tool call. Optional; defaults to the auto-generated
    // tmp/project directory. The token ${PROJECT_DIR} is substituted with the absolute
    // path of that directory.
    cwd?: string;
}

// IPostToolUseInput describes the PostToolUse hook input fields in a test case YAML file.
interface IPostToolUseInput {
    // The Claude Code tool name (e.g. "Bash", "Read")
    tool_name: string;
    // The tool-specific input arguments
    tool_input: Record<string, unknown>;
    // The raw tool response payload
    tool_response: Record<string, unknown>;
    // The working directory for the tool call
    cwd: string;
}

// IPostToolUseExpected describes the expected outcomes for the PostToolUse hook.
interface IPostToolUseExpected {
    // When present, the newest log file must contain matching entries for each item.
    audit_log?: IAuditLogExpectedEntry[];
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
    // Optional: written verbatim as home/.claude/permissions.yaml for the test run
    home_rules?: Record<string, unknown>;
    // Optional: per-file drop-ins written under home/.claude/permissions.d/
    home_dir_files?: Record<string, Record<string, unknown>>;
    // Optional: per-file drop-ins written under project/.claude/permissions.d/
    project_dir_files?: Record<string, Record<string, unknown>>;
    // The expected outputs from hook.ts
    expected: ITestCaseExpected;
    // Optional PostToolUse hook input to feed to post-hook.ts after the PreToolUse assertions
    post_input?: IPostToolUseInput;
    // Optional expected outcomes for the PostToolUse hook invocation
    post_expected?: IPostToolUseExpected;
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
            else if (entry.endsWith(".json") && stat.mtimeMs > newestMtime) {
                newestMtime = stat.mtimeMs;
                newestPath = fullPath;
            }
        }
    }

    walk(baseDir);
    return newestPath;
}

// The root of the repository, used to locate the e2e/fixtures directory.
const REPO_ROOT = join(__dirname, "..");

// runTest parses one test case YAML file, spawns hook.ts with the test input, and
// compares the output to the expected values. Returns true on pass, false on fail.
function runTest(testFilePath: string): boolean {
    const content = readFileSync(testFilePath, "utf-8");
    const testCase = parse(content) as ITestCase;
    const testDir = dirname(testFilePath);
    const tmpDir = join(testDir, "tmp");

    rmSync(tmpDir, { recursive: true, force: true });

    const homeDir = join(tmpDir, "home");
    const projectDir = join(tmpDir, "project");
    const claudeDir = join(projectDir, ".claude");

    mkdirSync(homeDir, { recursive: true });
    mkdirSync(claudeDir, { recursive: true });
    cpSync(join(REPO_ROOT, "e2e", "fixtures"), join(projectDir, "fixtures"), { recursive: true });

    writeFileSync(join(claudeDir, "permissions.yaml"), stringify(testCase.rules));

    if (testCase.home_rules !== undefined) {
        mkdirSync(join(homeDir, ".claude"), { recursive: true });
        writeFileSync(join(homeDir, ".claude", "permissions.yaml"), stringify(testCase.home_rules));
    }

    if (testCase.home_dir_files !== undefined) {
        const homeDropInDir = join(homeDir, ".claude", "permissions.d");
        mkdirSync(homeDropInDir, { recursive: true });
        for (const [dropInName, dropInBody] of Object.entries(testCase.home_dir_files)) {
            const destPath = join(homeDropInDir, dropInName);
            mkdirSync(dirname(destPath), { recursive: true });
            writeFileSync(destPath, stringify(dropInBody));
        }
    }

    if (testCase.project_dir_files !== undefined) {
        const projectDropInDir = join(claudeDir, "permissions.d");
        mkdirSync(projectDropInDir, { recursive: true });
        for (const [dropInName, dropInBody] of Object.entries(testCase.project_dir_files)) {
            const destPath = join(projectDropInDir, dropInName);
            mkdirSync(dirname(destPath), { recursive: true });
            writeFileSync(destPath, stringify(dropInBody));
        }
    }

        const substituted = JSON.parse(
            JSON.stringify(testCase.input).split("${PROJECT_DIR}").join(projectDir)
        ) as ITestCaseInput;
        const hookInput: Record<string, unknown> = {
            tool_name: substituted.tool_name,
            tool_input: substituted.tool_input,
            cwd: substituted.cwd ?? projectDir,
        };
        const inputJson = JSON.stringify(hookInput);

        const testEnv: Record<string, string> = {};
        for (const [key, value] of Object.entries(process.env)) {
            if (key !== "NODE_ENV" && value !== undefined) {
                testEnv[key] = value;
            }
        }
        testEnv["HOME"] = homeDir;
        testEnv["CLAUDE_PROJECT_DIR"] = projectDir;

        const hookPath = join(__dirname, "..", "src", "pre-hook.ts");
        const result = spawnSync("bun", [hookPath], {
            input: inputJson,
            env: testEnv,
            encoding: "utf-8",
        });

        if (result.status !== 0) {
            process.stdout.write(`FAIL: ${testCase.description}\n`);
            process.stdout.write(`  pre-hook.ts exited with status ${result.status}\n`);
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

        if (testCase.post_input !== undefined) {
            const postInputJson = JSON.stringify(testCase.post_input);
            const postHookPath = join(__dirname, "..", "src", "post-hook.ts");
            const postResult = spawnSync("bun", [postHookPath], {
                input: postInputJson,
                env: testEnv,
                encoding: "utf-8",
            });

            if (postResult.status !== 0) {
                process.stdout.write(`FAIL: ${testCase.description}\n`);
                process.stdout.write(`  post-hook.ts exited with status ${postResult.status}\n`);
                if (postResult.stderr) {
                    process.stdout.write(`  stderr: ${postResult.stderr}\n`);
                }
                return false;
            }

            if (testCase.post_expected?.audit_log !== undefined) {
                const logBaseDir = join(projectDir, ".claude", "permissions-log");
                const logFile = findNewestLogFile(logBaseDir);
                if (!logFile) {
                    process.stdout.write(`FAIL: ${testCase.description}\n`);
                    process.stdout.write(`  post audit_log: no log file found under ${logBaseDir}\n`);
                    return false;
                }
                const logLines = readFileSync(logFile, "utf-8").split("\n").filter(Boolean);
                const logEntries: Record<string, string>[] = logLines.map(
                    (line: string) => JSON.parse(line) as Record<string, string>
                );
                for (const expectedEntry of testCase.post_expected.audit_log) {
                    const matchingEntry = logEntries.find((actualEntry: Record<string, string>) =>
                        Object.entries(expectedEntry).every(
                            ([entryKey, entryValue]) => String(actualEntry[entryKey]) === entryValue
                        )
                    );
                    if (!matchingEntry) {
                        process.stdout.write(`FAIL: ${testCase.description}\n`);
                        process.stdout.write(`  post audit_log: no entry matching ${JSON.stringify(expectedEntry)}\n`);
                        return false;
                    }
                }
            }
        }

        process.stdout.write(`PASS: ${testCase.description}\n`);
        return true;
}

// main reads the test file path from argv[2] and exits 0 on pass or 1 on fail.
function main(): void {
    let testFilePath = process.argv[2];
    if (!testFilePath) {
        process.stderr.write("Usage: bun run src/run-e2e-test.ts <test-dir-or-file>\n");
        process.exit(1);
    }

    if (lstatSync(testFilePath).isDirectory()) {
        testFilePath = join(testFilePath, "test.yaml");
    }

    const passed = runTest(testFilePath);
    process.exit(passed ? 0 : 1);
}

main();
