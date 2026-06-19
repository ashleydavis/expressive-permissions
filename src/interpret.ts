import { buildAst, describeNode } from "./build-ast";
import { IRuleRegistry } from "./rule-registry";
import { IAuditLogger, toLocalISOString } from "./audit-log";
import {
    AstNode,
    IAnnotation,
    IBinOp,
    Decision,
    ICommandDescriptor,
    IEnvironment,
    IAskDecision,
    IToolCall,
} from "./types";

// The default ask decision returned when no rule produces a concrete outcome at a leaf.
const ASK: IAskDecision = { action: "ask" };

// Result returned by the internal interpret walker for a single node.
export interface IInterpretResult {
    // The aggregated annotation (decision + attribution) for this node.
    annotation: IAnnotation;
    // The environment state after evaluating this node and all its descendants.
    envOut: IEnvironment;
}


// isLeaf returns true for AST nodes that have no child nodes to walk.
// Intermediate nodes carry child references in well-known fields: IBinOp uses "left"/"right",
// Bash uses "ast", ForLoop/WhileLoop use "body", xargs uses "child", IfStatement uses
// "condition"/"thenBranch"/"elseBranch", Group uses "body", CaseStatement uses "clauses". Any
// node without those fields is a leaf. (A command leaf may carry "substitutions", which the
// interpreter evaluates inline rather than via walkChildren.)
export function isLeaf(node: AstNode): boolean {
    return node.type !== "binop"
        && node.type !== "bash"
        && node.type !== "for_loop"
        && node.type !== "while_loop"
        && node.type !== "xargs"
        && node.type !== "if_statement"
        && node.type !== "group"
        && node.type !== "case_statement";
}


// aggregateChildren combines the annotations from child nodes into a single annotation.
// Any deny → deny; all allow → allow; otherwise → ask, preserving the reason from the
// strictest ask child so callers can surface a meaningful message.
export function aggregateChildren(childIAnnotations: IAnnotation[]): IAnnotation {
    for (const annotation of childIAnnotations) {
        if (annotation.decision.action === "deny") {
            return annotation;
        }
    }
    if (childIAnnotations.every((annotation: IAnnotation) => annotation.decision.action === "allow")) {
        return childIAnnotations[childIAnnotations.length - 1];
    }
    const askIAnnotations = childIAnnotations.filter(
        (annotation: IAnnotation) => annotation.decision.action === "ask"
    );
    if (askIAnnotations.length > 0) {
        return askIAnnotations[askIAnnotations.length - 1];
    }
    return { decision: ASK };
}

// combine layers an intermediate node's own rule result on top of the children's aggregated
// annotation. deny/ask/allow from own rules override or reinforce the children status;
// abstain preserves the children status.
export function combine(childrenIAnnotation: IAnnotation, ownRuleIAnnotation: IAnnotation): IAnnotation {
    if (ownRuleIAnnotation.decision.action === "abstain") {
        return childrenIAnnotation;
    }
    return ownRuleIAnnotation;
}

// walkChildren walks the direct children of an intermediate node with operator-specific env
// semantics. seq/and thread env left→right→up; or/pipe discard subtree env changes.
// Returns child annotations and the environment to propagate upward.
// IWalkChildrenResult is the return type of walkChildren.
export interface IWalkChildrenResult {
    // The annotation produced by each direct child node.
    childIAnnotations: IAnnotation[];
    // The environment to propagate upward after walking all children.
    envOut: IEnvironment;
}

export function walkChildren(
    node: AstNode,
    env: IEnvironment,
    call: IToolCall,
    logger: IAuditLogger,
    registry: IRuleRegistry
): IWalkChildrenResult {
    if (node.type === "bash") {
        const childResult = interpret(node.ast, env, call, logger, registry);
        return {
            childIAnnotations: [childResult.annotation],
            envOut: childResult.envOut,
        };
    }

    if (node.type === "xargs") {
        const childResult = interpret(node.child, env, call, logger, registry);
        return {
            childIAnnotations: [childResult.annotation],
            envOut: childResult.envOut,
        };
    }

    if (node.type === "for_loop") {
        const childIAnnotations: IAnnotation[] = [];
        for (const item of node.items) {
            const iterEnv: IEnvironment = {
                ...env,
                env: { ...env.env, [node.variable]: item },
            };
            const bodyResult = interpret(node.body, iterEnv, call, logger, registry);
            childIAnnotations.push(bodyResult.annotation);
        }

        // An empty items list means zero iterations; aggregateChildren cannot handle an
        // empty array, so seed an abstain so the for-loop falls through to the default ask.
        if (childIAnnotations.length === 0) {
            childIAnnotations.push({ decision: { action: "abstain" } });
        }
        return {
            childIAnnotations,
            envOut: env,
        };
    }

    if (node.type === "while_loop") {
        // The condition always runs; its env changes flow into the body. The body is walked once
        // for analysis (it may run any number of times). Only the condition's env propagates
        // upward, since the number of iterations is indeterminate.
        const conditionResult = interpret(node.condition, env, call, logger, registry);
        const bodyResult = interpret(node.body, conditionResult.envOut, call, logger, registry);
        return {
            childIAnnotations: [conditionResult.annotation, bodyResult.annotation],
            envOut: conditionResult.envOut,
        };
    }

    if (node.type === "group") {
        // A subshell `( ... )` isolates env changes; a brace group `{ ...; }` propagates them.
        const bodyResult = interpret(node.body, env, call, logger, registry);
        return {
            childIAnnotations: [bodyResult.annotation],
            envOut: node.style === "brace" ? bodyResult.envOut : env,
        };
    }

    if (node.type === "case_statement") {
        // Every clause body is walked since which pattern matches is not known statically. Each
        // body sees the parent env (clauses are alternatives), and parent env propagates upward.
        const childIAnnotations: IAnnotation[] = [];
        for (const clause of node.clauses) {
            const clauseResult = interpret(clause.body, env, call, logger, registry);
            childIAnnotations.push(clauseResult.annotation);
        }
        if (childIAnnotations.length === 0) {
            childIAnnotations.push({ decision: { action: "abstain" } });
        }
        return {
            childIAnnotations,
            envOut: env,
        };
    }

    if (node.type === "if_statement") {
        // The condition always runs; its env changes (e.g. a cd in the test) flow into both
        // branches, matching Bash. then/else are mutually exclusive at runtime but both are
        // walked for permission analysis since the taken branch is not known statically. Only
        // the condition's env propagates upward, as the branch outcome is indeterminate.
        const conditionResult = interpret(node.condition, env, call, logger, registry);
        const childIAnnotations: IAnnotation[] = [conditionResult.annotation];

        const thenResult = interpret(node.thenBranch, conditionResult.envOut, call, logger, registry);
        childIAnnotations.push(thenResult.annotation);

        if (node.elseBranch !== undefined) {
            const elseResult = interpret(node.elseBranch, conditionResult.envOut, call, logger, registry);
            childIAnnotations.push(elseResult.annotation);
        }

        return {
            childIAnnotations,
            envOut: conditionResult.envOut,
        };
    }

    const binop = node as IBinOp;

    if (binop.op === ";" || binop.op === "&&") {
        const leftResult = interpret(binop.left, env, call, logger, registry);
        const rightResult = interpret(binop.right, leftResult.envOut, call, logger, registry);
        return {
            childIAnnotations: [leftResult.annotation, rightResult.annotation],
            envOut: rightResult.envOut,
        };
    }

    // || and |: both sides see parent env; parent env is returned (no propagation)
    const leftResult = interpret(binop.left, env, call, logger, registry);
    const rightResult = interpret(binop.right, env, call, logger, registry);
    return {
        childIAnnotations: [leftResult.annotation, rightResult.annotation],
        envOut: env,
    };
}

// interpret recursively walks an AST node, runs rules, and returns an IInterpretResult.
// Leaf nodes default to ask when all rules abstain. Intermediate nodes aggregate child
// results first (deny short-circuits) then layer their own rule result on top.
function interpret(node: AstNode, env: IEnvironment, call: IToolCall, logger: IAuditLogger, registry: IRuleRegistry): IInterpretResult {
    if (isLeaf(node)) {
        const rulesResult = registry.runRules(node, env, call, logger);
        const envOut = rulesResult.envUpdate(env);

        let annotation = rulesResult.annotation;
        if (annotation.decision.action === "abstain") {
            logger.log({
                type: "no_rule_match",
                timestamp: toLocalISOString(new Date()),
                nodeType: node.type,
                cmd: describeNode(node),
            });
            annotation = { decision: ASK };
        }

        // Evaluate any embedded command substitutions ($(...) / `...`). They run in subshells, so
        // their env changes are discarded, but a denial inside one denies the whole command.
        if (node.type === "command" && node.substitutions !== undefined && node.substitutions.length > 0) {
            const substitutionAnnotations: IAnnotation[] = [annotation];
            for (const substitution of node.substitutions) {
                const substitutionResult = interpret(substitution, env, call, logger, registry);
                substitutionAnnotations.push(substitutionResult.annotation);
            }
            annotation = aggregateChildren(substitutionAnnotations);
        }
        return { annotation, envOut };
    }

    const childrenResult = walkChildren(node, env, call, logger, registry);
    const childrenIAnnotation = aggregateChildren(childrenResult.childIAnnotations);

    if (childrenIAnnotation.decision.action === "deny") {
        const denyReason = childrenIAnnotation.decision.reason;
        logger.log({
            type: "aggregation",
            timestamp: toLocalISOString(new Date()),
            cmd: describeNode(node),
            decision: "deny",
            reason: denyReason,
        });
        return { annotation: childrenIAnnotation, envOut: childrenResult.envOut };
    }

    const rulesResult = registry.runRules(node, env, call, logger);
    const envOut = rulesResult.envUpdate(childrenResult.envOut);
    const annotation = combine(childrenIAnnotation, rulesResult.annotation);
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
// IToolCall, initialises env0 from the call's cwd, runs the full interpreter pass, and
// returns the root decision. A root abstain (which should not occur in practice) is
// promoted to ask as a safe default.
export function decide(call: IToolCall, logger: IAuditLogger, registry: IRuleRegistry, descriptors: Map<string, ICommandDescriptor>): Decision {
    const timestamp = toLocalISOString(new Date());

    logger.log({
        type: "tool_request",
        timestamp,
        tool: call.tool_name,
        input: call.tool_input as Record<string, unknown>,
        cwd: call.cwd,
    });

    const root = buildAst(call, descriptors);
    const env0: IEnvironment = {
        cwd: call.cwd,
        cwdResolved: true,
        env: {},
    };

    const result = interpret(root, env0, call, logger, registry);
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
