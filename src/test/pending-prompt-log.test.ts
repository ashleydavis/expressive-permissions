import { mkdtemp, mkdir, readdir, readFile, rm, stat, utimes, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { buildAst } from "../build-ast";
import { NullAuditLogger } from "../audit-log";
import { decide } from "../interpret";
import { RuleLayer, RuleRegistry } from "../rule-registry";
import { builtinRules } from "../rules";
import {
    buildPendingPromptFileName,
    buildLeafOutcomeMap,
    cleanupStalePendingPrompts,
    formatContextBlock,
    formatPendingPromptFileTimestamp,
    formatPendingPromptMarkdown,
    resolvePendingDir,
    resolvePendingPromptFilePath,
    sanitizePendingPromptDescription,
    simulateLeafEnvironments,
    STALE_PENDING_PROMPT_MAX_AGE_DAYS,
    writePendingPrompt,
} from "../pending-prompt-log";
import { IToolCall, IEnvironment, ABSTAIN } from "../types";

// tempDir creates a temporary directory and returns its path and a cleanup function.
async function tempDir(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
    const dir = await mkdtemp(join(tmpdir(), "pending-prompt-log-test-"));
    return {
        dir,
        cleanup: () => rm(dir, { recursive: true, force: true }),
    };
}

// makeBashCall builds a minimal Bash IToolCall.
function makeBashCall(command: string, cwd: string): IToolCall {
    return { tool_name: "Bash", tool_input: { command }, cwd };
}

// makeReadCall builds a minimal Read IToolCall.
function makeReadCall(filePath: string, cwd: string): IToolCall {
    return { tool_name: "Read", tool_input: { file_path: filePath }, cwd };
}

test("STALE_PENDING_PROMPT_MAX_AGE_DAYS is one day", () => {
    expect(STALE_PENDING_PROMPT_MAX_AGE_DAYS).toBe(1);
});

test("formatPendingPromptFileTimestamp renders yyyy-mm-dd-hh-ss", () => {
    const timestamp = formatPendingPromptFileTimestamp(new Date(2026, 0, 5, 9, 30, 7));
    expect(timestamp).toBe("2026-01-05-09-07");
});

test("sanitizePendingPromptDescription lowercases and replaces non-alphanumeric characters", () => {
    expect(sanitizePendingPromptDescription("curl https://example.com")).toBe("curl-https-example-com");
    expect(sanitizePendingPromptDescription("./cloudfront/variant-1a/locals.tf")).toBe("cloudfront-variant-1a-locals-tf");
});

test("sanitizePendingPromptDescription collapses repeated hyphens and trims edges", () => {
    expect(sanitizePendingPromptDescription("---hello---world---")).toBe("hello-world");
});

test("sanitizePendingPromptDescription truncates long text", () => {
    const longText = "a".repeat(100);
    const sanitized = sanitizePendingPromptDescription(longText);
    expect(sanitized.length).toBeLessThanOrEqual(60);
    expect(sanitized).toBe("a".repeat(60));
});

test("resolvePendingPromptFilePath returns the base path when no file exists", async () => {
    const { dir, cleanup } = await tempDir();
    try {
        const pendingDir = resolvePendingDir(dir);
        await mkdir(pendingDir, { recursive: true });
        const filePath = await resolvePendingPromptFilePath(pendingDir, "2026-06-25-10-08-curl.md");
        expect(filePath).toBe(join(pendingDir, "2026-06-25-10-08-curl.md"));
    }
    finally {
        await cleanup();
    }
});

test("resolvePendingPromptFilePath increments the suffix until a free path is found", async () => {
    const { dir, cleanup } = await tempDir();
    try {
        const pendingDir = resolvePendingDir(dir);
        await mkdir(pendingDir, { recursive: true });
        const baseFileName = "2026-06-25-10-08-curl.md";
        await writeFile(join(pendingDir, baseFileName), "first", "utf-8");
        await writeFile(join(pendingDir, "2026-06-25-10-08-curl-1.md"), "second", "utf-8");
        const filePath = await resolvePendingPromptFilePath(pendingDir, baseFileName);
        expect(filePath).toBe(join(pendingDir, "2026-06-25-10-08-curl-2.md"));
    }
    finally {
        await cleanup();
    }
});

test("buildPendingPromptFileName includes timestamp and sanitized command summary", () => {
    const call = makeBashCall("curl https://example.com", "/project");
    const fileName = buildPendingPromptFileName(call, new Date(2026, 5, 25, 10, 19, 8));
    expect(fileName).toBe("2026-06-25-10-08-curl-https-example-com.md");
});

test("buildPendingPromptFileName differs when tool_input changes", () => {
    const callA = makeBashCall("curl https://example.com", "/project");
    const callB = makeBashCall("curl https://other.example.com", "/project");
    const pendingSince = new Date(2026, 5, 25, 10, 19, 8);
    expect(buildPendingPromptFileName(callA, pendingSince)).not.toBe(buildPendingPromptFileName(callB, pendingSince));
});

test("buildPendingPromptFileName uses file_path for Read tool calls", () => {
    const call = makeReadCall("./docs/plans/done/colocation-prototype-plan.md", "/project");
    const fileName = buildPendingPromptFileName(call, new Date(2026, 5, 25, 10, 19, 8));
    expect(fileName).toBe("2026-06-25-10-08-docs-plans-done-colocation-prototype-plan-md.md");
});

test("buildPendingPromptFileName falls back to tool name when command summary is empty", () => {
    const call: IToolCall = { tool_name: "Shell", tool_input: { command: "!!!" }, cwd: "/project" };
    const fileName = buildPendingPromptFileName(call, new Date(2026, 5, 25, 10, 19, 8));
    expect(fileName).toBe("2026-06-25-10-08-shell.md");
});

test("buildPendingPromptFileName falls back to tool when input has no command or file_path", () => {
    const call: IToolCall = { tool_name: "TaskList", tool_input: {}, cwd: "/project" };
    const fileName = buildPendingPromptFileName(call, new Date(2026, 5, 25, 10, 19, 8));
    expect(fileName).toBe("2026-06-25-10-08-tasklist.md");
});

test("simulateLeafEnvironments threads cwd through cd in a && chain", () => {
    const call = makeBashCall("cd /tmp && curl https://example.com", "/home/user/project");
    const root = buildAst(call, new Map());
    const env0: IEnvironment = { cwd: call.cwd, cwdResolved: true, env: {} };
    const leafContextMap = simulateLeafEnvironments(root, env0);
    const curlContext = leafContextMap.get("curl https://example.com");
    expect(curlContext).toBeDefined();
    expect(curlContext?.cwd).toBe("/tmp");
});

test("simulateLeafEnvironments does not thread cwd through a pipe", () => {
    const call = makeBashCall("cd /tmp | curl https://example.com", "/home/user/project");
    const root = buildAst(call, new Map());
    const env0: IEnvironment = { cwd: call.cwd, cwdResolved: true, env: {} };
    const leafContextMap = simulateLeafEnvironments(root, env0);
    const curlContext = leafContextMap.get("curl https://example.com");
    expect(curlContext).toBeDefined();
    expect(curlContext?.cwd).toBe("/home/user/project");
});

test("formatContextBlock returns hook cwd only when there are no hook-time env vars", () => {
    const call = makeBashCall("export AWS_PROFILE=prod && curl https://example.com", "/home/user/project");
    const env0: IEnvironment = { cwd: call.cwd, cwdResolved: true, env: {} };
    const block = formatContextBlock(call, env0);
    expect(block).toBe("/home/user/project");
});

test("formatContextBlock includes hook-time env vars without command assignments", () => {
    const call = makeBashCall("curl https://example.com", "/home/user/project");
    const env0: IEnvironment = {
        cwd: call.cwd,
        cwdResolved: true,
        env: { AWS_PROFILE: "prod" },
    };
    const block = formatContextBlock(call, env0);
    expect(block).toContain("/home/user/project");
    expect(block).toContain("AWS_PROFILE=prod");
});

test("decide returns leafEvaluations for pending prompt formatting", () => {
    const call = makeBashCall("curl https://example.com", "/home/user/project");
    const logger = new NullAuditLogger();
    const registry = new RuleRegistry([
        new RuleLayer(builtinRules),
        new RuleLayer([
            (node, _env, _call) => {
                if (node.type === "command" && node.binary === "curl") {
                    return { decision: { action: "ask", reason: "network access requires approval" } };
                }
                return ABSTAIN;
            },
        ]),
    ]);
    const decideResult = decide(call, logger, registry, new Map());
    expect(decideResult.leafEvaluations.length).toBeGreaterThan(0);
    const curlEvaluation = decideResult.leafEvaluations.find(
        evaluation => evaluation.cmd === "curl https://example.com"
    );
    expect(curlEvaluation).toBeDefined();
    expect(curlEvaluation?.decision).toBe("ASK");
    expect(curlEvaluation?.reason).toBe("network access requires approval");
});

test("formatPendingPromptMarkdown includes verdict-first layout with labeled tree outcomes", () => {
    const call = makeBashCall(
        "export AWS_PROFILE=prod && cd /tmp && curl https://example.com",
        "/home/user/project"
    );
    const root = buildAst(call, new Map());
    const logger = new NullAuditLogger();
    const registry = new RuleRegistry([
        new RuleLayer(builtinRules),
        new RuleLayer([
            (node, _env, _call) => {
                if (node.type === "command" && node.binary === "curl") {
                    return { decision: { action: "ask", reason: "network access requires approval" } };
                }
                return ABSTAIN;
            },
        ]),
    ]);
    const decideResult = decide(call, logger, registry, new Map());
    const markdown = formatPendingPromptMarkdown(
        call,
        decideResult.root,
        decideResult.leafEvaluations,
        decideResult.decision.action,
        "reason" in decideResult.decision ? decideResult.decision.reason : undefined,
        new Date(2026, 5, 19, 18, 9, 12, 4)
    );
    expect(markdown).toContain("Pending since 2026-06-19T18:09:12.004");
    expect(markdown.indexOf("## Verdict")).toBeLessThan(markdown.indexOf("## Command"));
    expect(markdown).toContain("## Context");
    expect(markdown).toContain("/home/user/project");
    expect(markdown).toContain("env: AWS_PROFILE=prod");
    expect(markdown).toContain("cwd: /tmp");
    expect(markdown).toContain("decision: ASK");
});

test("formatPendingPromptMarkdown shows no rule matched for default ask", () => {
    const call = makeBashCall("unknown-cmd-xyz", "/home/user/project");
    const root = buildAst(call, new Map());
    const decideResult = decide(call, new NullAuditLogger(), new RuleRegistry([new RuleLayer(builtinRules)]), new Map());
    const markdown = formatPendingPromptMarkdown(
        call,
        decideResult.root,
        decideResult.leafEvaluations,
        decideResult.decision.action,
        undefined,
        new Date("2026-06-19T18:09:12.004+10:00")
    );
    expect(markdown).toContain("decision: NOMATCH");
    expect(markdown).toContain("source: no rule matched");
    expect(markdown).toContain("cmd: unknown-cmd-xyz");
});

test("formatPendingPromptMarkdown includes sections for an ask decision", () => {
    const call = makeBashCall("curl https://example.com", "/home/user/project");
    const root = buildAst(call, new Map());
    const logger = new NullAuditLogger();
    const registry = new RuleRegistry([
        new RuleLayer(builtinRules),
        new RuleLayer([
            (node, _env, _call) => {
                if (node.type === "command" && node.binary === "curl") {
                    return { decision: { action: "ask", reason: "network access requires approval" } };
                }
                return ABSTAIN;
            },
        ]),
    ]);
    const decideResult = decide(call, logger, registry, new Map());
    const markdown = formatPendingPromptMarkdown(
        call,
        decideResult.root,
        decideResult.leafEvaluations,
        decideResult.decision.action,
        "reason" in decideResult.decision ? decideResult.decision.reason : undefined,
        new Date("2026-06-19T18:09:12.004+10:00")
    );
    expect(markdown).toContain("# Bash — ASK");
    expect(markdown).toContain("## Verdict");
    expect(markdown).toContain("## Command");
    expect(markdown).toContain("## Parsed command tree");
    expect(markdown).toContain("source: matched rule");
    expect(markdown).toContain("cmd: curl https://example.com");
    expect(markdown).toContain("network access requires approval");
});

test("writePendingPrompt creates a dated pending detail file", async () => {
    const { dir, cleanup } = await tempDir();
    try {
        const call = makeBashCall("curl https://example.com", dir);
        const root = buildAst(call, new Map());
        const leafEvaluations = [
            {
                cmd: "curl https://example.com",
                decision: "ASK",
                ruleFile: ".claude/permissions.yaml",
                ruleLine: 12,
                reason: "network access requires approval",
                source: "matched-rule" as const,
            },
        ];
        const pendingSince = new Date(2026, 5, 25, 10, 19, 8);
        await writePendingPrompt(dir, call, root, leafEvaluations, "ask", "network access requires approval", pendingSince);
        const pendingFiles = await readdir(resolvePendingDir(dir));
        expect(pendingFiles).toContain("2026-06-25-10-08-curl-https-example-com.md");
        const content = await readFile(join(resolvePendingDir(dir), "2026-06-25-10-08-curl-https-example-com.md"), "utf-8");
        expect(content).toContain("curl https://example.com");
    }
    finally {
        await cleanup();
    }
});

test("writePendingPrompt avoids filename collisions within the same second", async () => {
    const { dir, cleanup } = await tempDir();
    try {
        const call = makeBashCall("curl https://example.com", dir);
        const root = buildAst(call, new Map());
        const pendingSince = new Date(2026, 5, 25, 10, 19, 8);
        await writePendingPrompt(dir, call, root, [], "ask", undefined, pendingSince);
        await writePendingPrompt(dir, call, root, [], "ask", undefined, pendingSince);
        const pendingFiles = await readdir(resolvePendingDir(dir));
        expect(pendingFiles).toContain("2026-06-25-10-08-curl-https-example-com.md");
        expect(pendingFiles).toContain("2026-06-25-10-08-curl-https-example-com-1.md");
    }
    finally {
        await cleanup();
    }
});

test("cleanupStalePendingPrompts removes files older than the threshold", async () => {
    const { dir, cleanup } = await tempDir();
    try {
        const call = makeBashCall("curl https://example.com", dir);
        const root = buildAst(call, new Map());
        await writePendingPrompt(dir, call, root, [], "ask", undefined, new Date());
        const pendingFiles = await readdir(resolvePendingDir(dir));
        expect(pendingFiles.length).toBe(1);
        const filePath = join(resolvePendingDir(dir), pendingFiles[0]);
        const oldTime = new Date("2020-01-01T00:00:00.000Z");
        await utimes(filePath, oldTime, oldTime);
        await cleanupStalePendingPrompts(dir, new Date(), STALE_PENDING_PROMPT_MAX_AGE_DAYS);
        let fileExists = true;
        try {
            await stat(filePath);
        }
        catch {
            fileExists = false;
        }
        expect(fileExists).toBe(false);
    }
    finally {
        await cleanup();
    }
});

test("cleanupStalePendingPrompts keeps files newer than the threshold", async () => {
    const { dir, cleanup } = await tempDir();
    try {
        const call = makeBashCall("curl https://example.com", dir);
        const root = buildAst(call, new Map());
        await writePendingPrompt(dir, call, root, [], "ask", undefined, new Date());
        const pendingFiles = await readdir(resolvePendingDir(dir));
        expect(pendingFiles.length).toBe(1);
        const filePath = join(resolvePendingDir(dir), pendingFiles[0]);
        await cleanupStalePendingPrompts(dir, new Date(), STALE_PENDING_PROMPT_MAX_AGE_DAYS);
        const remainingFiles = await readdir(resolvePendingDir(dir));
        expect(remainingFiles).toEqual(pendingFiles);
    }
    finally {
        await cleanup();
    }
});

test("buildLeafOutcomeMap indexes leaf evaluation records", () => {
    const outcomeMap = buildLeafOutcomeMap([
        {
            cmd: "curl https://example.com",
            decision: "ASK",
            ruleFile: ".claude/permissions.yaml",
            ruleLine: 12,
            reason: "network access requires approval",
            source: "matched-rule",
        },
        {
            cmd: "pwd",
            decision: "NOMATCH",
            source: "no-rule-match",
        },
    ]);
    expect(outcomeMap.get("curl https://example.com")?.decision).toBe("ASK");
    expect(outcomeMap.get("pwd")?.decision).toBe("NOMATCH");
});
