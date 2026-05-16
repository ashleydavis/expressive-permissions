# Layered Permission Files (permissions.d/)

## Overview

Allow users to split their permission rules across multiple YAML files inside a
`permissions.d/` drop-in directory next to the existing `permissions.yaml`.
Each file in the directory is compiled into its own `FileLayer` and registered
in the rule registry. This lets users share or reuse tool-specific files
(e.g. `aws.yaml`, `bun.yaml`, `git.yaml`) by copying a single file into the
directory rather than hand-merging a monolithic config.

Discovered locations:

- `~/.claude/permissions.d/*.yaml` (home)
- `$CLAUDE_PROJECT_DIR/.claude/permissions.d/*.yaml` (project)

Each discovered file becomes its own layer (strictest-wins inside the file,
deny short-circuits across layers), mirroring how the two existing
`permissions.yaml` files are layered today.

## Issues

<!-- populated later by plan:check -->

## Steps

### 1. Add directory-scan helper in `src/load-config.ts`

Add a new exported interface `IConfigFileSource`:

- `filePath: string` (absolute path on disk)
- `displayPath: string` (path used for log output, e.g. `~/.claude/permissions.d/aws.yaml`)
- `baseDir: string` (base directory used to resolve `./` cwd patterns inside the file)

Add a new exported function:

```ts
export function discoverConfigDirFiles(dirPath: string, displayPrefix: string, baseDir: string): IConfigFileSource[]
```

Behaviour:

- If `dirPath` does not exist or is not a directory, return `[]`.
- Use `fs/promises`-style sync replacements that are already used in this file
  (`existsSync` plus `readdirSync` from `fs`) to enumerate entries. The
  project rule `NEVER USE SYNC VERSIONS` applies to new code; however
  `load-config.ts` currently calls `readFileSync`/`existsSync` everywhere and
  loaders run synchronously at construction time. Mirror the existing style
  (sync) rather than refactoring the file. Note this trade-off in the Notes
  section.
- Filter to files whose names end with `.yaml` or `.yml`, ignore directories
  and dotfiles, and sort the resulting names lexicographically (ASCII order).
- For each surviving name, produce an `IConfigFileSource` with:
  - `filePath = join(dirPath, name)`
  - `displayPath = displayPrefix + "/" + name`
  - `baseDir = baseDir`

### 2. Add home/project directory loaders in `src/load-config.ts`

Add two new exported functions:

```ts
export function discoverHomeConfigDirFiles(): IConfigFileSource[]
export function discoverProjectConfigDirFiles(): IConfigFileSource[]
```

- `discoverHomeConfigDirFiles` reads `process.env["HOME"]`. If unset, returns
  `[]`. Otherwise calls `discoverConfigDirFiles(join(home, ".claude", "permissions.d"), "~/.claude/permissions.d", home)`.
- `discoverProjectConfigDirFiles` reads `process.env["CLAUDE_PROJECT_DIR"]`. If
  unset, returns `[]`. Otherwise calls `discoverConfigDirFiles(join(projectDir, ".claude", "permissions.d"), ".claude/permissions.d", projectDir)`.

### 3. Add a per-source loader in `src/load-config.ts`

Add an exported helper that builds a no-arg loader closure suitable for
`FileLayer`:

```ts
export function makeConfigFileLoader(source: IConfigFileSource): () => Rule[]
```

Implementation: returns `() => loadConfigRulesFromFile(source.filePath, source.displayPath, source.baseDir)`.
This keeps `FileLayer`'s constructor signature unchanged.

### 4. Wire the new layers into `src/pre-hook.ts`

In `runHook()`, after the existing home/project `FileLayer` entries are
constructed, append one `FileLayer` per source returned by
`discoverHomeConfigDirFiles()` (immediately after the home main file) and
one per source returned by `discoverProjectConfigDirFiles()` (immediately
after the project main file).

Final layer order in the registry:

1. `RuleLayer(builtinRules)`
2. `FileLayer(loadHomeConfigRules, "~/.claude/permissions.yaml", logger)`
3. One `FileLayer` per home `permissions.d/*.yaml` (alphabetical)
4. `FileLayer(loadProjectConfigRules, ".claude/permissions.yaml", logger)`
5. One `FileLayer` per project `permissions.d/*.yaml` (alphabetical)

Use `makeConfigFileLoader(source)` as the loader function and `source.displayPath`
as the display path.

### 5. Wire the new layers into `src/analyze.ts`

In `buildAnalysisRegistry(projectDir, logger)`, mirror the change from step 4:
after each main config layer, append one `FileLayer` per discovered file in
the corresponding `permissions.d/` directory. Discovery must happen while
`CLAUDE_PROJECT_DIR` is set to `projectDir` (the function already temporarily
overrides this env var), so call `discoverProjectConfigDirFiles()` inside that
override block.

### 6. Update `src/test/load-config.test.ts` helper

Extend `withYamlFixtures` (or add a sibling helper `withYamlDirFixtures`) so
tests can write extra files under `<home>/.claude/permissions.d/` and
`<project>/.claude/permissions.d/`. Add an optional parameter such as:

```ts
withYamlFixtures(
    homeYaml: string | null,
    projectYaml: string | null,
    callback: (rules: Rule[]) => void,
    extras?: {
        homeDirFiles?: Record<string, string>;
        projectDirFiles?: Record<string, string>;
    }
): void
```

Write each entry of `homeDirFiles` to `<home>/.claude/permissions.d/<name>`
and each entry of `projectDirFiles` to `<project>/.claude/permissions.d/<name>`
before calling `loadConfigRules()`. Existing call sites continue to work
because the new parameter is optional.

(The existing CLAUDE.md rule forbids adding optional parameters in production
code "unless specifically asked to". This helper is test code and the user
asked for the layered-file feature; treat the extras parameter as in-scope.)

### 7. Update `src/test/load-config.test.ts` with new tests

Add new tests covering:

- `discoverConfigDirFiles`: returns `[]` when directory absent.
- `discoverConfigDirFiles`: filters non-yaml files, ignores dotfiles and
  subdirectories.
- `discoverConfigDirFiles`: returns results sorted alphabetically.
- `discoverConfigDirFiles`: `displayPath` is `<prefix>/<name>` for each file.
- `discoverHomeConfigDirFiles` / `discoverProjectConfigDirFiles`: return `[]`
  when the respective env var is unset.
- `makeConfigFileLoader`: returns a closure that yields the rules from the
  pointed-to file.
- Integration via `withYamlFixtures`: a `git.yaml` drop-in inside
  `project/.claude/permissions.d/` is compiled and contributes rules to the
  set returned by `loadConfigRules()` -- BUT note: `loadConfigRules()` itself
  only compiles the two main files. The drop-in directory is consumed by
  `pre-hook.ts` / `analyze.ts` via `discoverProjectConfigDirFiles()`, not by
  `loadConfigRules()`. So this integration test should call the helpers
  directly: enumerate sources, build loaders, run them, and check the
  resulting rule list. Do NOT change `loadConfigRules()` semantics.

### 8. Update `pre-hook` and `analyze` unit tests

`src/test/pre-hook.test.ts` and `src/test/analyze.test.ts` (if it exists)
should gain at least one test that:

- Writes a project drop-in `permissions.d/aws.yaml` that denies a command.
- Verifies the final decision is `deny` and the audit log records a
  `config_load` entry for `.claude/permissions.d/aws.yaml`.

If `src/test/analyze.test.ts` does not exist, skip the analyze-side unit test
and rely on the smoke coverage from step 9.

### 9. Add smoke test for layered files

Per the project rule "smoke tests are always shell + YAML", add a new e2e
case under `e2e/bash/`. Two parts:

(a) Extend `scripts/run-e2e-test.ts` to support new optional fields in the
test YAML schema:

- `home_dir_files?: Record<string, Record<string, unknown>>` -- map of file
  name to YAML object, written under `<homeDir>/.claude/permissions.d/`.
- `project_dir_files?: Record<string, Record<string, unknown>>` -- map of file
  name to YAML object, written under `<projectDir>/.claude/permissions.d/`.

After `writeFileSync(join(claudeDir, "permissions.yaml"), ...)` and the
existing `home_rules` block, the runner must `mkdirSync` the
`permissions.d` directory (recursive) and write each map entry there using
`stringify(value)`.

(b) Create a new test case directory, e.g.
`e2e/bash/bash-layered-permissions-d-deny`, with a `test.yaml` that:

- Has an empty/minimal `rules:` (project main yaml) -- e.g. a single allow
  rule for some unrelated binary.
- Uses `project_dir_files:` to define `git.yaml` containing
  `bash: { git: { decide: deny, reason: "no git" } }`.
- Has `input.tool_input.command = "git status"`.
- Expects `decision: deny` and `reason: "no git"`.

Add a second case `bash-layered-permissions-d-merge-allow` exercising a home
drop-in (`home_dir_files`) that allows a binary that the project main yaml
does not mention.

### 10. Update documentation

In `docs/CONFIGURATION.md`:

- Add a new section "Layered files (`permissions.d/`)" immediately after the
  opening paragraph that introduces `permissions.yaml`. Describe:
  - Discovery rule (alphabetical order, `.yaml` and `.yml` only, dotfiles
    skipped).
  - Per-file isolation: each drop-in file is its own layer, deny
    short-circuits across files exactly like home vs. project.
  - Location: both `~/.claude/permissions.d/` and
    `$CLAUDE_PROJECT_DIR/.claude/permissions.d/`.
  - Within each location, drop-in files run **after** the main
    `permissions.yaml` (project main is still authoritative over a home
    drop-in because home layers run first).
- Add the new section's title to the table-of-contents at the top of the
  file.

In `README.md`: add a one-sentence pointer to the new section if the README
currently lists configuration locations.

### 11. Compile and verify

Run `bun run compile` and `bun run test:all` and resolve any failures before
considering the plan complete.

## Unit Tests

- `discoverConfigDirFiles` returns `[]` when target directory is absent.
- `discoverConfigDirFiles` filters out non-yaml files (e.g. `notes.txt`,
  `README.md`).
- `discoverConfigDirFiles` ignores directories and entries beginning with `.`.
- `discoverConfigDirFiles` orders results alphabetically (`aws.yaml`,
  `bun.yaml`, `git.yaml`).
- `discoverConfigDirFiles` populates `displayPath` correctly for each file.
- `discoverHomeConfigDirFiles` returns `[]` when `HOME` is unset.
- `discoverProjectConfigDirFiles` returns `[]` when `CLAUDE_PROJECT_DIR` is
  unset.
- `makeConfigFileLoader` returns a closure that compiles the rules from the
  pointed-to file.
- Integration: writing `permissions.d/git.yaml` under the project tree causes
  `discoverProjectConfigDirFiles` to return one source whose loader compiles
  the file's rules.
- `pre-hook.test.ts` (existing test file): one test that a project
  `permissions.d/aws.yaml` deny rule is honoured end-to-end.

## Smoke Tests

- `e2e/bash/bash-layered-permissions-d-deny/test.yaml`:
  - Project `permissions.d/git.yaml` denies `git`.
  - Input: `git status`.
  - Expected: `decision: deny`.

- `e2e/bash/bash-layered-permissions-d-merge-allow/test.yaml`:
  - Home `permissions.d/ls.yaml` allows `ls`.
  - Project `permissions.yaml` has no rule for `ls`.
  - Input: `ls -la`.
  - Expected: `decision: allow`.

- `e2e/bash/bash-layered-permissions-d-ordering/test.yaml`:
  - Project `permissions.d/a-allow.yaml` allows `git`.
  - Project `permissions.d/b-deny.yaml` denies `git`.
  - Input: `git status`.
  - Expected: `decision: deny` (strictest wins across files; deny in
    `b-deny.yaml` should always beat allow in `a-allow.yaml` regardless of
    discovery order).

## Verify

1. `bun run compile` exits 0.
2. `bun run test` exits 0 (all unit tests pass).
3. `bun run smoke` exits 0 (all smoke tests, including the three new ones,
   pass).
4. `bun run test:all` exits 0.
5. Grep confirmation: `grep -rn "permissions.d" src/` shows at least one
   reference in `load-config.ts`, `pre-hook.ts`, and `analyze.ts`.

## Human Verification

1. In a scratch project, create
   `~/.claude/permissions.d/git.yaml` containing:

   ```yaml
   bash:
     git:
       decide: deny
       reason: "global git block"
   ```

2. Start Claude Code in any project and ask it to run `git status`. The
   permission prompt should be `deny` with the reason "global git block".

3. Inside the same project, create
   `.claude/permissions.d/git.yaml` containing:

   ```yaml
   bash:
     git:
       status:
         decide: allow
   ```

4. Re-run Claude Code. `git status` should now be `allowed` because the
   project layer runs after the home layer and is strictest-wins per node
   (allow beats abstain; deny still wins overall -- so verify by checking
   the audit log shows both `config_load` entries and the project drop-in's
   allow firing).

5. Inspect the latest audit log under `~/.claude/audit-logs/` and confirm
   it contains `config_load` entries for both
   `~/.claude/permissions.d/git.yaml` and
   `.claude/permissions.d/git.yaml`, each on its own line.

## Notes

- **Sync vs. async file I/O.** `src/load-config.ts` is entirely synchronous
  today (`readFileSync`, `existsSync`) and runs at hook startup. Step 1 uses
  `readdirSync` to match this style. Migrating the whole file to
  `fs/promises` is a separate cleanup not in scope here.

- **Why each file becomes its own layer.** Mirrors how
  `~/.claude/permissions.yaml` and `$CLAUDE_PROJECT_DIR/.claude/permissions.yaml`
  layer today: deny short-circuits across files; within a file strictest-wins
  applies. This means a `permissions.d/aws.yaml` deny rule is always honoured
  even if a sibling `bun.yaml` allows the same node, which is the intuitive
  outcome users expect when dropping a "block destructive AWS ops" file into
  the directory.

- **Ordering rationale.** Lexicographic ordering is stable and avoids any
  hidden filesystem-order dependency. We do not honour any ordering hint
  inside the YAML files themselves; users wanting strict precedence should
  rely on the deny short-circuit semantics (deny in any file wins) rather
  than file ordering.

- **`loadConfigRules()` unchanged.** The existing function compiles only the
  two main YAML files and is still used in REPL/test paths. Drop-in
  discovery happens at the `pre-hook` / `analyze` registry-construction
  layer where each file already maps to its own `FileLayer`.

- **No top-level `imports:` field.** The "explicit imports" alternative was
  rejected during planning in favour of pure auto-discovery. If a user wants
  to share a curated set of files, they can copy them into
  `permissions.d/` directly.

- **Open question -- precedence between home drop-ins and project main.**
  Current plan: layer order is home main, home drop-ins, project main,
  project drop-ins. This means a home `permissions.d/aws.yaml` deny will
  short-circuit before the project main file gets to allow it. That is
  consistent with "deny anywhere wins" but may surprise users who expect
  project-level overrides. Worth confirming during implementation; if
  surprising, swap to home main, project main, then home drop-ins, then
  project drop-ins.
