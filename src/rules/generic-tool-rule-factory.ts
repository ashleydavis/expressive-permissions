import { IGenericToolConfig } from "../config";
import { IRule, IRuleFactory } from "./rule";
import { GenericToolRule } from "./generic-tool-rule";

// GenericToolRuleFactory parses one top-level YAML key into a GenericToolRule.
export class GenericToolRuleFactory implements IRuleFactory {

    // Top-level permissions.yaml key; used as the implicit tool_name glob when the entry omits tool.
    configKey: string;

    constructor(configKey: string) {
        this.configKey = configKey;
    }

    // Parse one top-level key entry into one rule.
    load(genericToolConfig: IGenericToolConfig): IRule[] {

        if (!genericToolConfig || typeof genericToolConfig !== "object" || Array.isArray(genericToolConfig)) {
            throw new Error(`permissions.yaml: ${this.configKey} must be an object`);
        }

        const decide = genericToolConfig.decide;

        if (typeof decide !== "string") {
            throw new Error(`permissions.yaml: ${this.configKey} must have a decide field`);
        }

        const reason = genericToolConfig.reason;

        if (reason !== undefined && typeof reason !== "string") {
            throw new Error(`permissions.yaml: ${this.configKey} reason must be a string`);
        }

        const toolInField = genericToolConfig["tool-in"];

        const sourceLocation = genericToolConfig.sourceLocation;

        if (toolInField !== undefined) {
            if (!Array.isArray(toolInField)) {
                throw new Error(`permissions.yaml: ${this.configKey} tool-in must be an array`);
            }

            const toolIn: string[] = [];

            for (const item of toolInField) {
                if (typeof item !== "string") {
                    throw new Error(`permissions.yaml: ${this.configKey} tool-in entries must be strings`);
                }

                toolIn.push(item);
            }

            return [new GenericToolRule(undefined, decide, reason, toolIn, sourceLocation)];
        }

        const toolField = genericToolConfig.tool;
        let pattern = this.configKey;

        if (toolField !== undefined) {
            if (typeof toolField !== "string") {
                throw new Error(`permissions.yaml: ${this.configKey} tool must be a string`);
            }

            pattern = toolField;
        }

        return [new GenericToolRule(pattern, decide, reason, undefined, sourceLocation)];
    }
}
