import { resolve } from "path";
import { AstNode, Environment, Rule, RuleOutcome, ToolCall, ABSTAIN } from "../../types";

// Extracts the cd target string from a Command node's cmd field.
// Returns empty string when no positional was supplied.
function getCdTarget(cmd: string | string[]): string {
    if (typeof cmd === "string") {
        return cmd;
    }
    if (cmd.length === 0) {
        return "";
    }
    return cmd[0];
}

// Returns true when the cd target cannot be resolved to an absolute path.
// Unresolvable targets include: empty string, "-" (previous dir), and any string containing "$"
// (an unexpanded variable reference).
function isUnresolvable(target: string): boolean {
    if (target === "" || target === "-") {
        return true;
    }
    if (target.includes("$")) {
        return true;
    }
    return false;
}

// cdRule: built-in semantic rule that tracks cwd changes caused by `cd` commands.
// Matches any Command leaf with binary "cd". Returns a persistent env update with the
// new cwd resolved from the target. Decision is always abstain — this rule only updates env.
// When the target is unresolvable (no arg, "-", unexpanded var), sets cwdResolved: false.
export const cdRule: Rule = function cdRule(node: AstNode, env: Environment, _call: ToolCall): RuleOutcome {
    if (node.type !== "command" || node.binary !== "cd") {
        return ABSTAIN;
    }

    const target = getCdTarget(node.cmd);

    if (isUnresolvable(target)) {
        return {
            decision: { action: "abstain" },
            env: { ...env, cwdResolved: false },
        };
    }

    const newCwd = resolve(env.cwd, target);
    return {
        decision: { action: "abstain" },
        env: { ...env, cwd: newCwd, cwdResolved: true },
    };
};
