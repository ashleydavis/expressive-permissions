import { walkChildren, IWalkChildrenResult, ILeafEvaluation } from "../interpret";
import { NullAuditLogger } from "../audit-log";
import { RuleLayer, RuleRegistry } from "../rule-registry";
import { AstNode, ICommand, IXargsNode, IEnvironment, IRule, IRuleOutcome, IToolCall, ABSTAIN } from "../types";

// makeEnv builds a minimal IEnvironment.
function makeEnv(cwd: string = "/start"): IEnvironment {
    return { cwd, cwdResolved: true, env: {} };
}

// makeCommand builds a minimal ICommand node.
function makeCommand(binary: string): ICommand {
    return { type: "command", binary, options: {}, cmd: [], envPrefix: {}, redirects: [], raw: binary };
}

// makeXargsNode builds a minimal IXargsNode with the given child binary.
function makeXargsNode(childBinary: string): IXargsNode {
    return {
        type: "xargs",
        options: {},
        child: makeCommand(childBinary),
        raw: `xargs ${childBinary}`,
    };
}

// dummyCall is a minimal IToolCall placeholder.
const dummyCall: IToolCall = { tool_name: "Bash", tool_input: { command: "" }, cwd: "/start" };

// dummyLeafEvaluations is an empty collector passed to walkChildren in unit tests.
const dummyLeafEvaluations: ILeafEvaluation[] = [];

// makeRegistry builds a RuleRegistry from the given rules.
function makeRegistry(rules: IRule[]): RuleRegistry {
    return new RuleRegistry([new RuleLayer(rules)]);
}

// binaryMatchRule returns a rule that returns the given outcome for commands matching binary.
function binaryMatchRule(binary: string, outcome: IRuleOutcome): IRule {
    return function matchRule(node: AstNode): IRuleOutcome {
        if (node.type === "command" && node.binary === binary) {
            return outcome;
        }
        return ABSTAIN;
    };
}

// ---------------------------------------------------------------------------
// xargs branch: single child annotation returned
// ---------------------------------------------------------------------------

test("walkChildren xargs: child allow rule produces one allow annotation", () => {
    const registry = makeRegistry([binaryMatchRule("grep", { decision: { action: "allow" } })]);
    const result: IWalkChildrenResult = walkChildren(
        makeXargsNode("grep"), makeEnv(), dummyCall, new NullAuditLogger(), registry, dummyLeafEvaluations
    );
    expect(result.childIAnnotations).toHaveLength(1);
    expect(result.childIAnnotations[0].decision.action).toBe("allow");
});

test("walkChildren xargs: child deny rule produces one deny annotation", () => {
    const registry = makeRegistry([binaryMatchRule("rm", { decision: { action: "deny" } })]);
    const result: IWalkChildrenResult = walkChildren(
        makeXargsNode("rm"), makeEnv(), dummyCall, new NullAuditLogger(), registry, dummyLeafEvaluations
    );
    expect(result.childIAnnotations).toHaveLength(1);
    expect(result.childIAnnotations[0].decision.action).toBe("deny");
});

test("walkChildren xargs: no matching child rule produces ask annotation (leaf default)", () => {
    const registry = makeRegistry([]);
    const result: IWalkChildrenResult = walkChildren(
        makeXargsNode("grep"), makeEnv(), dummyCall, new NullAuditLogger(), registry, dummyLeafEvaluations
    );
    expect(result.childIAnnotations).toHaveLength(1);
    expect(result.childIAnnotations[0].decision.action).toBe("ask");
});

test("walkChildren xargs: empty child binary (bare xargs) produces ask annotation", () => {
    const registry = makeRegistry([]);
    const result: IWalkChildrenResult = walkChildren(
        makeXargsNode(""), makeEnv(), dummyCall, new NullAuditLogger(), registry, dummyLeafEvaluations
    );
    expect(result.childIAnnotations).toHaveLength(1);
    expect(result.childIAnnotations[0].decision.action).toBe("ask");
});

// ---------------------------------------------------------------------------
// xargs branch: env propagation
// ---------------------------------------------------------------------------

test("walkChildren xargs: envOut equals input env (xargs does not modify env)", () => {
    const registry = makeRegistry([]);
    const env = makeEnv("/project");
    const result: IWalkChildrenResult = walkChildren(
        makeXargsNode("grep"), env, dummyCall, new NullAuditLogger(), registry, dummyLeafEvaluations
    );
    expect(result.envOut.cwd).toBe("/project");
});
