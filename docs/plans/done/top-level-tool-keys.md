# Replace `mcp:` Section with Top-Level Tool-Name Keys

## Overview

Eliminate the `mcp:` YAML section entirely. Tool-name rules are declared **only** as top-level YAML keys: `Grep:`, `ToolSearch:`, `mcp__claude_ai_Atlassian__getJiraIssue:`, `"mcp__*__delete_*":`. The internal `IYamlConfig.mcp` field is removed; tool rules are compiled directly from the non-section top-level keys. This is a breaking change for any existing config that uses `mcp:`. The plan covers the loader change, full migration of in-tree tests, fixtures, and docs, and a clear failure mode for users still on the old syntax.

## Issues

1. [x] Pre-merge validation gap: `loadConfigRules()` shallow-merges home + project before `validateConfig`, so a stray `mcp:` in the home file is silently dropped when the project file also exists. Move the migration-error check to a per-file validation pass, or add a dedicated pre-merge `mcp:` detector.
2. [x] Decide the failure mode when a config contains `mcp:`. Currently the plan emits a stderr error but still compiles the remaining rules, producing a possibly-more-permissive runtime than intended. Decide: fail-closed (drop all rules from that file) vs. partial-load with warning, and document the choice.
3. [x] Reject top-level keys that collide with `KNOWN_FIELDS` (e.g. `cwd:`, `decide:`, `not:`, `file:`) instead of silently promoting them to tool-name rules. Add a validation error and a test.
4. [x] Decide whether top-level keys with the lowercase form of a section name (`Bash:`, `Read:`) should be rejected or warned, since they would otherwise silently become tool-name rules and confuse users.
5. [x] `validateEntry` and `resolveEntryCwdPatterns` both recurse through any non-`KNOWN_FIELDS` keys as if they were bash subcommands. For top-level tool-name entries this is incorrect; adapt both functions or branch on an `isToolNameEntry` flag.
6. [x] Sub-rules under a scoped top-level tool entry do not inherit the parent key as their `tool:` matcher (only the parent gets `entry.tool = key` set in step 3). Decide and document the inheritance rule, then add a test exercising `Grep: { rules: [...] }`.
7. [x] Multiple `mcp:` list-entries with differing `tool:` values must migrate to N top-level keys, not one key with a list. Audit each existing fixture for this shape and rewrite accordingly.
8. [x] Add tests for: glob-keyed top-level rule end-to-end; scoped form; list form `Grep: [..., ...]`; merge of differing top-level keys across home + project; overwrite of the same key across home + project; `sourceFile`/`sourceLine` annotation on a top-level tool entry; rejection of `mcp:` when valid keys also exist.
9. [x] Rename or relocate `e2e/mcp/*` directories so the names reflect "tool-name rules" rather than the removed `mcp` section, OR add a note in CLAUDE.md/the plan that the directory naming is historical.
10. [x] Update the inline `//` doc comments on `compileNonBashSections` (mentions `mcp`), `validateConfig` (`nonBashSections` array literal), and the `IYamlConfig` interface (the `mcp` field comment).
11. [x] Audit `docs/AUDIT-LOG.md` and any other docs not listed in steps 10-12 for residual `mcp:` section references.
12. [x] Decide whether to rename the internal `buildMcpRule`/`buildMcpScopedRule`/`compileMcpEntries`/`matchesMcpEntry` symbols and the `yaml:mcp:*` rule-name strings now or defer. The rule names surface in audit logs, so the user-visible string at minimum should reflect the new semantics.
13. [x] Add a `compileTopLevelToolRules` direct unit test (mentioned in Unit Tests but not in the step 8 inventory).
14. [x] Update step 8's added-test name "explicit tool field overrides the key as label" to clarify that `tool:`/`tool-in:` *do not override* the key simply becomes a label whenever either is present.
15. [x] Clarify step 3's dispatch wording: pick either "call `compileMcpEntries` after promoting key->tool" or "open-code dispatch like `compileNonBashSections`", not both.
16. [x] Remove `examples/` from step 9's grep target (or note it as a no-op) the directory contains no YAML to migrate.
17. [x] Add a step to rebuild the bundled `plugin/dist/hook.js` and `plugin/dist/pre-hook.js` (via `bun run build`) before declaring the migration complete.

## Steps

### 1. Update `IYamlConfig` in `src/load-config.ts`

- Remove the `mcp?: IYamlEntry | IYamlEntry[]` field from the `IYamlConfig` interface.
- The interface now declares only `bash`, `read`, `write`, `edit`, `multi_edit`, `webfetch`.
- Note: at runtime the parsed config will still have arbitrary string keys for tool names; those are accessed via `Object.keys(config)` and do not need to appear on the typed interface (the existing index-signature pattern in `IYamlEntry` is the precedent here).

### 2. Add `KNOWN_SECTIONS` constant in `src/load-config.ts`

- Place near the top, alongside `KNOWN_FIELDS`.
- Value: `new Set(["bash", "read", "write", "edit", "multi_edit", "webfetch"])` note the absence of `mcp`.
- Used by `compileTopLevelToolRules` and `validateConfig` to discriminate sections from tool-name keys.
- Also add `RESERVED_TOP_LEVEL_KEYS = new Set([...KNOWN_FIELDS, ...KNOWN_SECTIONS, "mcp"])`. Any top-level key that appears in `KNOWN_FIELDS` (`decide`, `cwd`, `not`, `file`, etc.) or equals the legacy `"mcp"` is rejected as a tool-name rule (see Step 6). This prevents users from accidentally writing `decide: allow` at the top level and silently turning it into a tool-name rule for a tool named "decide". Section names (lowercase `bash`, `read`, etc.) are NOT reserved as tool names because section dispatch already consumes them; documented section/tool collision rule stays as-is. Capitalized variants (`Bash:`, `Read:`) are legal tool-name keys (the real Claude Code tools are `Bash`, `Read`, etc.) and should NOT be rejected.

### 3. Add `compileTopLevelToolRules(config: IYamlConfig): Rule[]` in `src/load-config.ts`

Place near `compileNonBashSections`. Behaviour:

- Iterate `Object.keys(config)`; skip any key in `KNOWN_SECTIONS`; skip any key in `RESERVED_TOP_LEVEL_KEYS` (those are caught by `validateConfig` and emit a `[CONFIG ERROR]`, not compiled).
- For each remaining key, treat its value as `IYamlEntry | IYamlEntry[]`, normalise via `normalizeToList`.
- For each entry:
  - If `entry.tool === undefined && entry["tool-in"] === undefined`, set `entry.tool = key` (the key is the implicit tool pattern).
  - Otherwise leave `entry.tool`/`entry["tool-in"]` unchanged (the key becomes a human-readable label whenever either field is present; the explicit field wins for matching).
  - **Sub-rule inheritance:** when `entry.rules` is set, walk each sub-rule and apply the same defaulting: if a sub-rule has neither `tool:` nor `tool-in:`, set its `tool = key` so it inherits the parent key. Sub-rules that already specify `tool:`/`tool-in:` keep those. This makes `Grep: { rules: [{cwd: "./a", decide: allow}, {decide: ask}] }` match `Grep` on every sub-rule, just like `bash:` sub-rules inherit their parent binary.
- Dispatch each entry by **calling `compileMcpEntries(normalizedList)`** after the key->tool defaulting step. (Open-coding the dispatch is rejected to avoid drift with `compileMcpEntries`; reusing it also gives identical handling of `entry.rules` -> `buildMcpScopedRule` and `entry.decide` is a string -> `buildMcpRule`. See Step 12 on the symbol naming.)
- Return the accumulated `Rule[]`.

The key participates in matching but is never coerced into a glob-anchor picomatch already handles literal strings and `*`/`**` patterns. Quoted YAML keys (`"mcp__*__delete_*":`) are how users write globs.

### 4. Remove the old `mcp:` dispatch in `src/load-config.ts`

- In `compileNonBashSections`: delete the `if (config.mcp !== undefined) { ... }` block that compiled `config.mcp`.
- In `resolveRelativeCwdPatterns`: remove `"mcp"` from the hardcoded `sectionKeys` tuple. (Top-level tool keys are walked separately; see Step 5.)
- In `validateConfig`: remove `"mcp"` from the `nonBashSections` array.

### 5. Walk top-level tool keys in `resolveRelativeCwdPatterns`

After the existing loops over `config.bash` and the named non-bash sections, add a final loop:

- For each `Object.keys(config)` not in `KNOWN_SECTIONS` and not in `RESERVED_TOP_LEVEL_KEYS`, call `resolveEntryCwdPatterns(entry, baseDir, { isToolNameEntry: true })` for each entry under the key (after `normalizeToList`).
- This preserves `cwd: "./**"` rewriting for tool-name rules.

### 5a. Branch `validateEntry` and `resolveEntryCwdPatterns` on entry kind

Both functions currently treat any non-`KNOWN_FIELDS` key on an entry as a bash subcommand and recurse into it. For tool-name entries this is wrong: a stray unknown key under a tool-name entry must be flagged as an error rather than walked as if it were a sub-binary.

- Add a parameter `isToolNameEntry: boolean = false` (or an options object) to both `validateEntry` and `resolveEntryCwdPatterns`. Default `false` preserves existing bash behaviour.
- In `validateEntry` when `isToolNameEntry` is true: any `subcommandKeys` (keys not in `KNOWN_FIELDS`) push a `IConfigError` of the form `unknown field '<key>' on tool-name rule '<path>'`. Do NOT recurse into them.
- In `resolveEntryCwdPatterns` when `isToolNameEntry` is true: skip the subcommand-recursion branch entirely. Still walk `entry.rules` and rewrite `entry.cwd`/`entry["cwd-in"]`.
- Step 6 below passes `isToolNameEntry: true` from the top-level tool-key validation loop. Bash-section validation continues to call with the default.

### 6. Update `validateConfig` in `src/load-config.ts`

- Remove the `mcp` iteration (already covered in Step 4).
- After validating `bash` and the file-tool sections, add a loop over top-level keys. For each key:
  - If `KNOWN_SECTIONS.has(key)`, skip (already handled).
  - If `RESERVED_TOP_LEVEL_KEYS.has(key)`:
    - If `key === "mcp"`, push `IConfigError { path: "mcp", message: "the 'mcp:' section has been removed; declare each rule as a top-level key (e.g. 'Grep: { decide: allow }') see docs/USER-DEFINED-RULES.md" }`.
    - Otherwise (a `KNOWN_FIELDS` collision such as `decide`, `cwd`, `not`, `file`), push `IConfigError { path: key, message: "top-level key '<key>' is a reserved rule field; tool-name rules cannot use these as keys" }`.
    - Continue (do not validate or compile).
  - Else call `validateEntry(entry, key + (idx > 0 ? `[${idx}]` : ""), errors, { isToolNameEntry: true })` for each entry.
- The `mcp:` and `KNOWN_FIELDS`-collision errors are emitted at the validation pass; the corresponding compile path in Step 3 already skips these keys, so the compiled rule list will not include them. This is the documented failure mode: **partial-load with loud `[CONFIG ERROR]` lines on stderr**, NOT fail-closed. Rationale (issue 2): the existing loader is partial-load for every other validation error today; staying consistent avoids the surprise of a single typo silently disabling every other rule. The error message guides the user to remove `mcp:` or rename the colliding key. The home/project pre-merge detection in Step 6a ensures the error fires even when both files are present.

### 6a. Run `validateConfig` per file before merging in `loadConfigRules`

Currently `loadConfigRules()` shallow-merges `homeConfig` and `projectConfig` and then runs `validateConfig` on the merged result. With shallow merge, a top-level `mcp:` in the home file is wholly dropped if the project file also defines anything (or vice versa) and the migration error never fires.

- Before merging, call `validateConfig(homeConfig)` and `validateConfig(projectConfig)` separately. Emit each file's errors to stderr with the file path prefixed (e.g. `[CONFIG ERROR] (~/.claude/permissions.yaml) mcp: ...`).
- Then merge as before. The post-merge `validateConfig` call can be removed because per-file validation already covers everything (errors are detected at the file boundary, not the merge boundary).
- `loadConfigRulesFromFile` (the single-file path used by `loadHomeConfigRules` and `loadProjectConfigRules`) does not need a change; it already validates the single file it loads.
- The compile path also needs adjustment: today `compileConfig(merged)` runs over the merged object, which still contains the offending `mcp:` key. Since `compileTopLevelToolRules` skips `RESERVED_TOP_LEVEL_KEYS` (Step 3), no rules are emitted for `mcp:` even if it survives into the merged config. No change is needed beyond Step 3.

### 7. Wire `compileTopLevelToolRules` into `compileConfig`

In `compileConfig`, after `compileBashSection` and `compileNonBashSections`, push the result of `compileTopLevelToolRules(config)` into the rule list.

### 8. Migrate all in-tree tests using `mcp:` syntax in `src/test/load-config.test.ts`

Every `mcp:` YAML fixture is rewritten to top-level keys. **List-form fixtures with differing `tool:` values across entries must split into N separate top-level keys, not one key with a list** (issue 7). Below is the inventory:

- **Line ~705** `mcp tool: fires when tool_name matches pattern`. Single entry with `tool: "mcp__*__delete*"`. Rewrite to one key: `"mcp__*__delete*": { decide: deny }`.
- **Line ~844** list with two entries that have *different* tool patterns (`mcp__*__delete*` vs `mcp__*__read*`). Rewrite to two top-level keys:
  ```yaml
  "mcp__*__delete*": { decide: deny }
  "mcp__*__read*":   { decide: allow }
  ```
- **Line ~1432** single entry with `tool-in: [<a>, <b>]` and `decide: ask`. Rewrite to a single labelled key: `"github-write": { tool-in: [..., ...], decide: ask }` (the label is arbitrary; `tool-in` is preserved verbatim).
- **Line ~1614** single entry with `tool: "mcp__*__dangerous_tool"`, `decide: deny`, `reason:`. Rewrite to one quoted-glob key.
- **Line ~1750** catch-all `mcp: { decide: ask }` with no `tool:` at all. The original test asserts the rule fires for any `mcp__...` tool AND for `WebFetch` (because both are `type: "other"`). Under the new model there is no implicit MCP catch-all; the equivalent literal-rewrite is `"*": { decide: ask }`. Update the test name to reflect the new semantics: "wildcard top-level key fires for any tool" (drop the WebFetch-specific commentary or move it into a separate test if the broad-wildcard behaviour is still desired).
- **Line ~2199** list-form with two entries that have *different* tool patterns (`mcp__*__list_*` vs `mcp__*__delete_*`). Rewrite to two top-level keys, mirroring the line ~844 split.
- **Line ~3012** single entry with `not: { env: ... }`. Rewrite to a single key, defaulted from the original `tool:` if any, otherwise label-keyed.
- **Line 2593** `const config: IYamlConfig = { mcp: { cwd: "./**", decide: "allow" } };` rewrite to `{ "Foo": { cwd: "./**", decide: "allow" } }` and update the test name.
- **Line 3453** `mcp: [{ decide: "nope", tool: "SomeTool" }]` rewrite to `{ SomeTool: { decide: "nope" } }`.

The rule of thumb when migrating list-form fixtures: **one top-level key per distinct `tool:` value**. If two list entries share the same `tool:` value, they may stay under a single key as a list; if they differ, split into separate keys.

Add the following new tests (in the section currently labelled "MCP rules", which is renamed to "Tool-name rules"):

- `top-level tool key: fires for the named tool only` `Grep:` key allows `Grep`, abstains for `Agent`.
- `top-level tool key: explicit tool field replaces the key as matcher; key becomes a label` `SomeLabel: { tool: ToolSearch, decide: allow }` fires for `ToolSearch`, abstains for `SomeLabel`. (Issue 14: `tool:`/`tool-in:` do not "override" the key the key never reaches the matcher when either field is present; it is only a human-readable label in audit logs.)
- `top-level tool key: tool-in field replaces the key as matcher; key becomes a label` `"my-label": { tool-in: [A, B], decide: deny }` fires for both `A` and `B`, abstains for `my-label`.
- `top-level tool key: glob in quoted key matches multiple tools end-to-end` `"mcp__*__delete_*": { decide: deny }`, fired against `mcp__files__delete_file`. Confirms picomatch handles the key as-is.
- `top-level tool key: scoped form with rules: list applies parent key to sub-rules` `Grep: { rules: [ { cwd: "./a", decide: allow }, { decide: ask } ] }`. Both sub-rules match `Grep` only. (Issue 6.)
- `top-level tool key: list form Grep: [..., ...]` two entries under the same key both fire for `Grep`.
- `top-level tool key: differing keys merge across home + project` home defines `Grep:`, project defines `Agent:`; both rules survive into the compiled list.
- `top-level tool key: same key in project replaces home` home defines `Grep: { decide: ask }`, project defines `Grep: { decide: allow }`; the project rule wins (documents the existing shallow-merge behaviour).
- `top-level tool key: sourceFile/sourceLine annotations propagate` after compiling, the resulting `Rule` has `ruleFile` and `ruleLine` matching the YAML source.
- `loader rejects mcp: section with a clear error` fixture `mcp: [{ tool: X, decide: allow }]` triggers a `[CONFIG ERROR]` line referencing `docs/USER-DEFINED-RULES.md`. Verify any *other* valid top-level keys in the same fixture still compile (partial-load semantics from issue 2).
- `loader rejects mcp: even when a project file exists` (issue 1) home file contains `mcp:`, project file contains valid sections; the migration error fires for the home file (per-file validation, not post-merge).
- `loader rejects top-level KNOWN_FIELDS collision` fixture `decide: allow` at the top level triggers a `[CONFIG ERROR]` referencing the reserved field; no rule is compiled for it. (Issue 3.)
- `loader rejects unknown fields under a tool-name entry` fixture `Grep: { decide: allow, bogus_field: 1 }` triggers a `[CONFIG ERROR]` from `validateEntry` when called with `isToolNameEntry: true`. Bash entries with the same `bogus_field` continue to walk it as a sub-binary (no regression). (Issue 5.)
- `compileTopLevelToolRules direct unit test` build an `IYamlConfig` with a mix of section keys and top-level tool keys, call `compileTopLevelToolRules` directly (not through `compileConfig`), and assert it returns rules ONLY for the tool-name keys, not for the sections. (Issue 13.)

### 9. Migrate fixtures used elsewhere

Search the repo for any remaining `mcp:` in YAML fixtures and rewrite each:

- Run `grep -rn "^mcp:\|^  mcp:" /home/ash/claude-permissions/{src,e2e,docs}` and update every hit. **Do not include `examples/` in the grep target** the directory contains no YAML to migrate (issue 16: confirmed the project has no top-level `examples/` directory; if one is added later, sweep it then).
- Specific known locations: `e2e/mcp/*/test.yaml` and `e2e/mcp/*/tmp/project/.claude/permissions.yaml` for each of `mcp-glob-deny`, `mcp-no-rule`, `mcp-tool-allow`, `mcp-tool-deny`, `mcp-tool-in`. Each file's `mcp:` block becomes one or more top-level keys following the inventory rules from Step 8 (split list-form fixtures by distinct `tool:` value).
- The directories themselves keep the historical `e2e/mcp/*` naming. Renaming the directories would cause unnecessary churn (test runner discovery, fixture cross-references). Add a one-line note in `e2e/mcp/README.md` (create the file if absent) explaining: "These directories test top-level tool-name rules with `mcp__*` keys; the directory naming is historical and predates the removal of the `mcp:` YAML section."

### 10. Update `docs/USER-DEFINED-RULES.md`

- Update the "Structure overview" paragraph: top-level keys are now (a) **section names** (`bash`, `read`, `write`, `edit`, `multi_edit`, `webfetch`) or (b) **tool name patterns** for everything else.
- Replace the entire "MCP tool rules" section with a "Tool-name rules" section. Show:
  - Exact match: `ToolSearch: { decide: allow }`.
  - Glob match: `"mcp__*__delete_*": { decide: deny }`.
  - List form: `Grep: [ { cwd: "./**", decide: allow }, { decide: ask } ]`.
  - Label-with-explicit-tool form: `"some-label": { tool-in: [A, B], decide: deny }`.
- Update the "Field reference" table — `tool` and `tool-in` now apply to "any top-level tool-name rule" rather than "mcp".
- Update the table of contents anchor.

### 11. Update `docs/HOW_IT_WORKS.md`

- If the document describes section dispatch, replace any `mcp` mention with "tool-name rules from top-level keys".
- Add a sentence describing that the loader now compiles top-level non-section keys directly into tool-name rules.

### 12. Update `README.md`

- Replace any `mcp:` example in the quick-start with a top-level tool key example.
- If the README lists supported sections, prune `mcp` from the list.

### 13. Update `~/.claude/permissions.yaml` reference (already done by user)

The user's own permissions file at `/home/ash/tools/config/home/.claude/permissions.yaml` is already in the new shape no action needed for that file. The plan above ensures the loader catches up.

### 14. Update inline `//` doc comments in `src/load-config.ts`

(Issue 10.) Walk the file and update every comment that mentions the removed `mcp:` section:

- The `IYamlConfig` interface comment block: remove the `// mcp?: ...` field comment entirely along with the field itself.
- The doc comment above `compileNonBashSections`: drop the `mcp` mention from the list of sections it handles.
- The doc comment above `validateConfig`: update to reference the new `["read", "write", "edit", "multi_edit", "webfetch"]` set, and add a sentence noting that top-level non-section keys are validated as tool-name entries.
- Doc comments above `buildMcpRule`, `buildMcpScopedRule`, `compileMcpEntries`, `matchesMcpEntry`: update to read "tool-name rule" rather than "MCP rule" (see Step 16 for the user-visible rule-name string change; the symbol names themselves stay).

### 15. Audit `docs/AUDIT-LOG.md` and other untouched docs (issue 11)

Run `grep -n "mcp:" /home/ash/claude-permissions/docs/*.md` and inspect each hit not already covered by Steps 10-12:

- `docs/AUDIT-LOG.md`: any reference to `yaml:mcp:*` rule names becomes `yaml:tool:*` (paired with Step 16). Any narrative reference to "the `mcp:` section" becomes "tool-name rules".
- Any other markdown file in `docs/` (`HOW_IT_WORKS.md` is already covered in Step 11): scan for `mcp:` and update prose to "tool-name rules".
- Migration callouts that intentionally name the removed section (e.g. "the `mcp:` section was removed in <date>") are kept; mark such callouts inline so they survive future audits.

### 16. Rename user-visible rule-name strings; defer symbol renames (issue 12)

The internal symbols `buildMcpRule`, `buildMcpScopedRule`, `compileMcpEntries`, `matchesMcpEntry` are NOT renamed in this change set; renaming them would touch many call sites and tests for no functional benefit. They remain as-is.

The user-visible `ruleName` strings ARE renamed because they appear in the audit log and in error messages. Specifically:

- `src/load-config.ts:727` change `const ruleName = `yaml:mcp:${entry.decide}`` to `const ruleName = `yaml:tool:${entry.decide}``.
- `src/load-config.ts:810` change `const ruleName = `yaml:mcp:scoped`` to `const ruleName = `yaml:tool:scoped``.
- Update any test that asserts on those exact strings (`grep -n "yaml:mcp:" /home/ash/claude-permissions/src/test`).
- Update `docs/AUDIT-LOG.md` examples (paired with Step 15).

### 17. Rebuild bundled hooks (issue 17)

Before declaring the migration complete, run `bun run build` in `/home/ash/claude-permissions` to regenerate `plugin/dist/hook.js` and `plugin/dist/pre-hook.js` from the updated TypeScript sources. Confirm the output files include the new `compileTopLevelToolRules` logic (e.g. by grepping the bundled files for `KNOWN_SECTIONS` or `RESERVED_TOP_LEVEL_KEYS`). Without this step the installed plugin still ships the old compiled bundle even though the source has changed.

## Unit Tests

- All listed under Step 8: rewriting existing `mcp:`-keyed test fixtures to top-level form.
- Three new tests:
  - `top-level tool key: fires for the named tool only`
  - `top-level tool key: explicit tool field overrides the key as label`
  - `loader rejects mcp: section with a clear error`
- Direct test of `compileTopLevelToolRules`: assert that a config with mixed sections + top-level keys produces both bash rules and tool-name rules in a single `Rule[]`.

## Smoke Tests

- Update existing `e2e/` fixtures using `mcp:` (Step 9).
- Add a fixture exercising at least one literal-key tool name (e.g. `Grep:`) and one quoted-glob tool name (e.g. `"mcp__*__delete_*":`). Verify both end-to-end through the smoke runner.

## Verify

After implementation, the executing agent runs:

1. `cd /home/ash/claude-permissions && bun run compile` clean TypeScript compile.
2. `cd /home/ash/claude-permissions && bun test` full suite, expect 0 failures.
3. `cd /home/ash/claude-permissions && bun test src/test/load-config.test.ts` focused load-config tests, expect 0 failures and every new test from Step 8 present.
4. `grep -rn "^mcp:\|^  mcp:" /home/ash/claude-permissions/{src,e2e,docs,README.md}` expect zero hits (other than docs explicitly referencing the now-removed section in migration text, which should be searched for and confirmed intentional). Note: `examples/` is intentionally excluded (issue 16).
5. `grep -n "config.mcp\|IYamlConfig.*mcp\|\.mcp\b" /home/ash/claude-permissions/src/` expect zero hits in source.
6. `grep -n "yaml:mcp:" /home/ash/claude-permissions/src /home/ash/claude-permissions/docs` expect zero hits (issue 12 / Step 16).
7. `cd /home/ash/claude-permissions && bun run smoke` e2e smoke runner, expect 0 failures.
8. `cd /home/ash/claude-permissions && bun run build` regenerates `plugin/dist/hook.js` and `plugin/dist/pre-hook.js` (Step 17). Confirm both bundles exist and are non-empty after the build.
9. Manually load `~/.claude/permissions.yaml` (which already uses top-level tool keys) by invoking `loadHomeConfigRules()` and assert the returned `Rule[]` includes rules for at least `Grep`, `Agent`, `ToolSearch`.
10. Manually load a YAML containing only `mcp: [{ tool: X, decide: allow }]` and confirm a `[CONFIG ERROR]` line is emitted on stderr referencing the migration path.
11. Manually load a YAML containing `decide: allow` at the top level (KNOWN_FIELDS collision) and confirm the matching `[CONFIG ERROR]` fires (issue 3).
12. Manually load a YAML with `mcp:` in the home file AND a project file present, and confirm the per-file validation in Step 6a still emits the error (issue 1).

## Human Verification

After the AI agent finishes:

1. Open `/home/ash/tools/config/home/.claude/permissions.yaml` and trigger Claude Code tool calls for `Grep`, `Agent`, `ToolSearch` in any project — confirm none of them prompt for permission (they're now allowed by the top-level keys).
2. Edit the file and add a deliberate `mcp: - tool: foo decide: allow` block. Restart Claude Code. Confirm a clear `[CONFIG ERROR]` message about the removed `mcp:` section appears in the relevant log/output, and that other top-level rules still work.
3. Quote a tool-name glob in the YAML: add `"mcp__claude_ai_Atlassian__delete*": { decide: deny }`. Trigger an Atlassian delete tool call (or stub one) — confirm the deny fires.
4. Skim the updated `docs/USER-DEFINED-RULES.md` and `README.md` for any lingering reference to `mcp:` as a section heading. Confirm none remain except in migration callouts.

## Notes

- **Breaking change.** Any existing `~/.claude/permissions.yaml` or project YAML using `mcp:` will fail loudly with the validation error from Step 6. We accept this in exchange for a single, simpler way to declare tool rules. If a softer migration is desired, an alternative is to log a deprecation warning and auto-fold `mcp:` entries into the top-level form for one release; that is **not** what this plan does.
- **`tool` and `tool-in` fields are kept.** The shorthand sets `entry.tool` only when neither field is present. This preserves OR-list semantics (`tool-in: [A, B]` under any label key) and lets users decouple the YAML key from the actual matcher when they want a human-readable label. When either field is present, the YAML key never reaches the matcher; it is purely a label that surfaces in audit logs.
- **Glob keys.** YAML allows `*` in keys when quoted, e.g. `"mcp__*__delete_*":`. This is sufficient for the common glob case and avoids inventing new syntax.
- **Section/tool collision.** A user cannot name a tool `bash`, `read`, `write`, `edit`, `multi_edit`, or `webfetch` those keys are sections. The legacy `mcp:` key is also reserved as a migration trap. Capitalised variants (`Bash:`, `Read:`) are legal tool-name keys because the real Claude Code tools use those exact identifiers (issue 4). The seven section names plus `mcp` form `RESERVED_TOP_LEVEL_KEYS` together with `KNOWN_FIELDS`. Documented in the structure-overview update.
- **Failure mode.** Validation errors emit `[CONFIG ERROR]` lines to stderr but do NOT fail-closed (issue 2). Other valid rules in the same file still compile. This matches the existing loader's behaviour for every other validation error and avoids the surprise of a single typo silently disabling every other rule. Users who want fail-closed semantics should treat any `[CONFIG ERROR]` line as a CI/lint failure.
- **Per-file validation.** `validateConfig` is now called per file before merge (Step 6a), not after merge. This is necessary because shallow-merging two files can wholly replace one side's top-level keys, hiding errors in the file that lost the merge.
- **Sub-rule key inheritance.** Sub-rules under a scoped top-level entry inherit the parent key as their `tool:` matcher, mirroring the bash-section convention where sub-rules inherit their parent binary (issue 6). A sub-rule that explicitly sets `tool:`/`tool-in:` overrides the inheritance.
- **Internal naming.** The `buildMcpRule`/`buildMcpScopedRule`/`compileMcpEntries`/`matchesMcpEntry` symbols are kept as-is (issue 12). Renaming them is an optional follow-up; calling them "tool-name rules" internally would touch many files for no functional change. The user-visible `yaml:mcp:*` rule-name strings ARE renamed to `yaml:tool:*` because they appear in the audit log.
- **Out of scope.** Renaming the internal `Mcp*` builders, per-key merging across home/project (currently `{...home, ...project}` lets project sections wholly replace home), and adding glob expansion of section names. These remain available as future work.
