import { cdRule } from "./builtin/cd";
import { envPrefixRule } from "./builtin/env-prefix";
import { envSetRule } from "./builtin/env-set";
import { exportRule } from "./builtin/export";
import { IRule } from "../types";

// builtinRules holds the four built-in semantic rules that handle Bash env/cwd semantics.
// These are evaluated before YAML rules so env state is correct when user rules run.
export const builtinRules: IRule[] = [cdRule, envPrefixRule, envSetRule, exportRule];
