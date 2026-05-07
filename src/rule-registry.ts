import { watchFile } from "fs";
import { AstNode, Environment, Rule, Annotation, ToolCall, IRunRulesResult, rank } from "./types";
import { IAuditLogger, toLocalISOString } from "./audit-log";
import { expandCommandOptions, describeNode } from "./build-ast";

// IRuleLayer is the interface implemented by every layer in the registry.
export interface IRuleLayer {
    // Runs all rules in this layer for a single AST node, returning the strictest annotation
    // and a persistent env update function.
    runRules(node: AstNode, env: Environment, call: ToolCall, logger: IAuditLogger): IRunRulesResult;
}

// IRuleRegistry is the public interface for the multi-layer rule engine.
export interface IRuleRegistry {
    // Runs all layers in order for a single AST node, threading env and accumulating strictest-wins.
    runRules(node: AstNode, env: Environment, call: ToolCall, logger: IAuditLogger): IRunRulesResult;
}

// runRulesOverList iterates a rule list with deny-short-circuit and strictest-wins semantics.
// Used internally by both RuleLayer and FileLayer.
function runRulesOverList(
    ruleList: Rule[],
    node: AstNode,
    env: Environment,
    call: ToolCall,
    logger: IAuditLogger
): IRunRulesResult {
    let runningEnv: Environment = env;
    let lastPersistentEnv: Environment | null = null;
    let bestAnnotation: Annotation = { decision: { action: "abstain" } };

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
        envUpdate: (environment: Environment) =>
            capturedPersistentEnv !== null ? capturedPersistentEnv : environment,
        nodeRunningEnv: capturedRunningEnv,
    };
}

// RuleLayer holds a static list of rules and evaluates them in order.
export class RuleLayer implements IRuleLayer {
    // The ordered list of rules this layer evaluates.
    private readonly _rules: Rule[];

    constructor(rules: Rule[]) {
        this._rules = rules;
    }

    runRules(node: AstNode, env: Environment, call: ToolCall, logger: IAuditLogger): IRunRulesResult {
        return runRulesOverList(this._rules, node, env, call, logger);
    }
}

// FileLayer watches a YAML config file and reloads its rules whenever the file changes.
// fs.watchFile (polling-based) is used so the watcher works even when the file does not exist.
export class FileLayer implements IRuleLayer {
    // The current compiled rule list, refreshed on file change.
    private _rules: Rule[];

    constructor(loadFn: () => Rule[], filePath: string | undefined) {
        this._rules = loadFn();
        if (filePath !== undefined) {
            watchFile(filePath, { persistent: false, interval: 100 }, () => {
                this._rules = loadFn();
            });
        }
    }

    runRules(node: AstNode, env: Environment, call: ToolCall, logger: IAuditLogger): IRunRulesResult {
        return runRulesOverList(this._rules, node, env, call, logger);
    }
}

// RuleRegistry composes multiple IRuleLayer instances, evaluating them in order and threading
// persistent env updates between layers. Deny short-circuits across layers.
export class RuleRegistry implements IRuleRegistry {
    // The ordered list of layers this registry delegates to.
    private _layers: IRuleLayer[];

    constructor(layers: IRuleLayer[]) {
        this._layers = layers;
    }

    runRules(node: AstNode, env: Environment, call: ToolCall, logger: IAuditLogger): IRunRulesResult {
        // currentEnv threads the full running env (persistent + scoped) between layers so that
        // scoped updates from earlier layers (e.g. envPrefixRule) are visible to later YAML rules.
        let currentEnv: Environment = env;
        let lastPersistentEnv: Environment | null = null;
        let bestAnnotation: Annotation = { decision: { action: "abstain" } };

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
                    envUpdate: (environment: Environment) =>
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
            envUpdate: (environment: Environment) =>
                capturedPersistentEnv !== null ? capturedPersistentEnv : environment,
        };
    }

    // setLayersForTesting replaces the layer list. Used only in unit tests.
    setLayersForTesting(layers: IRuleLayer[]): void {
        this._layers = layers;
    }
}
