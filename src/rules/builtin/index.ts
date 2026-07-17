import { CdRule } from "./cd-rule";
import { EmptyCommandRule } from "./empty-command-rule";
import { ExportRule } from "./export-rule";
import { IRule } from "../rule";

// builtinRules holds built-in semantic rules for bash env and cwd semantics.
export const builtinRules: IRule[] = [
    new CdRule(),
    new EmptyCommandRule(),
    new ExportRule(),
];
