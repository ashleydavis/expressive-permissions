# Permissions Quick Reference

This doc is a concise reference for the permissions rule format.

Rules live in `.claude/permissions.yaml` (project) or `~/.claude/permissions.yaml` (global). You can also split rules across `.claude/permissions.d/*.yaml` / `*.yml` (or the same under `~/`). Configuration is reloaded automatically on the next hook run.

## Rule load order

1. Built-ins (`cd`, `export`, empty-command, env-prefix handling)
2. `~/.claude/permissions.yaml` → `~/.claude/permissions.d/*` (alphabetical)
3. `.claude/permissions.yaml` → `.claude/permissions.d/*` (alphabetical)

All matching rules combine with **strictest wins**. A `deny` short-circuits remaining rules at that node, so an earlier-layer deny beats a later-layer allow.


## Decisions

`decide: allow | ask | deny | abstain` -- strictest wins: `deny > ask > allow > abstain`

- Add `reason: "..."` optionally to explain the decision to the user.
- A rule with **no match fields** is a catch-all -- matches everything at that level.

## Patterns

- Exact string: `main`
- Glob: `src/**`, `*.{ts,tsx}`, `**/.env*` -- `*` = one segment, `**` = any depth
- Regex: `"/^(?!prod)/"` -- wrap in `/` slashes
- Quote YAML values that start with `*` or contain `:`

## AND vs OR

- `field: [A, B]` -- AND, all must match (`options` and `cmd` only)
- `field-in: [A, B]` -- OR, any must match (works on every field)

## List form

`bash`, `read` / `write` / `edit` / `multi_edit`, and `redirect.out` / `redirect.in` accept a list of rules. `webfetch`, `Grep`, and generic tool keys are a single object (not a list).

```yaml
write:
  - path-in: ["**/.env*", "~/.ssh/*"]
    decide: deny
  - decide: allow   # catch-all
```

Under bash, list form also works at the command or subcommand level:

```yaml
bash:
  git:
    - push:
        decide: deny
    - add:
        decide: ask
    - decide: deny    # catch-all: matches any git command not matched above
      reason: No other git commands
```


## Command descriptors

Place YAML files in `~/.claude/permissions.d/commands/<command>.yaml` (global) or `.claude/permissions.d/commands/<command>.yaml` (project). The project layer wins on conflict. Without a descriptor, all flags default to arity 0 (boolean) and no positionals are typed as paths.

```yaml
# .claude/permissions.d/commands/kubectl.yaml
kubectl:
  description: Kubernetes CLI
  flags:
    context:
      arity: 1      # consumes next token as value
      kind: string
    n|namespace:
      arity: 1
      kind: string
  positionals:
    - kind: string   # first positional (subcommand)
    - kind: path
      variadic: true # remaining positionals are paths
```

Flag `arity: 1` means the flag takes a value; `arity: 0` means it is boolean. Use `short|long` to declare both forms together.


## Bash

Keys nest: `bash` > command > subcommand. Each rule level consumes one positional word from the command line. `cmd` inside a nested rule addresses args **after** the subcommand word.

```yaml
bash:
  sudo:
    decide: deny

  git:
    status: { decide: allow }
    push:
      decide: ask
      reason: Confirm push

  docker:
    compose:
      build:
        decide: ask   # cmd here matches args after "build", not "compose" or "build"
```

### Bash fields

All fields in a rule are AND'd.

| Field | Semantics |
|---|---|
| `cmd: "src/** dist/**"` | Positional args matched by index; space-separated or array; AND |
| `cmd-in: [A, B]` | Any positional arg matches any entry; OR |
| `options: [r\|recursive, f\|force]` | All flags present; `x\|long` matches either short or long form; AND |
| `options-in: [force, force-with-lease]` | Any flag present; OR |
| `options: {m\|message: "/wip/"}` | Flag with specific value |
| `env: {CI: "true"}` | All env vars match; AND |
| `cwd: ${{PROJECT_DIR}}/**` | cwd matches pattern; `${{PROJECT_DIR}}` and `${{HOME}}` expand when set |
| `path: ...` | Synonym for `cwd` on bash entries |
| `cwd-in: [/etc/**, /usr/**]` | cwd matches any entry; OR |
| `file: {"~/.kube/config": true}` | File exists |
| `file: {"~/.kube/config": {contains: "current-context: sandbox"}}` | File exists and contains pattern |


## Redirect path rules

Shell redirects write to or read from file paths. Match those paths globally without a separate rule for each command (`echo`, `tee`, `cat`, and similar).

```yaml
redirect:
  out:   # >, >>, 2>, &>
    - path-in: ["/tmp/**", "${{PROJECT_DIR}}/**"]
      decide: allow
    - decide: ask
      reason: Shell write outside allowed dirs
  in:    # <
    - path-in: ["/tmp/**", "${{PROJECT_DIR}}/**"]
      decide: allow
    - decide: ask
      reason: Shell read outside allowed dirs
```

- **`path` / `path-in`** under `redirect.out` or `redirect.in` only
- **First match wins** within each of `redirect.out` / `redirect.in` (list order matters; unlike bash strictest-wins)
- **AND across redirects:** every file-target redirect of that direction must match for an entry to fire
- **Fd merges** (`2>&1`) are ignored by path matchers
- **`bash:`** matches the inner `command` node only (not redirect targets); use `redirect.out` / `redirect.in` for redirect paths

## not:

`not:` is a bash-only field. It inverts matcher fields on that bash entry. The example below denies all `aws` commands when `AWS_PROFILE` is anything other than `sandbox`:

```yaml
bash:
  aws:
    - not:
        env:
          AWS_PROFILE: sandbox
      decide: deny
      reason: Blocked outside sandbox
```


## File tools (read, write, edit, multi_edit)

Fields: `path` / `path-in`, optional `cwd`, `decide`, `reason`, and nested `rules:` (parent may carry `cwd`). No `env` or `not:` on file-tool entries.

```yaml
read:
  path: "**/.env*"
  decide: ask

write:
  - path-in: ["**/.env*", "~/.ssh/*"]
    decide: deny
  - decide: allow   # catch-all
```


## WebFetch

Single object with optional `host` / `host-in`, plus `decide` and optional `reason`. Not a list. Omit both host fields to match every WebFetch URL.

```yaml
webfetch:
  host-in: [docs.anthropic.com, "*.github.com"]
  decide: allow
```


## Grep

Single object with `decide` and optional `reason`. Matches every Grep tool call (no path/cwd matchers).

```yaml
Grep:
  decide: allow
```


## Generic tool rules

Top-level keys that are not recognised sections are matched against the Claude Code tool name. Quote keys containing glob chars. Use `tool` or `tool-in` when the key is only a label. Single object only (not a list).

```yaml
ToolSearch:
  decide: allow

"mcp__*__delete_*":
  decide: deny

github-writes:
  tool-in: [mcp__github__create_issue, mcp__github__create_pull_request]
  decide: ask
```


## Nested rules

On bash entries, `rules:` groups sub-rules under shared parent conditions. The parent needs no `decide` -- it is a pure filter:

```yaml
bash:
  aws:
    - env:
        AWS_PROFILE: /^(?!sandbox$)/
      rules:
        - cmd: "* delete-*"
          decide: deny
        - decide: ask
          reason: Confirm on non-sandbox profile
```


## Troubleshooting

- `NOMATCH` in `.claude/permissions-log/` -- no rule matched; add one.
- All fields AND'd -- one mismatch makes the whole rule abstain.
- A rule under `git:` does not match `git push` -- nest under the subcommand key.
- Regex must be wrapped in `/` slashes; bare string = literal match.
