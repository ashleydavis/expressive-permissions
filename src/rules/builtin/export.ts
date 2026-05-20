import { AstNode, IEnvironment, IRule, IRuleOutcome, IToolCall, ABSTAIN } from "../../types";

// exportRule: built-in semantic rule that handles `export FOO=bar [BAZ=qux ...]` commands.
// Matches any Command leaf with binary "export". Parses KEY=VALUE tokens from the positionals
// and merges them into a persistent env update. Decision is always abstain.
// Abstains when there are no KEY=VALUE tokens (e.g. `export` with no args).
export const exportRule: IRule = function exportRule(node: AstNode, env: IEnvironment, _call: IToolCall): IRuleOutcome {
    if (node.type !== "command" || node.binary !== "export") {
        return ABSTAIN;
    }

    const positionals = Array.isArray(node.cmd) ? node.cmd : (node.cmd ? [node.cmd] : []);
    const updates: Record<string, string> = {};

    for (const token of positionals) {
        const eqIndex = token.indexOf("=");
        if (eqIndex > 0) {
            updates[token.slice(0, eqIndex)] = token.slice(eqIndex + 1);
        }
    }

    if (Object.keys(updates).length === 0) {
        return ABSTAIN;
    }

    return {
        decision: { action: "abstain" },
        env: { ...env, env: { ...env.env, ...updates } },
    };
};
