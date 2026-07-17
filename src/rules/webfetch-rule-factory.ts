import { IWebFetchConfig } from "../config";
import { IRule, IRuleFactory } from "./rule";
import { WebFetchRule } from "./webfetch-rule";

// WebFetchRuleFactory parses a webfetch section into a WebFetchRule.
export class WebFetchRuleFactory implements IRuleFactory {

    // Parse a webfetch section into one rule.
    load(webFetchConfig: IWebFetchConfig): IRule[] {

        if (!webFetchConfig || typeof webFetchConfig !== "object" || Array.isArray(webFetchConfig)) {
            throw new Error("permissions.yaml: webfetch must be an object");
        }

        const decide = webFetchConfig.decide;
        const host = webFetchConfig.host;
        const hostInValue = webFetchConfig["host-in"];

        if (typeof decide !== "string") {
            throw new Error("permissions.yaml: webfetch must have a decide field");
        }

        const reason = webFetchConfig.reason;

        if (reason !== undefined && typeof reason !== "string") {
            throw new Error("permissions.yaml: webfetch reason must be a string");
        }

        if (host !== undefined && typeof host !== "string") {
            throw new Error("permissions.yaml: webfetch host must be a string");
        }

        const sourceLocation = webFetchConfig.sourceLocation;

        if (hostInValue !== undefined) {
            if (!Array.isArray(hostInValue)) {
                throw new Error("permissions.yaml: webfetch host-in must be an array");
            }

            for (const hostEntry of hostInValue) {
                if (typeof hostEntry !== "string") {
                    throw new Error("permissions.yaml: webfetch host-in entries must be strings");
                }
            }

            return [new WebFetchRule(hostInValue, decide, reason, sourceLocation)];
        }

        if (typeof host === "string") {
            return [new WebFetchRule([host], decide, reason, sourceLocation)];
        }

        // No host filter: match any WebFetch call.
        return [new WebFetchRule([], decide, reason, sourceLocation)];
    }
}
