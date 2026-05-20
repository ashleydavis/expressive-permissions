import { RuleLayer, FileLayer, RuleRegistry, IRuleLayer } from "../rule-registry";
import { NullAuditLogger, IAuditLogger, IAuditLogEntry, IConfigLoadEntry } from "../audit-log";
import { AstNode, IEnvironment, IRule, IRuleOutcome, IRunRulesResult, IToolCall, ABSTAIN } from "../types";

// CapturingLogger records every audit entry so tests can assert on what FileLayer logs.
class CapturingLogger implements IAuditLogger {
    // The list of entries received in the order they were logged.
    public readonly entries: IAuditLogEntry[] = [];

    log(entry: IAuditLogEntry): void {
        this.entries.push(entry);
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// makeEnv builds a minimal Environment.
function makeEnv(cwd: string = "/project"): IEnvironment {
    return { cwd, cwdResolved: true, env: {} };
}

// makeBashCall builds a minimal ToolCall.
function makeBashCall(command: string): IToolCall {
    return { tool_name: "Bash", tool_input: { command }, cwd: "/project" };
}

// makeReadCall builds a Read ToolCall.
function makeReadCall(filePath: string): IToolCall {
    return { tool_name: "Read", tool_input: { file_path: filePath }, cwd: "/project" };
}

// makeReadNode builds a read AstNode.
function makeReadNode(filePath: string): AstNode {
    return { type: "read", file_path: filePath };
}

// allowRule always returns allow.
const allowRule: IRule = function allowRule(_node: AstNode, _env: IEnvironment): IRuleOutcome {
    return { decision: { action: "allow" } };
};

// denyRule always returns deny.
const denyRule: IRule = function denyRule(_node: AstNode, _env: IEnvironment): IRuleOutcome {
    return { decision: { action: "deny", reason: "blocked" } };
};

// askRule always returns ask.
const askRule: IRule = function askRule(_node: AstNode, _env: IEnvironment): IRuleOutcome {
    return { decision: { action: "ask" } };
};

// ---------------------------------------------------------------------------
// RuleLayer
// ---------------------------------------------------------------------------

test("RuleLayer: empty rules → abstain annotation", () => {
    const layer = new RuleLayer([]);
    const result = layer.runRules(makeReadNode("/foo"), makeEnv(), makeBashCall("ls"), new NullAuditLogger());
    expect(result.annotation.decision.action).toBe("abstain");
});

test("RuleLayer: single allow rule → allow annotation", () => {
    const layer = new RuleLayer([allowRule]);
    const result = layer.runRules(makeReadNode("/foo"), makeEnv(), makeReadCall("/foo"), new NullAuditLogger());
    expect(result.annotation.decision.action).toBe("allow");
});

test("RuleLayer: deny rule short-circuits remaining rules", () => {
    let secondRuleCalled = false;
    const afterDeny: IRule = function afterDeny(_node: AstNode, _env: IEnvironment): IRuleOutcome {
        secondRuleCalled = true;
        return { decision: { action: "allow" } };
    };
    const layer = new RuleLayer([denyRule, afterDeny]);
    const result = layer.runRules(makeReadNode("/foo"), makeEnv(), makeReadCall("/foo"), new NullAuditLogger());
    expect(result.annotation.decision.action).toBe("deny");
    expect(secondRuleCalled).toBe(false);
});

test("RuleLayer: allow then ask → ask (strictest-wins)", () => {
    const layer = new RuleLayer([allowRule, askRule]);
    const result = layer.runRules(makeReadNode("/foo"), makeEnv(), makeReadCall("/foo"), new NullAuditLogger());
    expect(result.annotation.decision.action).toBe("ask");
});

test("RuleLayer: persistent env update propagates via envUpdate", () => {
    const envInstallerRule: IRule = function envInstallerRule(_node: AstNode, env: IEnvironment): IRuleOutcome {
        return {
            decision: { action: "abstain" },
            env: { ...env, env: { ...env.env, INSTALLED: "yes" } },
        };
    };
    const layer = new RuleLayer([envInstallerRule]);
    const baseEnv = makeEnv();
    const result = layer.runRules(makeReadNode("/foo"), baseEnv, makeReadCall("/foo"), new NullAuditLogger());
    const updatedEnv = result.envUpdate(baseEnv);
    expect(updatedEnv.env.INSTALLED).toBe("yes");
});

test("RuleLayer: envUpdate returns base env when no persistent update", () => {
    const layer = new RuleLayer([allowRule]);
    const baseEnv = makeEnv();
    const result = layer.runRules(makeReadNode("/foo"), baseEnv, makeReadCall("/foo"), new NullAuditLogger());
    const updatedEnv = result.envUpdate(baseEnv);
    expect(updatedEnv).toBe(baseEnv);
});

// ---------------------------------------------------------------------------
// FileLayer
// ---------------------------------------------------------------------------

test("FileLayer: loads rules immediately from loadFn", () => {
    const layer = new FileLayer(() => [allowRule], "test.yaml", new NullAuditLogger());
    const result = layer.runRules(makeReadNode("/foo"), makeEnv(), makeReadCall("/foo"), new NullAuditLogger());
    expect(result.annotation.decision.action).toBe("allow");
});

test("FileLayer: logs a config_load entry on construction", () => {
    const recordingLogger = new CapturingLogger();
    new FileLayer(() => [allowRule, denyRule], "~/.claude/permissions.yaml", recordingLogger);
    const configEntries = recordingLogger.entries.filter((entry: IAuditLogEntry) => entry.type === "config_load") as IConfigLoadEntry[];
    expect(configEntries.length).toBe(1);
    expect(configEntries[0].filePath).toBe("~/.claude/permissions.yaml");
    expect(configEntries[0].ruleCount).toBe(2);
});

// ---------------------------------------------------------------------------
// RuleRegistry
// ---------------------------------------------------------------------------

test("RuleRegistry: empty layers → abstain annotation", () => {
    const registry = new RuleRegistry([]);
    const result = registry.runRules(makeReadNode("/foo"), makeEnv(), makeReadCall("/foo"), new NullAuditLogger());
    expect(result.annotation.decision.action).toBe("abstain");
});

test("RuleRegistry: single layer with allow → allow", () => {
    const registry = new RuleRegistry([new RuleLayer([allowRule])]);
    const result = registry.runRules(makeReadNode("/foo"), makeEnv(), makeReadCall("/foo"), new NullAuditLogger());
    expect(result.annotation.decision.action).toBe("allow");
});

test("RuleRegistry: deny in first layer short-circuits second layer", () => {
    let secondLayerCalled = false;
    const spyLayer: IRuleLayer = {
        runRules(_node: AstNode, _env: IEnvironment, _call: IToolCall): IRunRulesResult {
            secondLayerCalled = true;
            return {
                annotation: { decision: { action: "allow" } },
                envUpdate: (environment: IEnvironment) => environment,
                nodeRunningEnv: makeEnv(),
            };
        },
    };
    const registry = new RuleRegistry([new RuleLayer([denyRule]), spyLayer]);
    const result = registry.runRules(makeReadNode("/foo"), makeEnv(), makeReadCall("/foo"), new NullAuditLogger());
    expect(result.annotation.decision.action).toBe("deny");
    expect(secondLayerCalled).toBe(false);
});

test("RuleRegistry: env threads from first layer to second layer", () => {
    const capturedEnvs: IEnvironment[] = [];
    const envInstallerRule: IRule = function envInstallerRule(_node: AstNode, env: IEnvironment): IRuleOutcome {
        return {
            decision: { action: "abstain" },
            env: { ...env, env: { ...env.env, LAYER1: "set" } },
        };
    };
    const capturingRule: IRule = function capturingRule(_node: AstNode, env: IEnvironment): IRuleOutcome {
        capturedEnvs.push(env);
        return ABSTAIN;
    };
    const registry = new RuleRegistry([
        new RuleLayer([envInstallerRule]),
        new RuleLayer([capturingRule]),
    ]);
    registry.runRules(makeReadNode("/foo"), makeEnv(), makeReadCall("/foo"), new NullAuditLogger());
    expect(capturedEnvs.length).toBeGreaterThan(0);
    expect(capturedEnvs[0].env.LAYER1).toBe("set");
});

test("RuleRegistry: strictest-wins across layers", () => {
    const registry = new RuleRegistry([
        new RuleLayer([allowRule]),
        new RuleLayer([askRule]),
    ]);
    const result = registry.runRules(makeReadNode("/foo"), makeEnv(), makeReadCall("/foo"), new NullAuditLogger());
    expect(result.annotation.decision.action).toBe("ask");
});

