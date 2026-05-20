import { cdRule } from "./builtin/cd";
import { envPrefixRule } from "./builtin/env-prefix";
import { envSetRule } from "./builtin/env-set";
import { exportRule } from "./builtin/export";
import { xargsRule } from "./builtin/xargs";
import { IRule } from "../types";

// builtinRules holds the built-in semantic rules that handle Bash env/cwd semantics and xargs.
// These are evaluated before YAML rules so env state is correct when user rules run.
export const builtinRules: IRule[] = [cdRule, envPrefixRule, envSetRule, exportRule, xargsRule];
