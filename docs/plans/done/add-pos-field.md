# Plan: Add `pos` field and unify field semantics

## Context

The current `args` field is overloaded — it does positional matching, flag-presence matching, or flag-value matching depending on the type of its value. This ambiguity means you cannot combine positional and flag matching in a single rule.

Additionally, field semantics are inconsistent: `cwd: [...]` was OR, `args: [...]` was OR, but the object form of `args` was AND.

## Unified field semantics

Fields are either **single-value** (hold one string at runtime: `cwd`, `path`, `host`) or **multi-value** (`args` flags, `pos` positional args). This determines which forms are valid:

| Form | Semantics | Valid for |
|---|---|---|
| `field: "X"` | Matches the field value against pattern X | all fields |
| `field: ["A", "B", "C"]` | AND: all patterns must match | multi-value fields only (`args`, `pos`) |
| `field-in: ["A", "B", "C"]` | OR: any pattern must match | all fields |

Single-value fields (`cwd`, `path`, `host`) do NOT support the array AND form -- a single runtime value cannot simultaneously satisfy two unrelated patterns. They only accept a single string or `field-in`.

Any string pattern can be a glob (picomatch) or a `/regex/` (detected by leading and trailing `/`, evaluated via `new RegExp(...)`).

Applied to each field:

| Field | Single | Array (AND) | `-in` (OR) |
|---|---|---|---|
| `pos` | pos[0] matches | pos[N] matches element N (by index) | pos[0] matches any |
| `path` | path matches | (not supported) | path matches any |
| `cwd` | cwd matches | (not supported) | cwd matches any |
| `host` | host matches | (not supported) | host matches any |
| `args` (list) | - | all listed flags present | any listed flag present |
| `args` (object) | - | all key/value pairs match (unchanged) | - |

`host-in` already exists and is correct. `cwd: [...]` currently has OR semantics -- this must change to an error or be dropped, with OR moving to `cwd-in: [...]`.

Backward compatibility is not required.

## Critical files

- `src/load-config.ts` — `IYamlEntry` interface, all `matches*` functions, `decide` call site
- `src/test/load-config.test.ts` — all tests for positional and array-field matching
- `docs/USER-DEFINED-RULES.md` — matcher table and all examples
- `docs/HOW_IT_WORKS.md` — any affected examples
- `README.md` — quick-start examples, motivation prose

## Step 1 — Update `src/load-config.ts` (review after)

1. **`IYamlEntry` interface changes:**
   - Add `pos?: string | string[]`
   - Add `"pos-in"?: string[]`
   - Add `"path-in"?: string[]`
   - Add `"cwd-in"?: string[]`
   - Add `"args-in"?: string[]` (flag OR)
   - Add `"tool-in"?: string[]` (MCP tool OR)
   - `host-in` already exists — no change

2. **Update `DecideValue` and `mapDecision`:**
   - Add `"abstain"` to the `DecideValue` union: `"allow" | "deny" | "ask" | "abstain"`
   - Add an `abstain` branch to `mapDecision` that returns `{ action: "abstain" }` (the `Decision` type already includes `IAbstainDecision`)

3. **Update `KNOWN_FIELDS`:**
   - Add all new matcher fields so they are not mis-classified as subcommand keys by `compileBashBinary`:
     `pos`, `pos-in`, `path-in`, `cwd-in`, `args-in`, `tool-in`

4. **Add `matchesPattern(pattern, value)`** — detects `/regex/` strings and dispatches to `new RegExp(inner).test(value)`; otherwise calls picomatch. Replace all direct `matchesGlob` calls with `matchesPattern`.

5. **Add `matchesPos(entry, node, posOffset)`:**
   - `pos` as string: `matchesPattern(entry.pos, posArray[posOffset])`
   - `pos` as array: each element `matchesPattern(element, posArray[posOffset + index])` — AND across indices
   - `pos-in` as array: any positional from `posOffset` onwards matches any listed pattern — OR (scan the full slice `posArray.slice(posOffset)`)
   - Both undefined: return true

6. **Update `matchesArgs`:**
   - Remove the `typeof entry.args === "string"` positional branch entirely
   - Remove `isGlobPattern` helper
   - Array branch: change from OR (`.some`) to AND (`.every`) — all listed flags must be present
   - Add `args-in` branch: OR — any listed flag present (`.some`)
   - Object branch: unchanged (AND, all key/value pairs)

7. **Update `matchesCwd`:**
   - **Drop** the array branch entirely (single-value fields cannot satisfy AND semantics; `cwd: [...]` is no longer valid)
   - Add `cwd-in` branch: OR — matches any pattern (`.some`)

8. **Update `matchesPath`:**
   - **Drop** the array branch entirely (same reason as `matchesCwd`)
   - Add `path-in` branch: OR — matches any pattern (`.some`)

9. **Update `buildMcpRule`:**
   - Add `tool-in` handling: OR — fires when `node.tool_name` matches any entry in the `tool-in` list

10. **Call `matchesPos` alongside all other matchers in `buildBashRule`.**

## Step 2 — Update `src/test/load-config.test.ts` (review after)

- Rename and update all positional `args` tests to use `pos`:
  - Line 228: `args: "*.ts"` → `pos: "*.ts"`
  - Line 245: `args: ["http://*", "ftp://*"]` → `pos-in: ["http://*", "ftp://*"]` (or `pos: "/{http|ftp}://"`)
  - Line 470: `args: "src/*"` → `pos: "src/*"`
  - Line 1078: `args: ["src/*", "test/*"]` → `pos-in: ["src/*", "test/*"]`
  - Line ~699 (mega config rm): `args: "/**"` → `pos: "/**"`
  - Line ~724 (mega config curl): `args: ["http://*", "ftp://*"]` → `pos-in: ["http://*", "ftp://*"]`
  - Line ~992 (realistic merge curl): `args: ["http://*"]` → `pos: "http://*"`
- Update any test using `cwd: [...]` for OR — change to `cwd-in: [...]`
  - Line ~1059 (`"bash cwd list"` test): `cwd: ["/etc/**", "/var/**"]` → `cwd-in: ["/etc/**", "/var/**"]`
- Update any test using `path: [...]` for OR — change to `path-in: [...]`
  - Line ~533 (`"read rule: path list"` test): `path: ["**/.env*", "~/.ssh/*"]` → `path-in: ["**/.env*", "~/.ssh/*"]`
- Fix the "realistic project config" test (line ~880): the rm rule uses `args: [r|recursive, f|force]` with the assertion at line ~929 that `rm -r` (only -r present) → `"deny"`. With AND semantics this would now be `"ask"` (both flags required). Change the yaml to use `args-in: [r|recursive, f|force]` to preserve OR behaviour, and update the test comment accordingly.
- Add new tests:
  - `pos` + `args` combined in one rule (AND across fields)
  - `pos` as list (positional by index)
  - `pos-in` scanning multiple positionals (OR across the full positional slice)
  - `/regex/` patterns in `pos`, `path`, `cwd`
  - `path-in`, `cwd-in`, `args-in`
  - `tool-in` for MCP (OR across tool name list)
  - `abstain` decide value in YAML

## Step 3 — Update docs (review after)

**`docs/USER-DEFINED-RULES.md`:**
- Rewrite the matcher table to show the unified `field` / `field-in` pattern for each row.
- Add a `pos` row; add `pos-in`, `path-in`, `cwd-in`, `args-in` rows. (`tool-in` already appears in the MCP section — verify the field reference table at the bottom also lists it.)
- Remove the `args: "."` / `args: [".", "src/*"]` positional row.
- Update `args: [r, f]` row: AND semantics, all flags must be present.
- Line 93: fix prose — remove "OR semantics" and "write two separate rules" note; array is now AND.
- Lines 82-91: object form `{ r|recursive: true, f|force: true }` — verify prose is consistent with AND.
- Lines 125-132: `args: ["http://*", "ftp://*"]` no longer valid. Replace with:
  1. `pos-in: ["http://*", "ftp://*"]`
  2. Regex alternative: `pos: "/{http|ftp}://"`
  3. Rule list alternative (one rule per scheme).
- Lines 113: `args: "."` → `pos: "."`
- Lines 134-141: `path: [...]` no longer valid. Replace with:
  1. Glob alternation: `path: "**/{.env*,.netrc,.ssh/*}"`
  2. `path-in: ["**/.env*", "**/.netrc", "~/.ssh/*"]`
  3. Rule list alternative.
- Line 331: `args: ["/etc/**"]` → `pos: "/etc/**"` (this was a positional match, not a flag)
- Lines 359, 362: `args: "."` → `pos: "."`
- Line 194: update prose referencing `args` positional matcher → `pos`
- Decision table: add `abstain` row (currently missing from the table even though the docs mention it in the "Strictest wins" prose).
- Audit the full doc for any remaining references to old semantics.

**`docs/HOW_IT_WORKS.md`:**
- Update any affected examples.

## Step 4 — Update README.md (review after)

- Line 53 (motivation): update `args: [r, f]` / `args: [recursive, force]` prose to reflect AND semantics and mention `args-in` for OR.
- Lines 163-170 (quick-start git add): `pos: "."` already in place; fix broken backtick on line 170, remove inline comments from YAML.

## Verification

After each step, run:
```
bun test
```
All tests must pass before moving to the next step. After step 1, many tests will fail until step 2 fixes them — that is expected.
