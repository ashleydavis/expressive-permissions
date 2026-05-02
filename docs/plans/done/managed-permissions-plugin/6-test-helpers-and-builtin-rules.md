# Step 6: Test helpers and built-in rules

Create the shared test fixture builders and all four built-in semantic rules (those that update `env` but always abstain on the decision).

## Files to create

- `src/rules/test-helpers.ts` — exports `makeArgs`, `makeCommand`, `makeEnv`, `dummyCall` as documented in the plan. All parameters are required (no default values). Each exported function and constant requires a `//` comment above it.

- `src/rules/builtin/cd.ts` — `cdRule`: matches `cd <path>` `Command` nodes; returns an `env` updater that resolves the target path (absolute or relative); marks `cwdResolved: false` for `cd $VAR`, `cd -`, `cd` with no arg. Requires a `//` comment above the exported constant.

- `src/rules/builtin/env-prefix.ts` — `envPrefixRule`: matches `Command` nodes with a non-empty binary and at least one `envPrefix` entry; returns a `scopedEnv` updater that merges the prefix into the running env (transient — visible to subsequent rules at this leaf only). Requires a `//` comment above the exported constant.

- `src/rules/builtin/env-set.ts` — `envSetRule`: matches `Command` nodes with `binary === ""` and non-empty `envPrefix` (standalone `FOO=bar`); returns a persistent `env` updater. Requires a `//` comment above the exported constant.

- `src/rules/builtin/export.ts` — `exportRule`: matches `export FOO=bar ...` commands; parses `KEY=VALUE` tokens from `pos`; returns a persistent `env` updater. Requires a `//` comment above the exported constant.

- `src/test/rules/builtin/cd.test.ts` — covers: absolute path resolution, relative path against cwd, `cwdResolved: false` on `$VAR`, no-arg `cd`, `cd -`, abstain on non-`cd` binaries and non-`command` nodes.

- `src/test/rules/builtin/env-prefix.test.ts` — covers: single prefix installed into `scopedEnv`, multiple prefixes, empty binary (should abstain), no prefixes (should abstain), non-`command` node.

- `src/test/rules/builtin/env-set.test.ts` — covers: standalone `FOO=bar` sets env persistently, multiple assignments, non-empty binary (should abstain), non-`command` node.

- `src/test/rules/builtin/export.test.ts` — covers: `export FOO=bar` sets env, multiple exports, export with no `KEY=VALUE` tokens abstains, non-`export` binary abstains.

## Verification

Run `bun test` and confirm all built-in rule tests pass.

Run all tests and confirm they pass before marking this step complete.
