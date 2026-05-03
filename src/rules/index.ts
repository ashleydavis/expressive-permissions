import { Rule } from "../types";
import { cdRule } from "./builtin/cd";
import { envPrefixRule } from "./builtin/env-prefix";
import { envSetRule } from "./builtin/env-set";
import { exportRule } from "./builtin/export";
import { loadConfigRules } from "../load-config";

// Rule registry in evaluation order: built-ins first, then YAML-compiled rules.
// Built-ins handle Bash semantics (cd, env-var assignments, exports) and must run before
// user-defined rules so that env state is correct when user rules are evaluated.
export const rules: Rule[] = [
    cdRule,
    envPrefixRule,
    envSetRule,
    exportRule,
    ...loadConfigRules(),
];
