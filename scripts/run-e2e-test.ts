import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
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

// ITestCaseExpected describes the expected outcome fields in a test case YAML file.
interface ITestCaseExpected {
    // The expected permissionDecision value (allow, deny, or ask)
    decision: string;
    // When present, the permissionDecisionReason must match exactly
    reason?: string;
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
