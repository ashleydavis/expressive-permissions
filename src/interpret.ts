import { buildAst } from "./build-ast";
import { rules } from "./rules";
import { IAuditLogger, toLocalISOString } from "./audit-log";
import {
    AstNode,
    Annotation,
    BinOp,
    Command,
    Decision,
    Environment,
    IAskDecision,
    ToolCall,
} from "./types";

// The default ask decision returned when no rule produces a concrete outcome at a leaf.
const ASK: IAskDecision = { action: "ask" };

// Result returned by the internal interpret walker for a single node.
export interface InterpretResult {
    // The aggregated annotation (decision + attribution) for this node.
    annotation: Annotation;
    // The environment state after evaluating this node and all its descendants.
    envOut: Environment;
}

// Result returned by runRules for a single node after iterating the full rule list.
interface IRunRulesResult {
    // The strictest-wins annotation produced by all rules at this node.
    annotation: Annotation;
    // Applies all persistent env updates from this node's rules to a base environment.
    // Returns the base unchanged when no rule produced a persistent env update.
    envUpdate: (environment: Environment) => Environment;
}

// expandToken substitutes $VAR and ${VAR} references in a single string using the
// provided vars dict. Unknown variable references are left as-is.
export function expandToken(token: string, vars: Record<string, string>): string {
    return token.replace(
        /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
        (match: string, braced: string, unbraced: string) => {
            const varName = braced || unbraced;
            return vars[varName] !== undefined ? vars[varName] : match;
        }
    );
}

// expandCommandOptions clones a Command node with binary, flag values, and positionals expanded
// against the provided vars dict. The raw field is preserved unchanged.
export function expandCommandOptions(node: Command, vars: Record<string, string>): Command {
    const expandedOptions: Record<string, string | boolean> = {};
    for (const [key, value] of Object.entries(node.options)) {
        expandedOptions[key] = typeof value === "string" ? expandToken(value, vars) : value;
    }

    let expandedCmd: string | string[];
    if (typeof node.cmd === "string") {
        expandedCmd = expandToken(node.cmd, vars);
    } else {
        expandedCmd = node.cmd.map((positional: string) => expandToken(positional, vars));
    }

    return {
        ...node,
        binary: expandToken(node.binary, vars),
        options: expandedOptions,
        cmd: expandedCmd,
    };
}

// Numeric priority table for strictest-wins comparisons: abstain(0) < allow(1) < ask(2) < deny(3).
const RANK: Record<string, number> = {
    abstain: 0,
    allow: 1,
    ask: 2,
    deny: 3,
};

// rank returns the numeric priority of a decision action for strictest-wins comparisons.
export function rank(decision: Decision): number {
    return RANK[decision.action] ?? 0;
}

// describeNode returns a human-readable string representation of an AST node for log output.
// For command nodes it returns the raw command string. For tool-root leaf nodes it returns
// the relevant file path or tool name. For intermediate nodes it recursively rebuilds
// the expression from its children.
export function describeNode(node: AstNode): string {
    switch (node.type) {
        case "command":
            return node.raw;
        case "binop":
            return `${describeNode(node.left)} ${node.op} ${describeNode(node.right)}`;
        case "bash":
            return node.raw;
        case "read":
            return node.file_path;
        case "write":
            return node.file_path;
        case "edit":
            return node.file_path;
        case "multiedit":
            return node.file_path;
        case "other":
            return node.tool_name;
    }
}

// isLeaf returns true for AST nodes that have no child nodes to walk.
// Intermediate nodes carry child references in well-known fields: BinOp uses "left"/"right",
// Bash uses "ast". Any node without those fields is a leaf.
export function isLeaf(node: AstNode): boolean {
    return !("left" in node) && !("ast" in node);
}

// runRules iterates the registered rule list at a single node with deny-short-circuit and
// strictest-wins semantics. Before each rule at a Command node, options are expanded against
// the current runningEnv. Persistent (env) and scoped (scopedEnv) updates are threaded
// through runningEnv so later rules at the same node see earlier rules' env changes.
// Scoped changes do not escape this function; only persistent changes are captured in envUpdate.
function runRules(node: AstNode, env: Environment, call: ToolCall, logger: IAuditLogger): IRunRulesResult {
    let runningEnv: Environment = env;
    let lastPersistentEnv: Environment | null = null;
    let bestAnnotation: Annotation = { decision: { action: "abstain" } };

    for (const rule of rules) {
        const effectiveNode: AstNode =
            node.type === "command"
                ? expandCommandOptions(node, runningEnv.env)
                : node;

        const outcome = rule(effectiveNode, runningEnv, call);

        if (outcome.env !== undefined) {
            runningEnv = outcome.env;
            lastPersistentEnv = outcome.env;
        }

        if (outcome.scopedEnv !== undefined) {
            runningEnv = outcome.scopedEnv;
        }

        if (outcome.decision.action !== "abstain") {
            const timestamp = toLocalISOString(new Date());
            const reason = "reason" in outcome.decision ? outcome.decision.reason : undefined;
            logger.log({
                type: "rule_match",
                timestamp,
                nodeType: node.type,
                ruleName: rule.name || undefined,
                decision: outcome.decision.action,
                reason,
                cmd: describeNode(effectiveNode),
            });
        }

        if (outcome.decision.action === "deny") {
            bestAnnotation = {
                decision: outcome.decision,
                ruleName: rule.name || undefined,
            };
            break;
        }

        if (
            outcome.decision.action !== "abstain" &&
            rank(outcome.decision) >= rank(bestAnnotation.decision)
        ) {
            bestAnnotation = {
                decision: outcome.decision,
                ruleName: rule.name || undefined,
            };
        }
    }

    const capturedPersistentEnv = lastPersistentEnv;
    return {
        annotation: bestAnnotation,
        envUpdate: (environment: Environment) =>
            capturedPersistentEnv !== null ? capturedPersistentEnv : environment,
    };
}

// aggregateChildren combines the annotations from child nodes into a single annotation.
// Any deny → deny; all allow → allow; otherwise → ask, preserving the reason from the
// strictest ask child so callers can surface a meaningful message.
export function aggregateChildren(childAnnotations: Annotation[]): Annotation {
    for (const annotation of childAnnotations) {
        if (annotation.decision.action === "deny") {
            return annotation;
        }
    }
    if (childAnnotations.every((annotation: Annotation) => annotation.decision.action === "allow")) {
        return childAnnotations[childAnnotations.length - 1];
    }
    const askAnnotations = childAnnotations.filter(
        (annotation: Annotation) => annotation.decision.action === "ask"
    );
    if (askAnnotations.length > 0) {
        return askAnnotations[askAnnotations.length - 1];
    }
    return { decision: ASK };
}

// combine layers an intermediate node's own rule result on top of the children's aggregated
// annotation. deny/ask/allow from own rules override or reinforce the children status;
// abstain preserves the children status.
export function combine(childrenAnnotation: Annotation, ownRuleAnnotation: Annotation): Annotation {
    if (ownRuleAnnotation.decision.action === "abstain") {
        return childrenAnnotation;
    }
    return ownRuleAnnotation;
}

// walkChildren walks the direct children of an intermediate node with operator-specific env
// semantics. seq/and thread env left→right→up; or/pipe discard subtree env changes.
// Returns child annotations and the environment to propagate upward.
// IWalkChildrenResult is the return type of walkChildren.
interface IWalkChildrenResult {
    // The annotation produced by each direct child node.
    childAnnotations: Annotation[];
    // The environment to propagate upward after walking all children.
    envOut: Environment;
}

function walkChildren(
    node: AstNode,
    env: Environment,
    call: ToolCall,
    logger: IAuditLogger
): IWalkChildrenResult {
    if (node.type === "bash") {
        const childResult = interpret(node.ast, env, call, logger);
        return {
            childAnnotations: [childResult.annotation],
            envOut: childResult.envOut,
        };
    }

    const binop = node as BinOp;

    if (binop.op === ";" || binop.op === "&&") {
        const leftResult = interpret(binop.left, env, call, logger);
        const rightResult = interpret(binop.right, leftResult.envOut, call, logger);
        return {
            childAnnotations: [leftResult.annotation, rightResult.annotation],
            envOut: rightResult.envOut,
        };
    }

    // || and |: both sides see parent env; parent env is returned (no propagation)
    const leftResult = interpret(binop.left, env, call, logger);
    const rightResult = interpret(binop.right, env, call, logger);
    return {
        childAnnotations: [leftResult.annotation, rightResult.annotation],
        envOut: env,
    };
}

// interpret recursively walks an AST node, runs rules, and returns an InterpretResult.
// Leaf nodes default to ask when all rules abstain. Intermediate nodes aggregate child
// results first (deny short-circuits) then layer their own rule result on top.
function interpret(node: AstNode, env: Environment, call: ToolCall, logger: IAuditLogger): InterpretResult {
    if (isLeaf(node)) {
        const rulesResult = runRules(node, env, call, logger);
        const envOut = rulesResult.envUpdate(env);

        let annotation = rulesResult.annotation;
        if (annotation.decision.action === "abstain") {
            annotation = { decision: ASK };
        }
        return { annotation, envOut };
    }

    const childrenResult = walkChildren(node, env, call, logger);
    const childrenAnnotation = aggregateChildren(childrenResult.childAnnotations);

    if (childrenAnnotation.decision.action === "deny") {
        logger.log({
            type: "aggregation",
            timestamp: toLocalISOString(new Date()),
            nodeType: node.type,
            op: node.type === "binop" ? (node as BinOp).op : undefined,
            childrenDecision: childrenAnnotation.decision.action,
            ownDecision: "abstain",
            combined: "deny",
        });
        return { annotation: childrenAnnotation, envOut: childrenResult.envOut };
    }

    const rulesResult = runRules(node, env, call, logger);
    const envOut = rulesResult.envUpdate(childrenResult.envOut);
    const annotation = combine(childrenAnnotation, rulesResult.annotation);

    logger.log({
        type: "aggregation",
        timestamp: toLocalISOString(new Date()),
        nodeType: node.type,
        op: node.type === "binop" ? (node as BinOp).op : undefined,
        childrenDecision: childrenAnnotation.decision.action,
        ownDecision: rulesResult.annotation.decision.action,
        combined: annotation.decision.action,
    });

    return { annotation, envOut };
}

// decide is the public entry point called by pre-hook.ts. It builds the root AST from the
// ToolCall, initialises env0 from the call's cwd, runs the full interpreter pass, and
// returns the root decision. A root abstain (which should not occur in practice) is
// promoted to ask as a safe default.
export function decide(call: ToolCall, logger: IAuditLogger): Decision {
    const timestamp = toLocalISOString(new Date());

    logger.log({
        type: "tool_request",
        timestamp,
        tool: call.tool_name,
        input: call.tool_input as Record<string, unknown>,
        cwd: call.cwd,
    });

    const root = buildAst(call);
    const env0: Environment = {
        cwd: call.cwd,
        cwdResolved: true,
        env: {},
    };

    const result = interpret(root, env0, call, logger);
    let decision = result.annotation.decision;

    if (decision.action === "abstain") {
        decision = ASK;
    }

    const finalReason = "reason" in decision ? decision.reason : undefined;
    logger.log({
        type: "final_decision",
        timestamp: toLocalISOString(new Date()),
        tool: call.tool_name,
        decision: decision.action,
        reason: finalReason,
    });

    return decision;
}
