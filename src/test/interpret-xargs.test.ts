import { decide as decideWithRegistry } from "../interpret";
import { NullAuditLogger } from "../audit-log";
import { RuleLayer, RuleRegistry } from "../rule-registry";
import { builtinRules } from "../rules/index";
import { AstNode, Decision, IRule, IRuleOutcome, IToolCall, ABSTAIN } from "../types";

// makeBashCall builds a minimal IToolCall for a Bash command string.
function makeBashCall(command: string): IToolCall {
    return { tool_name: "Bash", tool_input: { command }, cwd: "/start" };
}

// binaryMatchRule returns a rule that returns the given outcome when a Command node's
// binary matches the given binary name, and abstains otherwise.
function binaryMatchRule(binary: string, outcome: IRuleOutcome): IRule {
    return function matchRule(node: AstNode): IRuleOutcome {
        if (node.type === "command" && node.binary === binary) {
            return outcome;
        }
        return ABSTAIN;
    };
}

// decide builds a RuleRegistry from builtinRules plus extra rules and calls decideWithRegistry.
function decide(call: IToolCall, extraRules: IRule[]): Decision {
    const registry = new RuleRegistry([
        new RuleLayer(builtinRules),
        new RuleLayer(extraRules),
    ]);
    return decideWithRegistry(call, new NullAuditLogger(), registry, new Map());
}

// ---------------------------------------------------------------------------
// Basic xargs decisions
// ---------------------------------------------------------------------------

test("xargs grep: rule allows grep Command -> decision is allow", () => {
    const rules: IRule[] = [binaryMatchRule("grep", { decision: { action: "allow" } })];
    const result = decide(makeBashCall("xargs grep"), rules);
    expect(result.action).toBe("allow");
});

test("xargs rm -f: rule denies rm Command -> decision is deny", () => {
    const rules: IRule[] = [binaryMatchRule("rm", { decision: { action: "deny" } })];
    const result = decide(makeBashCall("xargs rm -f"), rules);
    expect(result.action).toBe("deny");
});

test("xargs (no subcommand, empty child binary): no matching rules -> decision is ask", () => {
    const rules: IRule[] = [binaryMatchRule("grep", { decision: { action: "allow" } })];
    const result = decide(makeBashCall("xargs"), rules);
    expect(result.action).toBe("ask");
});

// ---------------------------------------------------------------------------
// Pipe combinations
// ---------------------------------------------------------------------------

test("find . | xargs grep: rules allow both find and grep -> decision is allow", () => {
    const rules: IRule[] = [
        binaryMatchRule("find", { decision: { action: "allow" } }),
        binaryMatchRule("grep", { decision: { action: "allow" } }),
    ];
    const result = decide(makeBashCall("find . | xargs grep"), rules);
    expect(result.action).toBe("allow");
});

test("find . | xargs rm: rule denies rm -> decision is deny", () => {
    const rules: IRule[] = [
        binaryMatchRule("find", { decision: { action: "allow" } }),
        binaryMatchRule("rm", { decision: { action: "deny" } }),
    ];
    const result = decide(makeBashCall("find . | xargs rm"), rules);
    expect(result.action).toBe("deny");
});

// ---------------------------------------------------------------------------
// xargs options do not interfere
// ---------------------------------------------------------------------------

test("xargs -n 1 grep: rule allows grep -> xargs option does not interfere -> allow", () => {
    const rules: IRule[] = [binaryMatchRule("grep", { decision: { action: "allow" } })];
    const result = decide(makeBashCall("xargs -n 1 grep"), rules);
    expect(result.action).toBe("allow");
});
