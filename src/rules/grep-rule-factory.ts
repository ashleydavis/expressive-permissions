import { IGrepConfig } from "../config";
import { IRule, IRuleFactory } from "./rule";
import { GrepRule } from "./grep-rule";

// GrepRuleFactory parses a Grep section into a GrepRule.
export class GrepRuleFactory implements IRuleFactory {

    // Parse a Grep section into one rule.
    load(grepConfig: IGrepConfig): IRule[] {

        if (!grepConfig || typeof grepConfig !== "object" || Array.isArray(grepConfig)) {
            throw new Error("permissions.yaml: Grep must be an object");
        }

        const decide = grepConfig.decide;

        if (typeof decide !== "string") {
            throw new Error("permissions.yaml: Grep must have a decide field");
        }

        const reason = grepConfig.reason;

        if (reason !== undefined && typeof reason !== "string") {
            throw new Error("permissions.yaml: Grep reason must be a string");
        }

        const sourceLocation = grepConfig.sourceLocation;
        return [new GrepRule(decide, reason, sourceLocation)];
    }
}
