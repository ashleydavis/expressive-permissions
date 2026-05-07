import { buildAst, describeNode } from "./build-ast";
import { registry } from "./rules";
import { IAuditLogger, toLocalISOString } from "./audit-log";
import {
    AstNode,
    Annotation,
    BinOp,
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


// isLeaf returns true for AST nodes that have no child nodes to walk.
// Intermediate nodes carry child references in well-known fields: BinOp uses "left"/"right",
// Bash uses "ast". Any node without those fields is a leaf.
export function isLeaf(node: AstNode): boolean {
    return !("left" in node) && !("ast" in node);
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
        const rulesResult = registry.runRules(node, env, call, logger);
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
        const denyReason = childrenAnnotation.decision.reason;
        logger.log({
            type: "aggregation",
            timestamp: toLocalISOString(new Date()),
            cmd: describeNode(node),
            decision: "deny",
            reason: denyReason,
        });
        return { annotation: childrenAnnotation, envOut: childrenResult.envOut };
    }

    const rulesResult = registry.runRules(node, env, call, logger);
    const envOut = rulesResult.envUpdate(childrenResult.envOut);
    const annotation = combine(childrenAnnotation, rulesResult.annotation);
    const combinedReason = annotation.decision.reason;

    logger.log({
        type: "aggregation",
        timestamp: toLocalISOString(new Date()),
        cmd: describeNode(node),
        decision: annotation.decision.action,
        reason: combinedReason,
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

    const finalReason = decision.reason;
    logger.log({
        type: "final_decision",
        timestamp: toLocalISOString(new Date()),
        tool: call.tool_name,
        cmd: describeNode(root),
        decision: decision.action,
        reason: finalReason,
    });

    return decision;
}
