import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { parseToolCallInput, analyzePermission } from "../analyze";
import { RuleLayer, RuleRegistry } from "../rule-registry";
import { Rule, ABSTAIN, RuleOutcome, AstNode, Environment, ToolCall } from "../types";
import { NullAuditLogger } from "../audit-log";

// makeTmpProjectDir creates a temp directory with a .claude/ subdirectory and optional
// permissions.yaml content, returning the project dir path.
function makeTmpProjectDir(yamlContent?: string): string {
    const projectDir = mkdtempSync(join(tmpdir(), "analyze-test-"));
    mkdirSync(join(projectDir, ".claude"), { recursive: true });
    if (yamlContent !== undefined) {
        writeFileSync(join(projectDir, ".claude", "permissions.yaml"), yamlContent, "utf-8");
    }
    return projectDir;
}

// ---------------------------------------------------------------------------
// parseToolCallInput
// ---------------------------------------------------------------------------

test("parseToolCallInput bare command produces Bash tool call", () => {
    const result = parseToolCallInput("git status", "/project");
    expect(result.tool_name).toBe("Bash");
    expect(result.tool_input["command"]).toBe("git status");
    expect(result.cwd).toBe("/project");
});

test("parseToolCallInput read prefix produces Read tool call", () => {
    const result = parseToolCallInput("read /etc/hosts", "/project");
    expect(result.tool_name).toBe("Read");
    expect(result.tool_input["file_path"]).toBe("/etc/hosts");
    expect(result.cwd).toBe("/project");
});

test("parseToolCallInput write prefix produces Write tool call", () => {
    const result = parseToolCallInput("write /tmp/out.txt", "/project");
    expect(result.tool_name).toBe("Write");
    expect(result.tool_input["file_path"]).toBe("/tmp/out.txt");
    expect(result.tool_input["content"]).toBe("");
    expect(result.cwd).toBe("/project");
});

test("parseToolCallInput edit prefix produces Edit tool call", () => {
    const result = parseToolCallInput("edit /src/main.ts", "/project");
    expect(result.tool_name).toBe("Edit");
    expect(result.tool_input["file_path"]).toBe("/src/main.ts");
    expect(result.tool_input["old_string"]).toBe("");
    expect(result.tool_input["new_string"]).toBe("");
    expect(result.cwd).toBe("/project");
});

test("parseToolCallInput webfetch prefix produces WebFetch tool call", () => {
    const result = parseToolCallInput("webfetch https://example.com", "/project");
    expect(result.tool_name).toBe("WebFetch");
    expect(result.tool_input["url"]).toBe("https://example.com");
    expect(result.cwd).toBe("/project");
});

test("parseToolCallInput tool prefix produces generic tool call", () => {
    const result = parseToolCallInput("tool MyCustomTool", "/project");
    expect(result.tool_name).toBe("MyCustomTool");
    expect(result.tool_input).toEqual({});
    expect(result.cwd).toBe("/project");
});

test("parseToolCallInput prefixes are case-insensitive", () => {
    const readResult = parseToolCallInput("READ /etc/hosts", "/project");
    expect(readResult.tool_name).toBe("Read");

    const writeResult = parseToolCallInput("WRITE /tmp/file.txt", "/project");
    expect(writeResult.tool_name).toBe("Write");

    const webfetchResult = parseToolCallInput("WEBFETCH https://example.com", "/project");
    expect(webfetchResult.tool_name).toBe("WebFetch");
});

// ---------------------------------------------------------------------------
// analyzePermission
// ---------------------------------------------------------------------------

test("analyzePermission with allow rule for git returns decision=allow with rule_match trace", () => {
    const projectDir = makeTmpProjectDir(`
bash:
  git:
    - decide: allow
`);
    try {
        const result = analyzePermission("git status", "/project", projectDir);
        expect(result.decision).toBe("allow");
        const ruleMatchEntries = result.trace.filter(
            (entry) => entry.type === "rule_match"
        );
        expect(ruleMatchEntries.length).toBeGreaterThan(0);
    }
    finally {
        rmSync(projectDir, { recursive: true, force: true });
    }
});

test("analyzePermission with no matching rules returns decision=ask with no_rule_match trace", () => {
    const projectDir = makeTmpProjectDir();
    const emptyHomeDir = mkdtempSync(join(tmpdir(), "analyze-test-home-"));
    const savedHome = process.env["HOME"];
    process.env["HOME"] = emptyHomeDir;
    try {
        const result = analyzePermission("ls /tmp", "/project", projectDir);
        expect(result.decision).toBe("ask");
        const noMatchEntries = result.trace.filter(
            (entry) => entry.type === "no_rule_match"
        );
        expect(noMatchEntries.length).toBeGreaterThan(0);
    }
    finally {
        if (savedHome !== undefined) {
            process.env["HOME"] = savedHome;
        }
        else {
            delete process.env["HOME"];
        }
        rmSync(emptyHomeDir, { recursive: true, force: true });
        rmSync(projectDir, { recursive: true, force: true });
    }
});

test("analyzePermission with deny rule returns decision=deny and forwards reason", () => {
    const projectDir = makeTmpProjectDir(`
bash:
  rm:
    - decide: deny
      reason: rm is dangerous
`);
    try {
        const result = analyzePermission("rm -rf /", "/project", projectDir);
        expect(result.decision).toBe("deny");
        expect(result.reason).toBe("rm is dangerous");
    }
    finally {
        rmSync(projectDir, { recursive: true, force: true });
    }
});
