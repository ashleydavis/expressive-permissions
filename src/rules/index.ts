import { join } from "path";
import { cdRule } from "./builtin/cd";
import { envPrefixRule } from "./builtin/env-prefix";
import { envSetRule } from "./builtin/env-set";
import { exportRule } from "./builtin/export";
import { loadHomeConfigRules, loadProjectConfigRules } from "../load-config";
import { RuleLayer, FileLayer, RuleRegistry } from "../rule-registry";

// builtinLayer holds the four built-in semantic rules that handle Bash env/cwd semantics.
// These run before YAML rules so env state is correct when user rules are evaluated.
const builtinLayer = new RuleLayer([cdRule, envPrefixRule, envSetRule, exportRule]);

// homeFilePath is the full path to the home-level permissions config, or undefined if HOME is unset.
const homeFilePath = process.env["HOME"] !== undefined
    ? join(process.env["HOME"], ".claude", "permissions.yaml")
    : undefined;

// projectFilePath is the full path to the project-level permissions config, or undefined if CLAUDE_PROJECT_DIR is unset.
const projectFilePath = process.env["CLAUDE_PROJECT_DIR"] !== undefined
    ? join(process.env["CLAUDE_PROJECT_DIR"], ".claude", "permissions.yaml")
    : undefined;

// homeLayer watches $HOME/.claude/permissions.yaml and reloads on change.
const homeLayer = new FileLayer(loadHomeConfigRules, homeFilePath);

// projectLayer watches $CLAUDE_PROJECT_DIR/.claude/permissions.yaml and reloads on change.
const projectLayer = new FileLayer(loadProjectConfigRules, projectFilePath);

// registry evaluates all three layers in order: built-ins, home config, project config.
export const registry = new RuleRegistry([builtinLayer, homeLayer, projectLayer]);
