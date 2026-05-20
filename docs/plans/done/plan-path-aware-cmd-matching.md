# Path-aware `cmd:` matching for bash rules

## Overview

Today the `cmd:` and `cmd-in:` fields on bash rules do pure string globbing
against each positional argument. Patterns that look like paths (e.g.
`cmd: ./**`) are treated as opaque strings: the arg `.` does not match
`./**`, an absolute arg under the project does not match either, and there is
no awareness of `env.cwd` or the project directory. This breaks the common
idiom of "allow this command when it operates on paths inside the project"
(e.g. `find .` from a subdirectory of the project dir is denied even though
the cwd is under the project).

The change introduces path-aware semantics for `cmd:` / `cmd-in:` patterns
whose pattern looks like a path (starts with `./` or `/`). For those
patterns, the runtime resolves the positional arg against `env.cwd` to get
an absolute path, resolves `./` in the pattern against the project directory
(captured at load time, mirroring how `cwd:` patterns already work), and
performs a path-aware glob match that treats the base directory as matching
its `/**` form. String-glob behaviour is preserved for non-path patterns
(e.g. `cmd: foo-*`).

The failing e2e test
`e2e/bash/bash-cd-find-sort-project-subdir-allow/test.yaml` will pass once
this is implemented: after `cd <project>/foo/bar`, the arg `.` to `find`
resolves to `<project>/foo/bar`, which is under the resolved pattern
`<project>/**`.

## Issues

<!-- populated later by plan:check -->

## Steps

### 1. Add `isCmdPathPattern` helper in `src/load-config.ts`

Add an internal helper:

- `function isCmdPathPattern(pattern: string): boolean`

**Purpose**: classify a `cmd:` / `cmd-in:` pattern as path-aware vs.
string-glob, so the matcher can dispatch to the right semantics.

Returns true when `pattern` starts with `./` or `/` (i.e. the pattern is
intended to be interpreted as a path). All other patterns remain string
globs and use the existing `matchesPattern` path.

### 2. Add `resolveCmdPathPattern` helper in `src/load-config.ts`

Add an exported helper next to `resolveCwdPattern`:

- `function resolveCmdPathPattern(pattern: string, projectDir: string): string`

**Purpose**: rewrite a single `./`-prefixed `cmd:` pattern into its
absolute form anchored at the project directory, so later path-aware
matching can compare it directly to absolute arg paths.

Behaviour:
- If `pattern` starts with `./`, return `projectDir + "/" + pattern.slice(2)`.
- Otherwise (already absolute, or not a path pattern), return `pattern`
  unchanged.

### 3. Add `resolveEntryCmdPatterns` walker in `src/load-config.ts`

Mirror `resolveEntryCwdPatterns`:

- `export function resolveEntryCmdPatterns(entry: IYamlEntry, projectDir: string, options?: IEntryWalkOptions): void`

**Purpose**: in-place rewrite every `cmd:` / `cmd-in:` (and `not.cmd` /
`not.cmd-in`) pattern in one rule entry and its descendants so that all
path-style patterns are absolute by the time the rule starts matching.

Walks one `IYamlEntry` and:
- Rewrites `entry.cmd` (both string and string-array forms) by mapping each
  positional pattern through `resolveCmdPathPattern`. For the string form,
  split on whitespace, rewrite each token, rejoin with single spaces.
- Rewrites `entry["cmd-in"]` array entries through `resolveCmdPathPattern`.
- Rewrites `entry.not.cmd` and `entry.not["cmd-in"]` analogously.
- Recurses into `entry.rules` and (unless `isToolNameEntry`) the subcommand
  child branches, identical to how `resolveEntryCwdPatterns` recurses.

### 4. Add `resolveRelativeCmdPatterns` top-level walker in `src/load-config.ts`

Add an exported function:

- `export function resolveRelativeCmdPatterns(config: IYamlConfig, projectDir: string): void`

**Purpose**: the single entry point the config loader calls to apply
`resolveEntryCmdPatterns` across every section of a parsed YAML config —
ensuring all path-style `cmd:` patterns are resolved before rules are
compiled.

Mirrors `resolveRelativeCwdPatterns`: walks the `bash` section, the
file-tool sections (`read`, `write`, `edit`, `multi_edit`, `webfetch`), and
the unknown top-level tool-name sections, invoking
`resolveEntryCmdPatterns` for each entry with `isToolNameEntry` set
appropriately.

### 5. Wire `resolveRelativeCmdPatterns` into the config-load pipeline

In `src/load-config.ts`:

- In `loadConfigRulesFromFile`, after the existing
  `resolveRelativeCwdPatterns(config, baseDir)` call (line 1198), also call
  `resolveRelativeCmdPatterns(config, projectDir)` where `projectDir` is
  taken from `process.env["CLAUDE_PROJECT_DIR"]`. When
  `CLAUDE_PROJECT_DIR` is unset, skip the resolution (no path-pattern
  rewriting happens; patterns stay literal `./...` and will simply fail to
  match absolute args, which is acceptable for misconfigured environments).
- In `loadConfigRules` (the legacy two-file loader at line 1331), apply the
  same call after each existing `resolveRelativeCwdPatterns` invocation,
  using the same project dir lookup.

Note: the file's own `baseDir` is still used for `cwd:` resolution. Only
`cmd:` path patterns resolve against the project dir, regardless of which
file they came from (home, drop-in, or project).

### 6. Extend `matchesCmd` in `src/load-config.ts` to accept `env`

Change the signature:

- `function matchesCmd(entry: IYamlEntry, node: Command, cmdOffset: number, env: Environment): boolean`

**Purpose** (of the modified `matchesCmd`): decide whether each positional
arg in a Command node satisfies its corresponding `cmd:` / `cmd-in:`
pattern; the added `env` parameter gives it access to `env.cwd` so it can
resolve relative path args before path-aware matching.

Threading: update the three call sites of `matchesCmd` in the same file
(currently around lines 401, 480, 574) to pass `env`. The two call sites
inside `buildBashRule` / `buildBashScopedRule` already have `env` in scope.
The call site inside `notFieldsAllMatch` already receives `env` as a
parameter.

### 7. Implement path-aware matching inside `matchesCmd`

Within `matchesCmd`, for each pattern–arg pair:

- If `isCmdPathPattern(pattern)` is false, fall through to the existing
  `matchesPattern(pattern, arg)` behaviour (string-glob).
- If true, treat both pattern and arg as paths:
  - Resolve `arg` against `env.cwd` using `path.resolve` to produce an
    absolute path `resolvedArg`. (If `arg` is already absolute, `resolve`
    returns it unchanged.)
  - The pattern is already absolute at this point (rewritten at load time
    by `resolveCmdPathPattern`); use it as `resolvedPattern`.
  - Call a new helper `matchesPathGlob(resolvedPattern, resolvedArg)`
    (see step 8).

The `cmd-in` branch should apply the same logic per pattern (and still keep
the "some positional matches some pattern" OR semantics across the slice).

### 8. Add `matchesPathGlob` helper in `src/load-config.ts`

Add an internal helper:

- `function matchesPathGlob(pattern: string, value: string): boolean`

**Purpose**: glob-match a resolved absolute arg path against a resolved
absolute pattern path, with one tweak vs. `matchesGlob` — the base
directory of a `/**` pattern is treated as a match (so `<proj>/**` covers
`<proj>` itself).

Behaviour:
- Same as `matchesGlob` (picomatch with `dot: true`) but **without** the
  base-directory exclusion. The base-dir exclusion in the current
  `matchesGlob` (`pattern.slice(0, -3) === value` returns false) is
  appropriate for string-glob `cwd:` patterns but wrong here: `<proj>/**`
  should match `<proj>` itself (so `find .` from the project root is
  allowed). Implementation: if `pattern` ends with `/**` and
  `value === pattern.slice(0, -3)`, return true. Otherwise call picomatch
  as today.

### 9. Update `IEntryWalkOptions` doc comment (optional)

`IEntryWalkOptions` is now shared between `resolveEntryCwdPatterns` and
`resolveEntryCmdPatterns`. Update the doc comment in `src/load-config.ts`
to mention both walkers if needed; no semantic change.

### 10. Update `KNOWN_FIELDS` if necessary

No new field names are introduced. `KNOWN_FIELDS` does not need updating.

## Unit Tests

Add to `src/test/load-config.test.ts` (or a new file at the same level):

- `isCmdPathPattern`:
  - returns true for `./`, `./**`, `./foo`, `/foo`, `/`
  - returns false for `foo`, `foo-*`, `*.yaml`, ``
- `resolveCmdPathPattern`:
  - `./**` with projectDir `/proj` → `/proj/**`
  - `./foo/bar` with projectDir `/proj` → `/proj/foo/bar`
  - `/etc/hosts` passthrough
  - `foo-*` passthrough
- `resolveEntryCmdPatterns`:
  - rewrites `cmd` string form
  - rewrites `cmd` array form
  - rewrites `cmd-in` array
  - rewrites `not.cmd` and `not.cmd-in`
  - recurses into `rules` sub-entries
  - recurses into subcommand children (unless `isToolNameEntry`)
- `resolveRelativeCmdPatterns`:
  - walks the `bash`, `read`, `write`, `edit`, `multi_edit`, `webfetch`
    sections and tool-name sections, rewriting all reachable cmd patterns
- `matchesPathGlob`:
  - `<proj>/**` matches `<proj>` itself (base-dir included)
  - `<proj>/**` matches `<proj>/foo`
  - `<proj>/**` does **not** match `/other/path`
- `matchesCmd` path-aware (via the existing path-aware test fixtures or new
  ones in `src/test`):
  - rule pattern resolves to `<proj>/**`; arg `.` with `env.cwd =
    <proj>/foo` → match
  - same rule; arg `.` with `env.cwd = /tmp` → no match
  - rule pattern resolves to `<proj>/**`; arg `<proj>/sub/file` with any
    cwd → match
  - rule pattern resolves to `<proj>/**`; arg `/etc/passwd` → no match
  - string-glob pattern `foo-*` with arg `foo-1` still matches (no
    regression)

## Smoke Tests

- The new e2e fixture
  `e2e/bash/bash-cd-find-sort-project-subdir-allow/test.yaml` must pass
  (decision `allow`).
- All existing e2e tests must continue to pass; in particular check
  `e2e/bash/bash-find-xargs-head-pipe-allow/test.yaml` (the absolute-path
  find test), `e2e/bash/bash-cwd-glob/test.yaml` (cwd pattern matching),
  and `e2e/bash/bash-cmd-in/test.yaml` (cmd-in semantics).
- Optionally add another e2e fixture
  `e2e/bash/bash-cd-find-outside-project-ask/test.yaml` that runs
  `cd /etc && find . -type f` with the same rules and asserts `ask`, to
  guard against regressions where path-aware matching becomes too
  permissive.

## Verify

- `bun run compile` — TypeScript compiles cleanly.
- `bun run test` — all unit tests pass.
- `bun run smoke` — all e2e tests pass, including the new fixtures.
- `bun run test:all` — combined pass.
- Direct run: `bun run scripts/run-e2e-test.ts
  e2e/bash/bash-cd-find-sort-project-subdir-allow/test.yaml` exits 0 and
  prints `PASS`.

## Human Verification

1. In a clean terminal under `~/claude-permissions`, run
   `bun run scripts/run-e2e-test.ts
   e2e/bash/bash-cd-find-sort-project-subdir-allow/test.yaml`. Confirm
   `PASS`.
2. From any directory where the user's actual home permissions.d rules are
   in scope, start the REPL:
   `bun run repl` and type
   `cd /home/ash/tickets/prod-cfg-7643/old/argoprod/configs/applications/prod && find . -name '*.yaml' -type f | sort`
   Confirm the trace shows `find . -name '*.yaml' -type f` matching the
   home `find` rule (RULE line, not NOMATCH) and the overall RESULT is
   `ALLOW`.
3. From the same REPL try `cd /etc && find . -type f` (or similar path
   outside the project) and confirm the result is **not** `ALLOW`
   (`ask` or `deny`). This guards against accidental over-permissiveness.

## Notes

- **Project dir source**: `process.env["CLAUDE_PROJECT_DIR"]` is the
  authoritative source at load time. The cd builtin updates `env.cwd`
  during interpretation, but the project dir is a fixed compile-time
  anchor for path patterns.
- **Why rewrite at load time, not match time**: keeps the hot path
  identical for non-path patterns and avoids repeating the same string
  manipulation on every command. Mirrors the existing pattern used by
  `resolveRelativeCwdPatterns`.
- **Base-dir inclusion is intentional**: for `cwd:` patterns the strict
  exclusion (`./**` does not match `.` itself) was useful because
  `cwd:` was about strict membership. For path-aware `cmd:` we want
  `find .` from the project root to be allowed, which requires matching
  the base dir.
- **No new YAML field is introduced**: existing rules that use `cmd:
  ./**` start behaving correctly with no edit required. Rules that use
  literal absolute paths in `cmd:` (e.g. `cmd: /etc/**`) also start
  doing path-aware matching, which matches user intuition.
- **Backward compatibility**: any existing rule whose `cmd:` pattern
  starts with `./` or `/` will switch from string-glob to path-aware.
  This is the desired behaviour and unlikely to regress anything, since
  the only way a string-glob `./X` pattern could match today is if the
  raw arg string also started with `./` — that case is preserved
  (after `path.resolve`, `./X` becomes `<env.cwd>/X`, which will match
  the rewritten pattern when `env.cwd` is under the project).
- **`CLAUDE_PROJECT_DIR` unset**: skip cmd-pattern resolution. Patterns
  stay literal `./...`; the path-aware branch will still execute because
  `isCmdPathPattern` returns true, and `path.resolve` of the arg will be
  absolute, but the unresolved pattern won't match any absolute path,
  yielding `false`. Net effect: rules using `./` patterns simply don't
  match when project dir is unset. Acceptable for a misconfigured env.
