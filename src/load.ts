import { readFile, readdir, stat } from "fs/promises";
import { join } from "path";
import { IAuditLogger, logConfigLoad } from "./audit-log";
import { IPermissionsConfig } from "./config";
import { parsePermissionsYaml } from "./yaml-source";
import { BashRuleFactory } from "./rules/bash-rule-factory";
import { builtinRules } from "./rules/builtin";
import { FileToolRuleFactory } from "./rules/file-tool-rule-factory";
import { GenericToolRuleFactory } from "./rules/generic-tool-rule-factory";
import { GrepRuleFactory } from "./rules/grep-rule-factory";
import { IRule, IRuleFactory } from "./rules/rule";
import { RedirectRuleFactory } from "./rules/redirect-rule";
import { WebFetchRuleFactory } from "./rules/webfetch-rule-factory";

// Dedicated section factories, keyed by lowercase section name.
const sectionFactories: Record<string, IRuleFactory> = {
    bash: new BashRuleFactory(),
    read: new FileToolRuleFactory("read"),
    write: new FileToolRuleFactory("write"),
    edit: new FileToolRuleFactory("edit"),
    multi_edit: new FileToolRuleFactory("multiedit"),
    webfetch: new WebFetchRuleFactory(),
    grep: new GrepRuleFactory(),
    redirect: new RedirectRuleFactory(),
};

// IRules holds all permission rules for one evaluation pass.
export interface IRules {

    // Rules to match against the tool/command AST.
    rules: IRule[];
}

// Load one permissions.yaml section using a rule factory.
export function loadSection(permissionsConfig: IPermissionsConfig, sectionKey: string, factory: IRuleFactory): IRule[] {

    const sectionConfig = permissionsConfig[sectionKey];
    if (!sectionConfig) {
        return [];
    }

    return factory.load(sectionConfig);
}

// Load permission rules from one permissions.yaml file on disk.
export async function loadConfigFile(configPath: string): Promise<IRule[]> {

    let content: string;

    try {
        content = await readFile(configPath, "utf-8");
    }
    catch (readError) {
        const errorCode = (readError as NodeJS.ErrnoException).code;

        // A missing permissions.yaml is fine; anything else is an error.
        if (errorCode === "ENOENT") {
            return [];
        }

        throw readError;
    }

    const permissionsConfig = parsePermissionsYaml(content, configPath);

    if (permissionsConfig === null || typeof permissionsConfig !== "object" || Array.isArray(permissionsConfig)) {
        throw new Error("permissions.yaml: root must be an object");
    }

    const configRules: IRule[] = [];

    for (const sectionKey of Object.keys(permissionsConfig)) {
        configRules.push(...loadSection(
            permissionsConfig,
            sectionKey,
            sectionFactories[sectionKey.toLowerCase()] || new GenericToolRuleFactory(sectionKey)
        ));
    }

    return configRules;
}

// Load every config file from one permissions.d directory, in sorted filename order.
async function loadPermissionsDir(permissionsDir: string, displayPrefix: string, logger: IAuditLogger): Promise<IRule[]> {

    const configFileNames: string[] = [];

    try {
        const dirEntries = await readdir(permissionsDir);

        for (const entryName of dirEntries) {
            if (entryName.startsWith(".")) {
                continue;
            }

            if (!entryName.endsWith(".yaml") && !entryName.endsWith(".yml")) {
                continue;
            }

            const entryPath = join(permissionsDir, entryName);
            const entryStat = await stat(entryPath);
            if (entryStat.isFile()) {
                configFileNames.push(entryName);
            }
        }
    }
    catch (readError) {
        const errorCode = (readError as NodeJS.ErrnoException).code;

        // No permissions.d folder is fine; anything else is an error.
        if (errorCode !== "ENOENT") {
            throw readError;
        }
    }

    // Same order every time.
    configFileNames.sort();

    // Load each config file in this directory.
    const dirRules: IRule[] = [];
    for (const configFileName of configFileNames) {
        const configFileRules = await loadConfigFile(join(permissionsDir, configFileName));
        logConfigLoad(logger, `${displayPrefix}/${configFileName}`, configFileRules.length);
        dirRules.push(...configFileRules);
    }

    return dirRules;
}

// Load all permission rules from home permissions.d files and the project's permissions.yaml.
export async function load(projectDir: string, homeDir: string, logger: IAuditLogger): Promise<IRules> {

    // Built-in rules always apply first.
    const rules: IRule[] = [...builtinRules];

    // Load the home's main permissions.yaml when present.
    const homeMainRules = await loadConfigFile(join(homeDir, ".claude", "permissions.yaml"));
    logConfigLoad(logger, "~/.claude/permissions.yaml", homeMainRules.length);
    rules.push(...homeMainRules);

    // Collect yaml file names from ~/.claude/permissions.d (or the test home dir).
    const homePermissionsDir = join(homeDir, ".claude", "permissions.d");
    rules.push(...await loadPermissionsDir(homePermissionsDir, "~/.claude/permissions.d", logger));

    // Then load the project's main permissions.yaml when present.
    const projectMainRules = await loadConfigFile(join(projectDir, ".claude", "permissions.yaml"));
    logConfigLoad(logger, ".claude/permissions.yaml", projectMainRules.length);
    rules.push(...projectMainRules);

    // Load config files from the project's .claude/permissions.d directory.
    rules.push(...await loadPermissionsDir(join(projectDir, ".claude", "permissions.d"), ".claude/permissions.d", logger));

    return { rules };
}
