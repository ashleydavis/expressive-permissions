import { AstNode, IEnvironment, IRule, IAnnotation, IToolCall, IRunRulesResult, rank } from "./types";
import { IAuditLogger, toLocalISOString, logConfigLoad } from "./audit-log";
import { expandCommandOptions, describeNode } from "./build-ast";

// IRuleLayer is the interface implemented by every layer in the registry.
export interface IRuleLayer {
    // Runs all rules in this layer for a single AST node, returning the strictest annotation
    // and a persistent env update function.
    runRules(node: AstNode, env: IEnvironment, call: IToolCall, logger: IAuditLogger): IRunRulesResult;
}

// IRuleRegistry is the public interface for the multi-layer rule engine.
export interface IRuleRegistry {
    // Runs all layers in order for a single AST node, threading env and accumulating strictest-wins.
    runRules(node: AstNode, env: IEnvironment, call: IToolCall, logger: IAuditLogger): IRunRulesResult;
}

// runRulesOverList iterates a rule list with deny-short-circuit and strictest-wins semantics.
// Used internally by both RuleLayer and FileLayer.
function runRulesOverList(
    ruleList: IRule[],
    node: AstNode,
    env: IEnvironment,
    call: IToolCall,
    logger: IAuditLogger
): IRunRulesResult {
    let runningEnv: IEnvironment = env;
    let lastPersistentEnv: IEnvironment | null = null;
    let bestAnnotation: IAnnotation = { decision: { action: "abstain" } };

    for (const rule of ruleList) {
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
            const reason = outcome.decision.reason;
            logger.log({
                type: "rule_match",
                timestamp,
                ruleFile: rule.ruleFile,
                ruleLine: rule.ruleLine,
                decision: outcome.decision.action,
                reason,
                cmd: describeNode(effectiveNode),
            });
        }

        if (outcome.decision.action === "deny") {
            bestAnnotation = {
                decision: outcome.decision,
                ruleFile: rule.ruleFile,
                ruleLine: rule.ruleLine,
            };
            break;
        }

        if (
            outcome.decision.action !== "abstain" &&
            rank(outcome.decision) >= rank(bestAnnotation.decision)
        ) {
            bestAnnotation = {
                decision: outcome.decision,
                ruleFile: rule.ruleFile,
                ruleLine: rule.ruleLine,
            };
        }
    }

    const capturedPersistentEnv = lastPersistentEnv;
    const capturedRunningEnv = runningEnv;
    return {
        annotation: bestAnnotation,
        envUpdate: (environment: IEnvironment) =>
            capturedPersistentEnv !== null ? capturedPersistentEnv : environment,
        nodeRunningEnv: capturedRunningEnv,
    };
}

// RuleLayer holds a static list of rules and evaluates them in order.
export class RuleLayer implements IRuleLayer {
    // The ordered list of rules this layer evaluates.
    private readonly _rules: IRule[];

    constructor(rules: IRule[]) {
        this._rules = rules;
    }

    runRules(node: AstNode, env: IEnvironment, call: IToolCall, logger: IAuditLogger): IRunRulesResult {
        return runRulesOverList(this._rules, node, env, call, logger);
    }
}

// FileLayer loads its rules once at construction time from the supplied loadFn and records
// the load to the supplied audit logger.
export class FileLayer implements IRuleLayer {
    // The compiled rule list, populated once at construction time.
    private readonly _rules: IRule[];

    constructor(loadFn: () => IRule[], displayPath: string, logger: IAuditLogger) {
        this._rules = loadFn();
        logConfigLoad(logger, displayPath, this._rules.length);
    }

    runRules(node: AstNode, env: IEnvironment, call: IToolCall, logger: IAuditLogger): IRunRulesResult {
        return runRulesOverList(this._rules, node, env, call, logger);
    }
}

// RuleRegistry composes multiple IRuleLayer instances, evaluating them in order and threading
// persistent env updates between layers. Deny short-circuits across layers.
export class RuleRegistry implements IRuleRegistry {
    // The ordered list of layers this registry delegates to.
    private readonly _layers: IRuleLayer[];

    constructor(layers: IRuleLayer[]) {
        this._layers = layers;
    }

    runRules(node: AstNode, env: IEnvironment, call: IToolCall, logger: IAuditLogger): IRunRulesResult {
        // currentEnv threads the full running env (persistent + scoped) between layers so that
        // scoped updates from earlier layers (e.g. envPrefixRule) are visible to later YAML rules.
        let currentEnv: IEnvironment = env;
        let lastPersistentEnv: IEnvironment | null = null;
        let bestAnnotation: IAnnotation = { decision: { action: "abstain" } };

        for (const layer of this._layers) {
            const envBeforeLayer = currentEnv;
            const layerResult = layer.runRules(node, currentEnv, call, logger);

            // Thread scoped+persistent env to the next layer for same-node rule visibility.
            currentEnv = layerResult.nodeRunningEnv;

            // Track persistent env separately for propagation to parent/sibling nodes.
            const persistentUpdate = layerResult.envUpdate(envBeforeLayer);
            if (persistentUpdate !== envBeforeLayer) {
                lastPersistentEnv = persistentUpdate;
            }

            if (layerResult.annotation.decision.action === "deny") {
                const capturedDenyPersistentEnv = lastPersistentEnv;
                const capturedDenyRunningEnv = currentEnv;
                return {
                    annotation: layerResult.annotation,
                    nodeRunningEnv: capturedDenyRunningEnv,
                    envUpdate: (environment: IEnvironment) =>
                        capturedDenyPersistentEnv !== null ? capturedDenyPersistentEnv : environment,
                };
            }

            if (
                layerResult.annotation.decision.action !== "abstain" &&
                rank(layerResult.annotation.decision) >= rank(bestAnnotation.decision)
            ) {
                bestAnnotation = layerResult.annotation;
            }
        }

        const capturedPersistentEnv = lastPersistentEnv;
        const capturedRunningEnv = currentEnv;
        return {
            annotation: bestAnnotation,
            nodeRunningEnv: capturedRunningEnv,
            envUpdate: (environment: IEnvironment) =>
                capturedPersistentEnv !== null ? capturedPersistentEnv : environment,
        };
    }
}
