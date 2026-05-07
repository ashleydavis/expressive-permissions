import { mkdirSync, writeFileSync, rmSync, unwatchFile } from "fs";
import { join } from "path";
import { RuleLayer, FileLayer, RuleRegistry, IRuleLayer } from "../rule-registry";
import { NullAuditLogger } from "../audit-log";
import { AstNode, Environment, Rule, RuleOutcome, ToolCall, ABSTAIN } from "../types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// makeEnv builds a minimal Environment.
function makeEnv(cwd: string = "/project"): Environment {
    return { cwd, cwdResolved: true, env: {} };
}

// makeBashCall builds a minimal ToolCall.
function makeBashCall(command: string): ToolCall {
    return { tool_name: "Bash", tool_input: { command }, cwd: "/project" };
}

// makeReadCall builds a Read ToolCall.
function makeReadCall(filePath: string): ToolCall {
    return { tool_name: "Read", tool_input: { file_path: filePath }, cwd: "/project" };
}

// makeReadNode builds a read AstNode.
function makeReadNode(filePath: string): AstNode {
    return { type: "read", file_path: filePath };
}

// allowRule always returns allow.
const allowRule: Rule = function allowRule(_node: AstNode, _env: Environment): RuleOutcome {
    return { decision: { action: "allow" } };
};

// denyRule always returns deny.
const denyRule: Rule = function denyRule(_node: AstNode, _env: Environment): RuleOutcome {
    return { decision: { action: "deny", reason: "blocked" } };
};

// askRule always returns ask.
const askRule: Rule = function askRule(_node: AstNode, _env: Environment): RuleOutcome {
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
    const afterDeny: Rule = function afterDeny(_node: AstNode, _env: Environment): RuleOutcome {
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
    const envInstallerRule: Rule = function envInstallerRule(_node: AstNode, env: Environment): RuleOutcome {
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
    const layer = new FileLayer(() => [allowRule], undefined);
    const result = layer.runRules(makeReadNode("/foo"), makeEnv(), makeReadCall("/foo"), new NullAuditLogger());
    expect(result.annotation.decision.action).toBe("allow");
});

test("FileLayer: undefined filePath still loads rules", () => {
    const layer = new FileLayer(() => [denyRule], undefined);
    const result = layer.runRules(makeReadNode("/foo"), makeEnv(), makeReadCall("/foo"), new NullAuditLogger());
    expect(result.annotation.decision.action).toBe("deny");
});

test("FileLayer: reloads rules when file changes", async () => {
    const tmpDir = join("/tmp", `rule-registry-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    const filePath = join(tmpDir, "permissions.yaml");
    writeFileSync(filePath, "initial");

    let callCount = 0;
    const loadFn = (): Rule[] => {
        callCount++;
        return callCount === 1 ? [allowRule] : [denyRule];
    };

    const layer = new FileLayer(loadFn, filePath);
    expect(callCount).toBe(1);

    const beforeResult = layer.runRules(makeReadNode("/foo"), makeEnv(), makeReadCall("/foo"), new NullAuditLogger());
    expect(beforeResult.annotation.decision.action).toBe("allow");

    writeFileSync(filePath, "changed");
    await new Promise<void>((resolve) => setTimeout(resolve, 200));

    const afterResult = layer.runRules(makeReadNode("/foo"), makeEnv(), makeReadCall("/foo"), new NullAuditLogger());
    expect(afterResult.annotation.decision.action).toBe("deny");

    unwatchFile(filePath);
    rmSync(tmpDir, { recursive: true, force: true });
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
        runRules(_node: AstNode, _env: Environment, _call: ToolCall): import("../types").IRunRulesResult {
            secondLayerCalled = true;
            return {
                annotation: { decision: { action: "allow" } },
                envUpdate: (environment: Environment) => environment,
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
    const capturedEnvs: Environment[] = [];
    const envInstallerRule: Rule = function envInstallerRule(_node: AstNode, env: Environment): RuleOutcome {
        return {
            decision: { action: "abstain" },
            env: { ...env, env: { ...env.env, LAYER1: "set" } },
        };
    };
    const capturingRule: Rule = function capturingRule(_node: AstNode, env: Environment): RuleOutcome {
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

test("RuleRegistry: setLayersForTesting replaces layers", () => {
    const registry = new RuleRegistry([new RuleLayer([allowRule])]);
    registry.setLayersForTesting([new RuleLayer([denyRule])]);
    const result = registry.runRules(makeReadNode("/foo"), makeEnv(), makeReadCall("/foo"), new NullAuditLogger());
    expect(result.annotation.decision.action).toBe("deny");
});
