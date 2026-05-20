import { AstNode, IEnvironment, IRule, IRuleOutcome, IToolCall, ABSTAIN } from "../../types";

// envPrefixRule: built-in semantic rule that handles `FOO=bar cmd` style env-var prefixes.
// Matches any Command leaf that has a non-empty envPrefix AND a non-empty binary (distinguishing
// it from a standalone assignment handled by envSetRule). Merges the prefix vars into a
// scopedEnv so that subsequent rules at the same node can see them, but siblings cannot.
// Decision is always abstain — this rule only installs env vars transiently.
export const envPrefixRule: IRule = function envPrefixRule(node: AstNode, env: IEnvironment, _call: IToolCall): IRuleOutcome {
    if (node.type !== "command") {
        return ABSTAIN;
    }
    if (node.binary === "") {
        return ABSTAIN;
    }
    if (Object.keys(node.envPrefix).length === 0) {
        return ABSTAIN;
    }

    const scopedEnv: IEnvironment = {
        ...env,
        env: { ...env.env, ...node.envPrefix },
    };

    return {
        decision: { action: "abstain" },
        scopedEnv,
    };
};
