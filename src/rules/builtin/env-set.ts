import { AstNode, Environment, Rule, RuleOutcome, ToolCall, ABSTAIN } from "../../types";

// envSetRule: built-in semantic rule that handles standalone `FOO=bar` assignments (no binary).
// Matches Command leaves with binary "" and at least one envPrefix entry. Merges the vars
// into a persistent env update so subsequent commands in the same sequence can read them.
// Decision is always abstain — this rule only installs env vars persistently.
export const envSetRule: Rule = function envSetRule(node: AstNode, env: Environment, _call: ToolCall): RuleOutcome {
    if (node.type !== "command") {
        return ABSTAIN;
    }
    if (node.binary !== "") {
        return ABSTAIN;
    }
    if (Object.keys(node.envPrefix).length === 0) {
        return ABSTAIN;
    }

    const updatedEnv: Environment = {
        ...env,
        env: { ...env.env, ...node.envPrefix },
    };

    return {
        decision: { action: "abstain" },
        env: updatedEnv,
    };
};
