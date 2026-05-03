import { buildAst } from "./build-ast";
import { rules } from "./rules";
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

// expandCommandArgs clones a Command node with binary, flag values, and positionals expanded
// against the provided vars dict. The raw field is preserved unchanged.
export function expandCommandArgs(node: Command, vars: Record<string, string>): Command {
    const expandedArgs: Record<string, string | boolean> = {};
    for (const [key, value] of Object.entries(node.args)) {
        expandedArgs[key] = typeof value === "string" ? expandToken(value, vars) : value;
    }

    let expandedPos: string | string[];
    if (typeof node.pos === "string") {
        expandedPos = expandToken(node.pos, vars);
    } else {
        expandedPos = node.pos.map((positional: string) => expandToken(positional, vars));
    }

    return {
        ...node,
        binary: expandToken(node.binary, vars),
        args: expandedArgs,
        pos: expandedPos,
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

// isLeaf returns true for AST nodes that have no child nodes to walk.
// Intermediate nodes carry child references in well-known fields: BinOp uses "left"/"right",
// Bash uses "ast". Any node without those fields is a leaf.
export function isLeaf(node: AstNode): boolean {
    return !("left" in node) && !("ast" in node);
}

// runRules iterates the registered rule list at a single node with deny-short-circuit and
// strictest-wins semantics. Before each rule at a Command node, args are expanded against
// the current runningEnv. Persistent (env) and scoped (scopedEnv) updates are threaded
// through runningEnv so later rules at the same node see earlier rules' env changes.
// Scoped changes do not escape this function; only persistent changes are captured in envUpdate.
function runRules(node: AstNode, env: Environment, call: ToolCall): IRunRulesResult {
    let runningEnv: Environment = env;
    let lastPersistentEnv: Environment | null = null;
    let bestAnnotation: Annotation = { decision: { action: "abstain" } };

    for (const rule of rules) {
        const effectiveNode: AstNode =
            node.type === "command" 
                ? expandCommandArgs(node, runningEnv.env) 
                : node;

        const outcome = rule(effectiveNode, runningEnv, call);

        if (outcome.env !== undefined) {
            runningEnv = outcome.env;
            lastPersistentEnv = outcome.env;
        }

        if (outcome.scopedEnv !== undefined) {
            runningEnv = outcome.scopedEnv;
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
function walkChildren(
    node: AstNode,
    env: Environment,
    call: ToolCall
): { childAnnotations: Annotation[]; envOut: Environment } {
    if (node.type === "bash") {
        const childResult = interpret(node.ast, env, call);
        return {
            childAnnotations: [childResult.annotation],
            envOut: childResult.envOut,
        };
    }

    const binop = node as BinOp;

    if (binop.op === ";" || binop.op === "&&") {
        const leftResult = interpret(binop.left, env, call);
        const rightResult = interpret(binop.right, leftResult.envOut, call);
        return {
            childAnnotations: [leftResult.annotation, rightResult.annotation],
            envOut: rightResult.envOut,
        };
    }

    // || and |: both sides see parent env; parent env is returned (no propagation)
    const leftResult = interpret(binop.left, env, call);
    const rightResult = interpret(binop.right, env, call);
    return {
        childAnnotations: [leftResult.annotation, rightResult.annotation],
        envOut: env,
    };
}

// interpret recursively walks an AST node, runs rules, and returns an InterpretResult.
// Leaf nodes default to ask when all rules abstain. Intermediate nodes aggregate child
// results first (deny short-circuits) then layer their own rule result on top.
function interpret(node: AstNode, env: Environment, call: ToolCall): InterpretResult {
    if (isLeaf(node)) {
        const rulesResult = runRules(node, env, call);
        const envOut = rulesResult.envUpdate(env);

        let annotation = rulesResult.annotation;
        if (annotation.decision.action === "abstain") {
            annotation = { decision: ASK };
        }
        return { annotation, envOut };
    }

    const childrenResult = walkChildren(node, env, call);
    const childrenAnnotation = aggregateChildren(childrenResult.childAnnotations);

    if (childrenAnnotation.decision.action === "deny") {
        return { annotation: childrenAnnotation, envOut: childrenResult.envOut };
    }

    const rulesResult = runRules(node, env, call);
    const envOut = rulesResult.envUpdate(childrenResult.envOut);
    const annotation = combine(childrenAnnotation, rulesResult.annotation);

    return { annotation, envOut };
}

// decide is the public entry point called by hook.ts. It builds the root AST from the
// ToolCall, initialises env0 from the call's cwd, runs the full interpreter pass, and
// returns the root decision. A root abstain (which should not occur in practice) is
// promoted to ask as a safe default.
export function decide(call: ToolCall): Decision {
    const root = buildAst(call);
    const env0: Environment = {
        cwd: call.cwd,
        cwdResolved: true,
        env: {},
    };

    const result = interpret(root, env0, call);
    const decision = result.annotation.decision;

    if (decision.action === "abstain") {
        return ASK;
    }
    return decision;
}
