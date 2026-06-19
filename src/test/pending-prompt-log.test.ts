import { mkdtemp, readFile, rm, stat, utimes } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { buildAst } from "../build-ast";
import { NullAuditLogger } from "../audit-log";
import { decide } from "../interpret";
import { RuleLayer, RuleRegistry } from "../rule-registry";
import { builtinRules } from "../rules";
import {
    buildLeafOutcomeMap,
    cleanupStalePendingPrompts,
    computePendingPromptKey,
    formatContextBlock,
    formatPendingPromptMarkdown,
    removePendingPrompt,
    resolvePendingDir,
    simulateLeafEnvironments,
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

test("computePendingPromptKey is stable for the same call and differs when tool_input changes", () => {
    const callA = makeBashCall("curl https://example.com", "/project");
    const callB = makeBashCall("curl https://other.example.com", "/project");
    expect(computePendingPromptKey(callA)).toBe(computePendingPromptKey(callA));
    expect(computePendingPromptKey(callA)).not.toBe(computePendingPromptKey(callB));
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

test("formatContextBlock lists hook CWD and env vars after export", () => {
    const call = makeBashCall("export AWS_PROFILE=prod && curl https://example.com", "/home/user/project");
    const root = buildAst(call, new Map());
    const env0: IEnvironment = { cwd: call.cwd, cwdResolved: true, env: {} };
    const block = formatContextBlock(call, root, env0);
    expect(block).toContain("CWD: /home/user/project");
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

test("formatPendingPromptMarkdown includes pending-since, Context, and leaf cwd lines", () => {
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
        new Date("2026-06-19T18:09:12.004+10:00")
    );
    expect(markdown).toContain("Pending since 2026-06-19T18:09:12.004+10:00");
    expect(markdown).toContain("## Context");
    expect(markdown).toContain("AWS_PROFILE=prod");
    expect(markdown).toContain("cwd: /tmp");
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
    expect(markdown).toContain("NOMATCH");
    expect(markdown).toContain("ASK (no rule matched)");
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
    expect(markdown).toContain("## Command");
    expect(markdown).toContain("## Sub-commands");
    expect(markdown).toContain("## Verdict");
    expect(markdown).toContain("ASK (matched rule)");
    expect(markdown).toContain("network access requires approval");
});

test("writePendingPrompt creates pending/<key>.md", async () => {
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
        await writePendingPrompt(dir, call, root, leafEvaluations, "ask", "network access requires approval", new Date());
        const key = computePendingPromptKey(call);
        const filePath = join(resolvePendingDir(dir), `${key}.md`);
        const content = await readFile(filePath, "utf-8");
        expect(content).toContain("curl https://example.com");
    }
    finally {
        await cleanup();
    }
});

test("removePendingPrompt deletes the pending detail file", async () => {
    const { dir, cleanup } = await tempDir();
    try {
        const call = makeBashCall("curl https://example.com", dir);
        const root = buildAst(call, new Map());
        await writePendingPrompt(dir, call, root, [], "ask", undefined, new Date());
        const key = computePendingPromptKey(call);
        const filePath = join(resolvePendingDir(dir), `${key}.md`);
        await removePendingPrompt(dir, {
            tool_name: call.tool_name,
            tool_input: call.tool_input,
            tool_response: { output: "ok", isError: false },
            cwd: call.cwd,
        });
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

test("cleanupStalePendingPrompts removes files older than the threshold", async () => {
    const { dir, cleanup } = await tempDir();
    try {
        const call = makeBashCall("curl https://example.com", dir);
        const root = buildAst(call, new Map());
        await writePendingPrompt(dir, call, root, [], "ask", undefined, new Date());
        const key = computePendingPromptKey(call);
        const filePath = join(resolvePendingDir(dir), `${key}.md`);
        const oldTime = new Date("2020-01-01T00:00:00.000Z");
        await utimes(filePath, oldTime, oldTime);
        await cleanupStalePendingPrompts(dir, new Date(), 7);
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
