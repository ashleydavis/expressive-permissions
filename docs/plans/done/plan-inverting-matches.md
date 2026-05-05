# Implement Inverting Matches (`not:`)

## Overview

The `not:` field is documented in `docs/USER-DEFINED-RULES.md` and `docs/PROTECTING-PRODUCTION.md` but is not yet implemented. It inverts a set of matching fields so that a rule fires only when the enclosed fields do NOT all match simultaneously. This enables patterns like "deny any AWS operation where the profile is not sandbox" without needing a regex negation in every rule's `env` field. Any combination of `cmd`, `options`, `env`, `cwd`, and `path` can appear under `not:`.

## Issues

## Steps

1. **Add `INotFields` interface in `src/load-config.ts`** (above `IYamlEntry`)
   - Fields: `cmd?: string | string[]`, `"cmd-in"?: string[]`, `options?: string[] | Record<string, string | boolean>`, `"options-in"?: string[]`, `cwd?: string`, `"cwd-in"?: string[]`, `env?: Record<string, string>`, `path?: string`, `"path-in"?: string[]`
   - Excludes decision/meta fields (`decide`, `reason`, `rules`) and tool-specific fields (`host`, `host-in`, `tool`, `tool-in`)
   - Does NOT yet include `file` — the docs list it as valid under `not:` but it is added in the matching-file-contents plan
   - Include a `//` comment on each field explaining its purpose

2. **Add `not?: INotFields` to `IYamlEntry` in `src/load-config.ts`**
   - With a `//` comment: inverted fields block; rule fires only when enclosed fields do NOT all match

3. **Add `"not"` to `KNOWN_FIELDS`** in `src/load-config.ts` (line 72) so it is not mistaken for a subcommand key

4. **Add `notFieldsAllMatch(not: INotFields, node: AstNode, env: Environment, cmdOffset: number): boolean` in `src/load-config.ts`**
   - Evaluates `cmd`/`cmd-in` via `matchesCmd`, `options`/`options-in` via `matchesOptions`, `cwd`/`cwd-in` via `matchesCwd`, `env` via `matchesEnvVars`, `path`/`path-in` via `matchesPath`
   - For `path`/`path-in`: only evaluate when `node` has a `file_path` property (i.e. file tool nodes); for bash nodes, treat `path`/`path-in` as not present (skip the check)
   - Returns `true` only when all present applicable fields match (AND semantics)
   - Fields that are not present in `not` are ignored (always considered matching)

5. **Integrate into `buildBashRule` (`src/load-config.ts` line 279)**
   - After the existing field checks, add:
     ```typescript
     if (entry.not !== undefined && notFieldsAllMatch(entry.not, node, env, cmdOffset)) { return ABSTAIN; }
     ```

6. **Integrate into `buildBashScopedRule` (`src/load-config.ts` line 350)**
   - Same check after the existing field block

7. **Integrate into `matchesFileEntry` (`src/load-config.ts` line 438)**
   - Add: `if (entry.not !== undefined && notFieldsAllMatch(entry.not, node, env, 0)) { return false; }` (pass `cmdOffset=0`; file tools have no positional commands)

8. **Integrate into `matchesWebFetchEntry` (`src/load-config.ts` line 487)**
   - Same pattern with `cmdOffset=0`

9. **Integrate into `matchesMcpEntry` (`src/load-config.ts` line 531)**
   - Same pattern with `cmdOffset=0`

## Unit Tests

Add all new tests to `src/test/load-config.test.ts`:

- `notFieldsAllMatch`: env field matches → `true`
- `notFieldsAllMatch`: env field does not match → `false`
- `notFieldsAllMatch`: cmd field matches → `true`
- `notFieldsAllMatch`: cmd field does not match → `false`
- `notFieldsAllMatch`: multiple fields, all match → `true`
- `notFieldsAllMatch`: multiple fields, one does not match → `false`
- `notFieldsAllMatch`: no fields set → `true` (empty not: always matches)
- Bash rule: `not: env:` — env matches → ABSTAIN (rule suppressed)
- Bash rule: `not: env:` — env does not match → rule fires (DENY)
- Bash rule: `not: cmd:` — cmd matches → ABSTAIN
- Bash rule: `not: cmd:` — cmd does not match → rule fires
- Bash rule: `not:` with cmd and env combined — both match → ABSTAIN
- Bash rule: `not:` with cmd and env combined — only one matches → rule fires
- File tool rule (`read`): `not: env:` matching → ABSTAIN
- File tool rule (`read`): `not: env:` not matching → rule fires
- WebFetch rule: `not: env:` matching → ABSTAIN
- MCP rule: `not: env:` matching → ABSTAIN

## Smoke Tests

Add YAML files to `e2e/bash/`:

- `bash-not-env-matches-abstain.yaml` — `not: env: AWS_PROFILE: sandbox` with `AWS_PROFILE=sandbox` env var inline in command → ABSTAIN (rule suppressed, falls to default ask)
- `bash-not-env-no-match-fires.yaml` — same config, `AWS_PROFILE=prod` → DENY

## Verify

- `bun test` — all unit tests pass
- `bun run scripts/smoke-tests.sh` — all smoke tests pass (including new ones)
- `bun b` — plugin compiles without TypeScript errors
- Manual check: `not:` field is in `KNOWN_FIELDS` so it does not create a phantom subcommand rule

## Notes

- `not:` does NOT support `host`/`host-in` or `tool`/`tool-in`; those are tool-specific fields omitted from `INotFields` per the docs field reference.
- `cmd` within `not:` uses the same `cmdOffset` as the outer rule (positional args after the subcommand path).
- `path`/`path-in` within `not:` are only evaluated when the node has a `file_path` (file tool rules). In bash rule context they are skipped, since bash nodes carry no file path.
- `not:` and `file:` together (e.g. `not: { file: { ... } }`) are handled in the matching-file-contents plan, which adds `file` to `INotFields` after both plans are implemented.
- An empty `not:` block (no fields) always matches and therefore always suppresses the rule. This is consistent with AND semantics over zero fields.
