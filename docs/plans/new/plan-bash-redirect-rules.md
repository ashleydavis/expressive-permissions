# Bash Redirect Path Rules

## Overview

Shell redirects are currently stored as a `redirects` array on `ICommand`. Replace that with **`redirect` AST nodes** that connect a command to the file (or fd) it redirects to. Add YAML redirect path matchers so a handful of global rules can allow or deny reads/writes to specific directories (e.g. `/tmp/**` and `${{PROJECT_DIR}}/**`) for every command, without per-binary rules for `echo`, `tee`, `cat`, etc.

**Gate:** No code changes until Phase 1 documentation and examples are explicitly approved.

## AST shape

Remove `redirects` from `ICommand`. Each redirection becomes a `redirect` intermediate node:

```typescript
interface IRedirectNode {
    type: "redirect";
    op: string;       // ">", ">>", "<", "2>", "&>", "2>&", ...
    command: BashAstNode;
    target: string;   // file path, or fd number as string for merges (e.g. "1")
}
```

`redirect` is **not** a leaf (like `binop`). The inner `command` may still be a leaf. Multiple redirects on one command **nest outward**; the innermost `redirect` sits closest to the `command`.

### `echo foo > bar.txt`

```
redirect  op: >
├── command
│   └── echo foo
└── target: bar.txt
```

### `cat < in.txt`

```
redirect  op: <
├── command
│   └── cat
└── target: in.txt
```

### `cmd > out.log 2>&1`

```
redirect  op: 2>&
├── redirect  op: >
│   ├── command
│   │   └── cmd
│   └── target: out.log
└── target: 1
```

### `cd /tmp && echo hi > out.txt`

```
binop  op: &&
├── command
│   └── cd /tmp
└── redirect  op: >
    ├── command
    │   └── echo hi
    └── target: out.txt
```

**Fd merges** (`2>&1`, target `"1"`) are `redirect` nodes with a numeric target. Redirect path matchers ignore them; only file-path targets are checked.

## YAML shape (proposed)

### Matcher fields

| Direction | Shell operators | Matcher fields |
|---|---|---|
| **out** (write) | `>`, `>>`, `2>`, `&>` | `redirect-out`, `redirect-out-in` |
| **in** (read) | `<` | `redirect-in`, `redirect-in-in` |

| Field | Semantics |
|---|---|
| `redirect-out: "/tmp/**"` | The file target of an out-redirect must match the pattern |
| `redirect-out-in: [A, B]` | The file target must match **any** listed pattern (OR) |
| `redirect-in: "./data/**"` | The file target of an in-redirect must match the pattern |
| `redirect-in-in: [A, B]` | The file target must match **any** listed pattern (OR) |

When a redirect matcher field is present, **every** file-target `redirect` node of that direction on the command must match (AND across multiple redirects). Within `redirect-out-in` / `redirect-in-in`, any listed pattern may match each target (OR).

### Global `redirect:` section

```yaml
redirect:
  out:
    - redirect-out-in: ["/tmp/**", "${{PROJECT_DIR}}/**"]
      decide: allow
    - decide: ask
      reason: Shell write outside allowed dirs
  in:
    - redirect-in-in: ["/tmp/**", "${{PROJECT_DIR}}/**"]
      decide: allow
    - decide: ask
      reason: Shell read outside allowed dirs
```

### Per-binary fields under `bash:`

The same four matcher fields can appear on `bash:` rules. They apply when the rule's command binary matches the **inner** `command` leaf inside the `redirect` wrapper chain.

Redirect rules compose with per-binary `bash:` rules via strictest-wins aggregation up the AST tree (redirect node aggregates its inner command; outer compounds aggregate redirect subtrees).

Do **not** document `ICommand.redirects` in user-facing docs; describe redirect policy in terms of shell operators and file paths only.

## Steps

### Phase 1 — Documentation and examples (approval gate; no code)

Deliverables live under `docs/plans/new/` only. Do **not** touch `src/`, `examples/bash/`, `examples/ast/`, `plugin/`, or published docs until approval.

1. **Proposed documentation** — write draft sections for review:
   - `docs/plans/new/bash-redirect-configuration-proposed.md` — full redirect path rules section (global `redirect:` section, per-binary fields, matcher semantics, `not:` support, field reference entries)
   - `docs/plans/new/bash-redirect-quickref-proposed.md` — quick-reference summary and example policy block
   - After approval, copy the approved text into `docs/CONFIGURATION.md` and `docs/PERMISSIONS-QUICKREF.md`

2. **Proposed examples** — hand-authored fixtures under `docs/plans/new/bash-redirect-examples/`:
   - `bash/redirect-stdout-echo/` — `echo foo > bar.txt`
   - `bash/redirect-append/` — `echo foo >> bar.txt`
   - `bash/redirect-stdin/` — `cat < in.txt`
   - `bash/redirect-fd-merge/` — `cmd > out.log 2>&1`
   - `bash/redirect-and-binop/` — `cd /tmp && echo hi > out.txt`
   - Paired `ast/bash-redirect-*` fixtures (full tool-call AST)
   - `permissions-example.yaml` — sample global `redirect:` policy
   - Each directory: `index.yaml` (AST snapshot) + `index.md` (Mermaid diagram)
   - After approval, move into `examples/bash/` and `examples/ast/` and wire into `scripts/gen-examples.ts`

3. **Stop** — wait for explicit user approval of:
   - field names (`redirect-out`, `redirect-out-in`, `redirect-in`, `redirect-in-in`)
   - YAML shape (`redirect.out` / `redirect.in` top-level section)
   - matcher semantics (AND across redirects, OR within `-in` lists, fd merges ignored)
   - AST tree shape (nested `redirect` nodes, no `ICommand.redirects`)
   - proposed documentation text
   - proposed example fixtures

### Phase 2 — AST refactor (only after Phase 1 approval)

4. **`src/types.ts`** — Remove `IRedirect` and `ICommand.redirects`. Add `IRedirectNode` to `BashAstNode`. Add exported constants:
   - `REDIRECT_OUT_OPS`: `>`, `>>`, `2>`, `&>`
   - `REDIRECT_IN_OPS`: `<`
   - `isRedirectFdMerge(node: IRedirectNode): boolean` — true for `2>&` (and any redirect whose target is a single-digit fd)

5. **`src/parse-bash.ts`** — After parsing a `command` leaf, wrap it in nested `redirect` nodes (innermost closest to the command). Remove redirect collection into `ICommand.redirects`.

6. **`src/interpret.ts`** — Treat `redirect` as an intermediate node in `isLeaf` and `walkChildren`. Walk `node.command` with the parent env; aggregate the inner command's annotation with any rules that fire on the `redirect` node itself (initially none until Phase 3). Update `describeNode` for `redirect` nodes.

7. **Other walkers** — `src/pending-prompt-log.ts`, `src/build-ast.ts`, `src/analyze.ts`, and any other walkers: thread `redirect` the same way as `interpret`.

8. **Published docs** — apply approved Phase 1 documentation to `docs/CONFIGURATION.md` and `docs/PERMISSIONS-QUICKREF.md`.

9. **Gallery examples** — move approved fixtures from `docs/plans/new/bash-redirect-examples/` into `examples/bash/` and `examples/ast/`:
   - Extend `BASH_SPECS` in `scripts/gen-examples.ts`
   - Add `redirect` to `nodeLabel` (show `op` and `target`) and `childRefs` (edge label `command`)
   - Remove `redirects` from `command` labels
   - Run `bun run gen:examples`

10. **Tests** — update `src/test/parse-bash.test.ts` redirect expectations to nested `redirect` nodes; update test helpers that set `redirects: []` on commands.

11. **`bun run compile`** — rebuild `plugin/dist/*.js`.

### Phase 3 — Rule matching (only after Phase 2)

12. **`src/load-config.ts` — matcher helpers** — Add functions (export those needed by tests):
    - `resolveRedirectTarget(target: string, env: IEnvironment): string` — expand env-var references via `expandEnvVars`, then `resolve(env.cwd, ...)` for relative paths; leave absolute paths unchanged; expand leading `~` via `homePath`
    - `matchesRedirectPath(pattern: string, target: string, env: IEnvironment): boolean` — reuse path-aware semantics from `matchesCmdPattern`
    - `matchesRedirectTargets(patterns: string[], targets: string[], env: IEnvironment): boolean` — every target must match at least one pattern (AND across redirects, OR within `redirect-*-in`)
    - `collectRedirectFileTargets(root: BashAstNode, ops: Set<string>): string[]` — walk nested `redirect` nodes, collect resolved file targets for matching ops, skip fd merges
    - `matchesRedirectOut(entry: IYamlEntry, node: IRedirectNode, env: IEnvironment): boolean` — abstain when node op is not an out redirect; when `redirect-out` or `redirect-out-in` is set, require the node's file target to match
    - `matchesRedirectIn(entry: IYamlEntry, node: IRedirectNode, env: IEnvironment): boolean` — same for in-redirects

13. **`src/load-config.ts` — schema** — Extend `IYamlEntry` and `INotFields` with optional fields:
    - `redirect-out?: string`
    - `redirect-out-in?: string[]`
    - `redirect-in?: string`
    - `redirect-in-in?: string[]`
    Add all four keys to `KNOWN_FIELDS`.

14. **`src/load-config.ts` — bash rule integration** — In `buildBashRule` and `buildBashScopedRule`, redirect matcher fields apply when the rule's command binary matches the **inner** `command` inside a `redirect` wrapper. Call `matchesRedirectOut` / `matchesRedirectIn` against the relevant `redirect` node(s); return `ABSTAIN` when checks fail.

15. **`src/load-config.ts` — global redirect section** — Add `redirect?: { out?: IYamlEntry | IYamlEntry[]; in?: IYamlEntry | IYamlEntry[] }` to `IYamlConfig`. Add `redirect` to `KNOWN_SECTIONS`. Implement `buildRedirectRule(kind: "out" | "in", entry: IYamlEntry): IRule` that matches `redirect` nodes whose `op` is in the matching direction. Implement `compileRedirectSection` and wire into `compileConfig`. Rule names: `yaml:redirect:out:allow`, etc.

16. **`src/load-config.ts` — token expansion and path rewriting** — Extend `IExpandableFields`, `expandMatcherFields`, and add `resolveEntryRedirectPatterns` so redirect matcher fields support `${{PROJECT_DIR}}` / `${{HOME}}` tokens and `./`-prefixed path rewriting at load time.

17. **`src/load-config.ts` — validation** — Extend `validateConfig` and `validateEntry` for redirect fields in bash entries and `redirect.out` / `redirect.in` sections. Reject redirect fields on non-bash sections with a clear `IConfigError`.

18. **`src/load-config.ts` — not: support** — Extend `notFieldsAllMatch` to evaluate redirect matcher fields inside `not:` blocks for `redirect` nodes.

19. **`bun run compile`** — rebuild `plugin/dist/*.js`.

## Unit Tests

### Phase 2

- `parse-bash`: nested `redirect` nodes for `>`, `>>`, `<`, `2>`, `&>`, `2>&1`; plain commands have no `redirect` wrapper
- `interpret`: `redirect` walks inner `command`; strictest-wins bubbles through `redirect` to parent `binop`

### Phase 3

- `resolveRedirectTarget`: relative path resolved against `env.cwd`; absolute unchanged; `~` expanded; `$VAR` expanded when present in `env.env`
- `matchesRedirectPath`: glob, regex, and `./**` path-aware matching
- `matchesRedirectOut` / `matchesRedirectIn`: abstain on fd merges; single and nested redirect match; multiple file redirects require all to match
- `buildRedirectRule` / `compileRedirectSection`: global `redirect.out` allow for `/tmp/**`; deny beats allow; applies to `echo` and `tee` without per-binary rules
- `buildBashRule` with `redirect-out-in`: per-binary override under `bash.echo` matches wrapped command
- `not.redirect-out`: inverted match suppresses rule
- `validateConfig`: redirect fields rejected on `write:` section; accepted on `redirect.out`
- `expandEntryEnvTokens` / path rewriting: `${{PROJECT_DIR}}/**` expanded in `redirect-out-in`
- Regression: commands without redirects unchanged; existing bash rules still work on inner `command` leaves

Add tests in `src/test/parse-bash.test.ts`, `src/test/interpret.test.ts`, and `src/test/load-config.test.ts`.

## Smoke Tests (Phase 3)

Add e2e cases under `e2e/bash/` (YAML + harness only, no TypeScript smoke tests):

- `bash-redirect-out-tmp-allow` — `echo hi > /tmp/out.txt` with global `redirect.out` allow for `/tmp/**` → `allow`
- `bash-redirect-out-project-allow` — `echo hi > ./logs/out.txt` with `${{PROJECT_DIR}}/**` allow → `allow`
- `bash-redirect-out-outside-ask` — `echo hi > /etc/passwd` with allow for `/tmp/**` and `${{PROJECT_DIR}}/**` plus catch-all `ask` → `ask`
- `bash-redirect-out-deny-wins` — redirect to `/etc/**` deny rule above allow rule → `deny`
- `bash-redirect-in-project-allow` — `cat < ./file.txt` with `redirect.in` allow for `${{PROJECT_DIR}}/**` → `allow`
- `bash-redirect-applies-all-binaries` — same global `redirect.out` allow matches both `echo hi > /tmp/a` and `tee /tmp/b` without rules for those binaries
- `bash-redirect-fd-merge-ignored` — `cmd > /tmp/out 2>&1` matches on `/tmp/out` only; does not false-positive on fd target `1`

## Verify

### After Phase 1 (approval artifacts only)

- Proposed docs exist under `docs/plans/new/bash-redirect-configuration-proposed.md` and `docs/plans/new/bash-redirect-quickref-proposed.md`
- Proposed examples exist under `docs/plans/new/bash-redirect-examples/` with paired YAML and Mermaid
- No changes under `src/`, `examples/bash/`, `examples/ast/`, or published docs
- User has explicitly approved field names, YAML shape, semantics, AST tree shape, docs, and examples

### After Phase 2 (AST refactor)

- `ICommand` has no `redirects` field; `IRedirectNode` is in `BashAstNode`
- Approved documentation applied to `docs/CONFIGURATION.md` and `docs/PERMISSIONS-QUICKREF.md`
- Approved examples live in `examples/bash/` and `examples/ast/`
- `bun run compile` and `bun run test` pass (parser/interpret updates only; no redirect rule matching yet)
- `bun run gen:examples` completes; redirect examples show nested `redirect` nodes

### After Phase 3 (rule matching)

- `bun run compile` passes with no errors
- `bun run test` passes with no failures
- `bun run smoke` passes with no failures
- `bun run gen:examples` still regenerates cleanly

## Notes

- **In scope**: AST refactor (`types.ts`, `parse-bash.ts`, `interpret.ts`, walkers), unit tests, smoke tests (`e2e/bash/bash-redirect-*`), gallery examples, and `load-config.ts` rule matching as listed above.
- **Security semantics**: When a redirect matcher field is present, every file-target `redirect` node of that direction on the command must match (AND across multiple redirects). Within `redirect-out-in`, any listed pattern may match each target (OR). A command with both `> /tmp/a` and `> /etc/b` must not match an allow rule scoped to `/tmp/**` alone.
- **Fd merges**: `2>&1` and similar are `redirect` nodes with numeric targets; skip them in path collection and rule matching.
- **Unexpanded targets**: Redirect targets containing `$VAR` or `$(...)` are resolved where possible; unresolvable `$VAR` references should fail to match path patterns (same posture as `cmd` env expansion).
- **Substitutions**: Inner commands from `$(...)` in redirect targets are evaluated via `node.substitutions` on the inner `command` leaf; no new substitution handling beyond existing behavior.
- **Docs-first gate**: Phase 2 must not start until the user approves Phase 1. Phase 3 must not start until Phase 2 is complete. Implementation must match the approved docs exactly.
