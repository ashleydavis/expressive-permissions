# Nested Rules (`rules:` key)

## Overview

The YAML config currently supports subcommand-key nesting (e.g. `aws: { ec2: { ... } }`) which consumes positional arguments. This plan adds a `rules:` key that provides conditional scoping without consuming positionals: when the parent entry's conditions (env, options, cmd, cwd, path, etc.) match, the sub-rules in `rules:` are evaluated and the strictest outcome wins. This lets users write things like "on any non-sandbox AWS profile, apply these sub-rules" without repeating the profile condition on every rule. The feature is documented in `docs/PROTECTING-PRODUCTION.md` and `docs/USER-DEFINED-RULES.md`; this plan wires up the implementation to match.

## Issues

## Steps

1. **`src/load-config.ts` — add `rules` field to `IYamlEntry`**
   Add `rules?: IYamlEntry[]` as a named field (with a `//` comment) before the index signature. This makes the type explicit and avoids treating `rules` as a subcommand key.

2. **`src/load-config.ts` — add `"rules"` to `KNOWN_FIELDS`**
   Add `"rules"` to the `KNOWN_FIELDS` set so `compileBashBinary` and `resolveEntryCwdPatterns` skip it during subcommand-key iteration.

3. **`src/load-config.ts` — add `aggregateOutcomes` helper**
   New function `aggregateOutcomes(a: RuleOutcome, b: RuleOutcome): RuleOutcome` that implements strictest-wins (deny > ask > allow > abstain) over two outcomes. Used by the scoped rule builders.

4. **`src/load-config.ts` — add `buildBashScopedRule`**
   New function `buildBashScopedRule(binary: string, subcommandPath: string[], entry: IYamlEntry): Rule`.
   - Compiles `entry.rules` recursively via `compileBashBinary(binary, entry.rules, subcommandPath)` — same path offset, no positionals consumed.
   - Returns a Rule that: (a) checks binary + subcommandPath + all entry conditions (cmd, options, env, cwd, cwd_resolved); (b) if conditions fail, returns ABSTAIN; (c) if conditions pass, iterates compiled sub-rules, aggregates via `aggregateOutcomes`, short-circuits on deny.

5. **`src/load-config.ts` — update `compileBashBinary`**
   In the per-entry loop, before the `typeof entry.decide === "string"` check, add: if `entry.rules !== undefined`, push `buildBashScopedRule(binary, subcommandPath, entry)` and skip the `buildBashRule` call (they are mutually exclusive; `rules` takes precedence).

6. **`src/load-config.ts` — add `buildFileScopedRule`**
   New function `buildFileScopedRule(nodeType: string, entry: IYamlEntry): Rule`.
   - Compiles `entry.rules` as file rules: each sub-entry either calls `buildFileScopedRule` (if it has `rules`) or `buildFileRule`.
   - Returns a Rule that: (a) checks nodeType + file_path + path/cwd/env conditions; (b) if fail, ABSTAIN; (c) if pass, evaluates sub-rules via `aggregateOutcomes`.

7. **`src/load-config.ts` — add `buildWebFetchScopedRule`**
   Same pattern as `buildFileScopedRule` but for webfetch nodes (checks host, cwd, env). Compiles sub-entries via `buildWebFetchScopedRule` / `buildWebFetchRule`.

8. **`src/load-config.ts` — add `buildMcpScopedRule`**
   Same pattern for MCP nodes (checks tool, cwd, env). Compiles sub-entries via `buildMcpScopedRule` / `buildMcpRule`.

9. **`src/load-config.ts` — update `compileNonBashSections`**
   In each section's per-entry loop, if `entry.rules !== undefined`, call the matching scoped rule builder instead of the plain builder.

10. **`src/load-config.ts` — update `resolveEntryCwdPatterns`**
    Add explicit handling for `entry.rules` before the subcommand-key loop: if `entry.rules` is an array, recurse `resolveEntryCwdPatterns` into each sub-entry. (Since `"rules"` is now in `KNOWN_FIELDS`, the existing loop skips it.)

11. **`src/test/load-config.test.ts` — unit tests for `buildBashScopedRule`**
    - Parent env condition does not match: returns ABSTAIN.
    - `rules: []` (0 sub-rules), parent matches: returns ABSTAIN.
    - `rules` with 1 sub-rule (deny), parent env matches, cmd matches: returns deny.
    - `rules` with 3 sub-rules (allow + ask + deny), all match: deny wins.
    - Multi-level: outer env → inner env → innermost deny: returns deny.
    - Multi-level: outer env matches, inner env does not match: inner abstains, outer catch-all ask fires.

12. **`src/test/load-config.test.ts` — unit tests for `buildFileScopedRule`**
    - Parent cwd condition matches, sub-rule path matches: returns sub-rule decision.
    - Parent cwd condition does not match: returns ABSTAIN.

13. **`src/test/load-config.test.ts` — unit test for `resolveEntryCwdPatterns` with `rules:`**
    - Entry with `cwd: "./src"` inside a `rules:` block is resolved to an absolute path.

14. **New smoke test: `e2e/bash/bash-rules-zero-subrules.yaml`**
    `aws` entry, env matches non-sandbox, `rules: []`. Expected: ask (no sub-rule decides, ABSTAIN bubbles to system default).

15. **New smoke test: `e2e/bash/bash-rules-one-subrule.yaml`**
    `aws` entry, env matches non-sandbox, `rules:` with a single `cmd: "* delete-*" decide: deny`. Command is `aws ec2 delete-instance`. Expected: deny.

16. **New smoke test: `e2e/bash/bash-rules-three-subrules.yaml`**
    `aws` entry, env matches non-sandbox, `rules:` with 3 sub-rules: `cmd: "s3 ls" decide: allow`, `cmd: "* describe-*" decide: allow`, `cmd: "* delete-*" decide: deny`. Command is `aws ec2 delete-vpc`. Expected: deny (deny wins over allows).

17. **New smoke test: `e2e/bash/bash-rules-multilevel.yaml`**
    Three-level nesting: outer env (non-sandbox profile) → inner env (specific region) → innermost `cmd: "* delete-*" decide: deny` plus catch-all `decide: ask`. Command matches all three levels. Expected: deny.

18. **New smoke test: `e2e/bash/bash-protecting-production-aws-rules-delete-deny.yaml`**
    Exact `rules:`-based pattern from `PROTECTING-PRODUCTION.md` AWS scoping section. Non-sandbox profile, `aws ec2 delete-vpc`. Expected: deny.

19. **New smoke test: `e2e/bash/bash-protecting-production-aws-rules-catch-all-ask.yaml`**
    Same config as above but command is `aws ec2 describe-instances` (no deny sub-rule matches). Expected: ask (catch-all sub-rule fires).

20. **New smoke test: `e2e/bash/bash-protecting-production-kubectl-rules-get-allow.yaml`**
    `rules:`-based kubectl pattern from `PROTECTING-PRODUCTION.md`. Non-sandbox context, `kubectl get pods --context prod`. Expected: allow.

21. **New smoke test: `e2e/bash/bash-protecting-production-kubectl-rules-delete-deny.yaml`**
    Same config, `kubectl delete pod mypod --context prod`. Expected: deny.

22. **New smoke test: `e2e/file/write-rules-path-deny.yaml`**
    `write:` entry with `cwd: /projects/production/**`, `rules:` containing `path: "**/*.env" decide: deny`. File is `/projects/production/app/.env`. Expected: deny.

23. **New smoke test: `e2e/file/write-rules-catch-all-ask.yaml`**
    Same config, file is `/projects/production/app/index.ts`. The `.env` deny doesn't match; catch-all `decide: ask` fires. Expected: ask.

24. **Verify documentation**
    - Confirm `docs/USER-DEFINED-RULES.md` nested-rules section examples are consistent with the implementation (field names, aggregation semantics, `rules` + `decide` mutual exclusion).
    - Confirm `docs/PROTECTING-PRODUCTION.md` AWS and kubectl scoping examples compile and produce correct decisions per the new smoke tests.

## Unit Tests

- `buildBashScopedRule`: parent conditions no-match → ABSTAIN
- `buildBashScopedRule`: 0 sub-rules, conditions match → ABSTAIN
- `buildBashScopedRule`: 1 sub-rule deny, conditions match → deny
- `buildBashScopedRule`: 3 sub-rules (allow + ask + deny), all match → deny
- `buildBashScopedRule`: multi-level nesting, innermost deny → deny
- `buildBashScopedRule`: multi-level nesting, inner env miss → catch-all ask at outer level
- `buildFileScopedRule`: parent cwd match + sub-rule path match → sub-rule decision
- `buildFileScopedRule`: parent cwd no-match → ABSTAIN
- `resolveEntryCwdPatterns`: `./`-relative cwd inside `rules:` sub-entry is resolved

## Smoke Tests

- `bash-rules-zero-subrules.yaml` — 0 sub-rules → ask
- `bash-rules-one-subrule.yaml` — 1 deny sub-rule → deny
- `bash-rules-three-subrules.yaml` — 3 sub-rules, deny wins
- `bash-rules-multilevel.yaml` — three-level nesting, innermost deny
- `bash-protecting-production-aws-rules-delete-deny.yaml` — PROTECTING-PRODUCTION AWS pattern, delete → deny
- `bash-protecting-production-aws-rules-catch-all-ask.yaml` — PROTECTING-PRODUCTION AWS pattern, describe → ask
- `bash-protecting-production-kubectl-rules-get-allow.yaml` — PROTECTING-PRODUCTION kubectl pattern, get → allow
- `bash-protecting-production-kubectl-rules-delete-deny.yaml` — PROTECTING-PRODUCTION kubectl pattern, delete → deny
- `write-rules-path-deny.yaml` — write `rules:` scoping, .env in production → deny
- `write-rules-catch-all-ask.yaml` — write `rules:` scoping, .ts in production → ask

## Verify

```
bun run typecheck          # no compile errors
bun test                   # all unit tests pass
bun run smoke              # all smoke tests pass (or equivalent e2e runner)
```

Manually confirm:
- A `rules: []` entry compiles without error and produces ABSTAIN.
- A three-level nested `rules:` compiles without error and the correct innermost decision propagates.
- `resolveRelativeCwdPatterns` correctly resolves `./`-relative paths inside `rules:` entries.

## Notes

- `rules:` and `decide:` are mutually exclusive in one entry; `rules:` takes precedence if both appear. The docs say "the parent block contributes no `decide` of its own".
- Sub-rules in `rules:` share the same `subcommandPath` and `cmdOffset` as the parent — the parent does not consume any positional arguments. Positional consumption only happens via subcommand keys (YAML object keys not in `KNOWN_FIELDS`).
- Multi-level `rules:` nesting is recursive: each sub-entry in a `rules:` list is itself compiled by `compileBashBinary` / `compileFileEntries`, so sub-entries can themselves have `rules:`.
- Strictest-wins within a `rules:` block is self-contained; the winning outcome then competes with other outer rules via the normal `runRules` aggregation in `interpret.ts`. No changes to `interpret.ts` are needed.
- `resolveEntryCwdPatterns` must explicitly recurse into `rules:` entries because `"rules"` is now in `KNOWN_FIELDS` and the existing subcommand-key loop skips it.
- The `IEntryValue` union already includes `IYamlEntry[]`, so no type-union change is needed beyond adding the named field.
