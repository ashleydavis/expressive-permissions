# Explicit `${{PROJECT_DIR}}` / `${{HOME}}` syntax in permissions YAML

Syntax follows GitHub Actions workflow expressions: double-brace
`${{ NAME }}` for engine-evaluated tokens. This deliberately does **not**
collide with the e2e test runner's single-brace `${PROJECT_DIR}`
substitution (see `scripts/run-e2e-test.ts:169`), which fills in the
tmp project path inside `input:` before the hook is invoked. The two
mechanisms run at different layers; keeping the syntaxes distinct
prevents either layer from accidentally consuming the other's token.

## Overview

Today the only way to write a path-aware matcher relative to the project
root is the implicit `./` prefix (e.g. `cmd: ./**`, `cwd: ./src/**`,
`path: ./**`). That is concise but ambiguous: shell users read `./` as
"the runtime cwd", not "the project root captured at load time". The
inconsistency between `cwd:` (anchored at the YAML file's directory) and
`cmd:` (anchored at the project dir) compounds the confusion.

The change introduces an explicit substitution syntax that resolves
before any other path-pattern processing:

- `${{PROJECT_DIR}}` → absolute path of `process.env["CLAUDE_PROJECT_DIR"]`
- `${{HOME}}` → absolute path of `process.env["HOME"]`

`./` continues to work exactly as today (back-compat). Users are
encouraged to migrate to the explicit form via doc updates and a
migration of `~/tools/config/home/.claude/permissions{.yaml,.d/*.yaml}`.

## Issues

<!-- populated later by plan:check -->

## Design

### Where substitution runs

Substitution happens in `src/load-config.ts`, in a new pre-pass called
**before** `resolveRelativeCwdPatterns` / `resolveRelativeCmdPatterns` in
both `loadConfigRulesFromFile` and `loadConfigRules`. This ordering means
existing `./` resolution still runs on its untouched inputs, and an
already-substituted absolute path is a no-op for the later passes.

### What gets substituted

Substitution is applied to **string-valued matcher fields only** so that
arbitrary YAML strings (e.g. a `reason:` message) are not accidentally
mangled. The fields are exactly those the existing walkers already touch:

- `cmd` (string + array forms), `cmd-in` (array)
- `cwd` (string), `cwd-in` (array)
- `path` (string), `path-in` (array)
- `file` (keys of the map)
- `env` (values of the map)
- All of the above inside `not:` blocks
- All of the above recursed into `rules:` sub-entries and bash
  subcommand children (mirroring `resolveEntryCwdPatterns`)

Fields explicitly skipped: `host`/`host-in` (hostnames don't have
paths), `tool`/`tool-in`, `reason`, `decide`, `options`/`options-in`
(option-flag patterns are not paths).

### Substitution semantics

- Token form: literal `${{PROJECT_DIR}}` and `${{HOME}}` (no other tokens,
  no `$VAR` shorthand, no nested expansion).
- Replacement uses `String.prototype.split(token).join(value)` so all
  occurrences are replaced.
- If the env var is **unset** and the token appears, leave the literal
  token in place (it will simply fail to match any real path) and emit
  one `[CONFIG WARN] unresolved ${{NAME}}` line to stderr per file.
  This is consistent with how `loadConfigRules` already handles a
  missing `CLAUDE_PROJECT_DIR` (skip the project-dir-anchored work,
  never crash).
- Regex patterns of the form `/.../` are passed through unchanged so a
  user-written regex containing `${{...}}` is not rewritten.

### Backward compatibility

- Every existing `./` path is unchanged: the new pre-pass does not see
  any `${{...}}` tokens to substitute, so the old walkers run on the
  same input as today.
- All existing unit + smoke tests must continue to pass without edits.

## Steps

### 1. Add `expandEnvTokens` helper in `src/load-config.ts`

Add an internal helper:

- `function expandEnvTokens(value: string, projectDir: string | undefined, homeDir: string | undefined, displayFile: string, warnings: Set<string>): string`

**Purpose**: replace `${{PROJECT_DIR}}` and `${{HOME}}` tokens in a single
string value, leaving regex `/.../` patterns and any other content
untouched.

Behaviour:

- If `value` is a regex pattern (`/.+/`), return unchanged.
- For each token, if present in `value` and the corresponding env var is
  defined, replace all occurrences with the env value.
- If a token is present but the env var is `undefined`, leave it
  literal and add a key like `"${{PROJECT_DIR}}@${displayFile}"` to the
  `warnings` set so the caller can emit one stderr line per file.
- Return the rewritten string.

### 2. Add `expandEntryEnvTokens` walker in `src/load-config.ts`

Mirror `resolveEntryCmdPatterns`:

- `export function expandEntryEnvTokens(entry: IYamlEntry, projectDir: string | undefined, homeDir: string | undefined, displayFile: string, warnings: Set<string>, options?: IEntryWalkOptions): void`

**Purpose**: walks one rule entry and rewrites every string-valued
matcher field (and the matcher fields inside `not:`, `rules:` and
subcommand children) through `expandEnvTokens`.

Field coverage:

- `cmd` (string and array elements), `cmd-in` (array elements)
- `cwd` (string), `cwd-in` (array elements)
- `path` (string), `path-in` (array elements)
- `env` (each map value)
- `file` (each map key — rebuild the map with rewritten keys)
- All the above inside `entry.not`
- Recurse into `entry.rules`
- Unless `isToolNameEntry`, recurse into subcommand children

### 3. Add `expandConfigEnvTokens` top-level walker in `src/load-config.ts`

Add an exported function:

- `export function expandConfigEnvTokens(config: IYamlConfig, projectDir: string | undefined, homeDir: string | undefined, displayFile: string): void`

**Purpose**: single entry point invoked from the loader. Walks every
section (`bash`, `read`, `write`, `edit`, `multi_edit`, `webfetch`, and
top-level tool-name keys) via `expandEntryEnvTokens`, collects warnings
into a local `Set<string>`, then emits one
`[CONFIG WARN] (displayFile) unresolved ${{PROJECT_DIR}}` (or `${{HOME}}`)
line to stderr per token+file combination.

### 4. Wire `expandConfigEnvTokens` into the loader

In `src/load-config.ts`:

- In `loadConfigRulesFromFile`, call
  `expandConfigEnvTokens(config, process.env["CLAUDE_PROJECT_DIR"], process.env["HOME"], displayFile)`
  **before** the existing `resolveRelativeCwdPatterns` call (i.e. as
  the first transformation after `readYamlFile`).
- In `loadConfigRules` (legacy two-file loader), apply the same call to
  both `homeYaml` and `projectYaml` after they're read and before any
  resolution.

The pre-pass is unconditional: if both env vars are unset, the function
is still safe (it just emits warnings for any tokens that happen to be
present and otherwise no-ops).

### 5. (Optional, defensive) Update `homePath` documentation

`homePath` already handles `~` and bare relative paths. It does **not**
need to change: by the time it's called on a `file:` key, the key has
already been expanded by step 4. Add a one-line comment noting the
expansion-first invariant.

### 6. No new YAML fields

`KNOWN_FIELDS` does not change. `${{PROJECT_DIR}}` / `${{HOME}}` are content
tokens, not field names.

## Unit Tests

Add to `src/test/load-config.test.ts`:

**`expandEnvTokens`** (direct):

- `"${{PROJECT_DIR}}/foo"` with projectDir `/proj` → `/proj/foo`.
- `"${{HOME}}/.config"` with homeDir `/home/ash` → `/home/ash/.config`.
- `"${{PROJECT_DIR}}/${{HOME}}"` (both tokens) substitutes both.
- `"foo-*"` (no tokens) returned unchanged.
- `"/^ftp:/"` (regex form) returned unchanged even if it contains
  `${{...}}`.
- `"${{PROJECT_DIR}}/x"` with projectDir `undefined` → unchanged and a
  warning recorded.

**`expandEntryEnvTokens`** (one entry):

- Each of `cmd` (string), `cmd` (array), `cmd-in`, `cwd`, `cwd-in`,
  `path`, `path-in`, `env` (map value), `file` (map key) is rewritten
  when it contains a token.
- `not.cmd`, `not.cmd-in`, `not.cwd`, `not.cwd-in`, `not.path`,
  `not.path-in` all rewrite.
- `rules:` sub-entries are recursed.
- Subcommand children are recursed when `isToolNameEntry` is false; not
  recursed when `isToolNameEntry` is true.
- `host`, `tool`, `reason`, `decide`, `options` are **not** rewritten.

**`expandConfigEnvTokens`** (one config):

- Walks `bash`, `read`, `write`, `edit`, `multi_edit`, `webfetch`, and
  top-level tool-name keys, rewriting all reachable matcher fields.
- Empty config is a no-op.
- Emits one `[CONFIG WARN] (file) unresolved ${{PROJECT_DIR}}` line per
  unique token+file pair when env vars are unset (capture stderr).

**Backward-compat regressions**:

- A config with only `./**` patterns produces identical compiled rules
  before and after the new pre-pass runs.

**Cross-feature integration** (via `loadConfigRulesFromFile`):

- `cmd: ${{PROJECT_DIR}}/**` resolves to `<proj>/**` at load time and
  behaves identically to `cmd: ./**` under path-aware matching.
- `cwd: ${{HOME}}/**` resolves to `<home>/**` and matches an env.cwd
  under home.
- `path: ${{PROJECT_DIR}}/secrets/*` on a read rule matches a file path
  under the project.
- Mixed example: `cmd-in: ["${{PROJECT_DIR}}/src/**", "./test/**"]`
  produces both expected resolved patterns.

## Smoke Tests

Add new e2e fixtures under `e2e/bash/`:

1. `bash-explicit-projectdir-find-allow/test.yaml`
   `find ${{PROJECT_DIR}}/foo` with rule `cmd: ${{PROJECT_DIR}}/**`,
   expect `allow`.
2. `bash-explicit-projectdir-cwd-allow/test.yaml`
   `npm install` with rule `cwd: ${{PROJECT_DIR}}/**`, expect `allow`.
3. `bash-explicit-home-cwd-allow/test.yaml`
   command with `cwd: ${{HOME}}/projects/**`, expect `allow`.
4. `bash-explicit-projectdir-outside-deny/test.yaml`
   `find /etc` with rule `cmd: ${{PROJECT_DIR}}/**`, expect non-allow
   (`ask` or `deny`) — guards against over-permissive substitution.

No change to `scripts/run-e2e-test.ts` is required. The runner's
existing single-brace `${PROJECT_DIR}` substitution only matches
`${PROJECT_DIR}` and ignores `${{PROJECT_DIR}}`, so a double-brace
token written in `rules:` or `home_dir_files:` passes through
untouched and is resolved later by the engine pre-pass. Fixtures may
freely mix both forms: single-brace inside `input:` (test-runner
fill-in of the tmp project path) and double-brace inside `rules:`
(engine evaluation at load time).

All existing smoke tests must continue to pass with no edits, since
the `./` path remains intact.

## Docs Updates

The following documents currently teach the `./` syntax and need to
recommend `${{PROJECT_DIR}}` first, with `./` listed as a back-compat
shorthand:

- `docs/CONFIGURATION.md` — the section starting at line 690
  ("Anchoring rules to the project directory") becomes the
  `${{PROJECT_DIR}}` story. Replace all 4 `cwd: ./**` examples in that
  section. Line 111 (the hidden-segment note) is unchanged.
- `docs/PERMISSIONS-QUICKREF.md` — line 85's table row changes to
  `` `cwd: ${{PROJECT_DIR}}/**` `` with a one-line note that `./**` is
  the legacy shorthand.
- `docs/HOW_IT_WORKS.md` — any `./` example in the path-resolution
  section is rewritten; `${{PROJECT_DIR}}` is introduced as the primary
  way to anchor.
- `README.md` — if any introductory example uses `./`, replace with
  the explicit form.

Each updated section keeps one paragraph at the bottom listing the
legacy shorthand so users searching for `./` still find the
explanation.

## Tools-repo Migration

Update the user's tools repo permissions to prefer the explicit
syntax. Files to edit (all under `~/tools/config/home/.claude/`):

- `permissions.d/bash-readonly.yaml` (4 `cmd: ./**` occurrences)
- `permissions.d/bash-bun-write.yaml` (1 `cmd: ./**`)
- `permissions.d/file-tools-readonly.yaml` (1 `path: ./**`)
- `permissions.d/file-tools-write.yaml` (2 `path: ./**`)

Each `./**` becomes `${{PROJECT_DIR}}/**`. No other behaviour change.
Confirm in the REPL afterwards that the rules still match the same
sample commands they did before.

## Verify

- `bun run compile` — TypeScript compiles cleanly.
- `bun run test` — all unit tests pass (existing + new).
- `bun run smoke` — all e2e tests pass (existing + new).
- `bun run test:all` — combined pass.
- Direct run: each new e2e fixture passes when run individually via
  `bun run scripts/run-e2e-test.ts e2e/bash/<fixture-dir>/test.yaml`.

## Human Verification

1. In a clean terminal under `~/claude-permissions`, run each new e2e
   fixture by hand and confirm `PASS`.
2. In `~/tools/config/home/.claude/permissions.d/bash-readonly.yaml`,
   confirm every `cmd: ./**` has been replaced with
   `cmd: ${{PROJECT_DIR}}/**`. Repeat for the other migrated files.
3. From the same shell that uses your real home permissions, start the
   REPL: `bun run repl`. With cwd set to a project, type
   `find . -name '*.yaml' | sort` and confirm it still ALLOWs through
   the migrated rule.
4. With cwd outside any project (e.g. `cd /etc`), confirm `find . -type f`
   does **not** ALLOW (i.e. still `ask`/`deny`).
5. Edit one of the migrated files to introduce a typo like
   `${{PROJECT_DI}}` (missing R). Reload (run any tool call) and
   confirm the `[CONFIG WARN] (~/...) unresolved ${{PROJECT_DI}}` line
   appears on stderr. Revert the typo.

## Notes

- **Why a pre-pass, not in-line in each walker**: keeps the new feature
  orthogonal. Adding tokens to a single resolver step (e.g. only `cmd`)
  would force users to remember which fields support `${{PROJECT_DIR}}`.
  Doing it once up-front means every matcher field gets the same UX.
- **Why only `${{PROJECT_DIR}}` and `${{HOME}}`**: those are the two
  anchors users actually reason about. Adding `${{FILE_DIR}}` would
  reproduce the existing `cwd: ./` anchoring confusion. If a user
  genuinely needs a per-file relative anchor they can still write `./`.
- **Why not `${{CWD}}` (the runtime cwd)**: explicitly considered and
  deferred. It would have to substitute at match time because `env.cwd`
  changes per tool call, which is a different code path from the
  load-time `${{PROJECT_DIR}}` / `${{HOME}}` pre-pass and roughly
  doubles the implementation surface. For `cwd:` it is tautological
  (`cwd: ${{CWD}}/**` matches whenever cwd is under cwd, i.e. always);
  for `cmd:` the existing path-aware resolver already resolves
  positional args against `env.cwd` before matching, which covers the
  common case. Can be added later if a real use case appears.
- **Why leave `./` alive**: backward compatibility is required by the
  user, and the existing semantics have one subtle but useful
  property — for `cwd:` the anchor is the YAML file's own directory,
  so a drop-in in `~/foo/.claude/permissions.d/x.yaml` with `cwd: ./`
  matches `~/foo` regardless of which project happens to be loaded.
  That niche behaviour stays available.
- **Warning vs error on unresolved tokens**: erroring would break
  loading in environments where `CLAUDE_PROJECT_DIR` is intentionally
  unset (e.g. running the engine in a CI step). A warning preserves
  the engine's "degrade gracefully" stance.
