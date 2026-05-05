# Implement Matching File Contents (`file:`)

## Overview

The `file:` field is documented in `docs/USER-DEFINED-RULES.md` and `docs/PROTECTING-PRODUCTION.md` but is not yet implemented. It matches a rule based on the existence and contents of a file on disk, using a `contains:` sub-key for substring matching. The primary use case is detecting the active kubectl context via `~/.kube/config`. `file:` can appear directly on a rule entry and also inside a `not:` block. When used inside `not:`, a missing file causes the `not:` block to abstain (neither the direct nor the inverted rule fires), matching the documented "if the file is absent, neither rule matches" behaviour.

**Prerequisite:** The `not:` plan must be implemented first so that `INotFields` exists to be extended with the `file:` field.

## Issues

## Steps

1. **Add `IFileMatch` interface in `src/load-config.ts`** (above `IYamlEntry`)
   - Field: `contains: string` — substring to match against file contents
   - Include a `//` comment on the field

2. **Add `file?: Record<string, IFileMatch | true>` to `IYamlEntry` in `src/load-config.ts`**
   - Key is a file path (supports leading `~` for home directory)
   - Value is `true` for an existence-only check, or `IFileMatch` for a content check
   - With a `//` comment explaining the field

3. **Add `file?: Record<string, IFileMatch | true>` to `INotFields` in `src/load-config.ts`**
   - Same type as on `IYamlEntry`; allows `not: { file: { ... } }` syntax

4. **Add `"file"` to `KNOWN_FIELDS`** in `src/load-config.ts` (line 72) so it is not mistaken for a subcommand key

5. **Add `import { homedir } from "os"` at the top of `src/load-config.ts`**

6. **Add `homePath(rawPath: string): string` helper in `src/load-config.ts`**
   - Replaces a leading `~` with `homedir()`

7. **Add `evaluateFileField(file: Record<string, IFileMatch | true>): "match" | "no-match" | "file-absent"` in `src/load-config.ts`**
   - For each `[rawPath, fileMatch]`: expand `~` via `homePath`, check `existsSync`; return `"file-absent"` if missing
   - If `fileMatch` is `true`, the file's existence is sufficient; skip the content check
   - Otherwise read the file with `readFileSync(path, "utf8")` and check `matchesPattern(fileMatch.contains, content)`; return `"no-match"` if not found
   - Return `"match"` when all checks pass

8. **Add `matchesFileField(entry: IYamlEntry): boolean` in `src/load-config.ts`**
   - Returns `true` when `entry.file` is undefined
   - Otherwise returns `true` only when `evaluateFileField(entry.file)` returns `"match"`

9. **Update `notFieldsAllMatch` in `src/load-config.ts`** (added by the `not:` plan)
   - Before evaluating other fields, if `not.file` is set: call `evaluateFileField(not.file)`; if result is `"file-absent"`, return `false` (special case: absent file suppresses the `not:` block entirely)
   - If result is `"no-match"`, return `false` (file field not met, so not all fields match)
   - If result is `"match"`, continue evaluating remaining fields normally

10. **Integrate `matchesFileField` into `buildBashRule` (`src/load-config.ts` line 279)**
    - After the existing field checks, add:
      ```typescript
      if (!matchesFileField(entry)) { return ABSTAIN; }
      ```

11. **Integrate into `buildBashScopedRule` (`src/load-config.ts` line 350)**
    - Same check after the existing field block

12. **Integrate into `matchesFileEntry` (`src/load-config.ts` line 438)**
    - Add: `if (!matchesFileField(entry)) { return false; }`

13. **Integrate into `matchesWebFetchEntry` (`src/load-config.ts` line 487)**
    - Same pattern

14. **Integrate into `matchesMcpEntry` (`src/load-config.ts` line 531)**
    - Same pattern

## Unit Tests

Add all new tests to `src/test/load-config.test.ts`:

- `evaluateFileField`: file absent → `"file-absent"`
- `evaluateFileField`: value is `true`, file exists (existence check only) → `"match"`
- `evaluateFileField`: value is `IFileMatch`, file exists, `contains` matches → `"match"`
- `evaluateFileField`: value is `IFileMatch`, file exists, `contains` does not match → `"no-match"`
- `evaluateFileField`: `~` in path is expanded correctly
- `matchesFileField`: no `file` field on entry → `true`
- `matchesFileField`: file exists and all fields match → `true`
- `matchesFileField`: file absent → `false`
- `matchesFileField`: file exists, contains does not match → `false`
- `notConditionsAllMatch` with `file`: file absent → `false` (special rule)
- `notConditionsAllMatch` with `file`: file exists + contains matches → `true`
- `notConditionsAllMatch` with `file`: file exists + contains does not match → `false`
- `notConditionsAllMatch` with `file` + `env`: file matches + env matches → `true`
- `notConditionsAllMatch` with `file` + `env`: file matches + env does not match → `false`
- Bash rule: direct `file: contains:` — file contains string → rule fires (ALLOW)
- Bash rule: direct `file: contains:` — file does not contain string → ABSTAIN
- Bash rule: direct `file: contains:` — file absent → ABSTAIN
- Bash rule: `not: { file: contains: }` — file absent → ABSTAIN (neither fires)
- Bash rule: `not: { file: contains: }` — file exists and matches → ABSTAIN (not: suppressed)
- Bash rule: `not: { file: contains: }` — file exists, does not match → rule fires (DENY)
- File tool rule (`read`): direct `file:` matching and not matching
- WebFetch rule: direct `file:` matching

## Smoke Tests

Add YAML files to `e2e/bash/`:

- `bash-file-contains-match-allow.yaml` — `file: {<fixture>: {contains: "sandbox"}}` where fixture file contains "sandbox" → ALLOW
- `bash-file-contains-no-match-abstain.yaml` — same config, fixture does not contain "sandbox" → ABSTAIN (falls to default ask)
- `bash-file-absent-direct-abstain.yaml` — `file:` referencing a nonexistent path → ABSTAIN
- `bash-not-file-absent-abstain.yaml` — `not: {file: {<nonexistent>: {contains: "sandbox"}}}` → ABSTAIN (neither fires)
- `bash-not-file-matches-abstain.yaml` — `not: {file: {<fixture>: {contains: "sandbox"}}}`, file contains "sandbox" → ABSTAIN (not: suppressed)
- `bash-not-file-no-match-fires.yaml` — same config, file does not contain "sandbox" → DENY
- `bash-protecting-production-kubectl-kubeconfig.yaml` — full kubectl example from PROTECTING-PRODUCTION.md using `file:` and `not: file:` to scope by kubeconfig context: sandbox context → ALLOW, non-sandbox `get` → ALLOW, non-sandbox `delete` → DENY

Note: smoke tests that reference files on disk should use fixture files committed under `e2e/` and reference them by absolute path constructed from the test runner's `$PROJECT_DIR`. Check existing `e2e/file/` tests for the pattern used.

## Verify

- `bun test` — all unit tests pass
- `bun run scripts/smoke-tests.sh` — all smoke tests pass (including new ones)
- `bun b` — plugin compiles without TypeScript errors
- Manual check: `file:` field is in `KNOWN_FIELDS` so it does not create a phantom subcommand rule

## Notes

- `file:` reads from disk at rule-evaluation time with no caching; this is intentional since `~/.kube/config` can change between commands.
- The "absent file → both rules abstain" behaviour for `not: file:` is deliberate: if there is no kubeconfig at all, Claude should not be silently allowed through.
- Fixture files for smoke tests should be committed to the repo under a dedicated directory (e.g. `e2e/fixtures/`) rather than relying on paths that only exist on the developer's machine.
