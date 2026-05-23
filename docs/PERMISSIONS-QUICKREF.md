# Permissions Quick Reference

Rules live in `.claude/permissions.yaml` (project) or `~/.claude/permissions.yaml` (global). You can also split rules across `.claude/permissions.d/*.yaml` (or `~/.claude/permissions.d/*.yaml`) — each drop-in file is loaded as its own layer; deny in any file wins. Run `/reload-plugins` after edits.

---

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

Any rule section can be written as a list to apply multiple rules in order:

```yaml
write:
  - path-in: ["**/.env*", "~/.ssh/*"]
    decide: deny
  - decide: allow   # catch-all
```

List form can also be used under nested rules:

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

---

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

---

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
| `cwd: ${{PROJECT_DIR}}/**` | cwd matches pattern; `${{PROJECT_DIR}}/**` = anywhere inside this project |
| `cwd-in: [/etc/**, /usr/**]` | cwd matches any entry; OR |
| `file: {"~/.kube/config": true}` | File exists |
| `file: {"~/.kube/config": {contains: "current-context: sandbox"}}` | File exists and contains pattern |

## not:

`not:` inverts any combination of fields and works in any rule type. The example below denies all `aws` commands when `AWS_PROFILE` is anything other than `sandbox`:

```yaml
bash:
  aws:
    - not:
        env:
          AWS_PROFILE: sandbox
      decide: deny
      reason: Blocked outside sandbox
```

---

## File tools (read, write, edit, multi_edit)

Fields: `path` (single pattern) or `path-in` (OR list). All other fields (`cwd`, `env`, `not`, etc.) also apply.

```yaml
read:
  path: "**/.env*"
  decide: ask

write:
  - path-in: ["**/.env*", "~/.ssh/*"]
    decide: deny
  - decide: allow   # catch-all
```

---

## WebFetch

Fields: `host` (single pattern) or `host-in` (OR list).

```yaml
webfetch:
  - host-in: [docs.anthropic.com, "*.github.com"]
    decide: allow
  - decide: ask
```

---

## Tool-name rules

The YAML key is a glob matched against the Claude Code tool name. Quote keys containing glob chars. Use `tool-in` to list exact names under a readable label:

```yaml
ToolSearch:
  decide: allow

"mcp__*__delete_*":
  decide: deny

github-writes:
  tool-in: [mcp__github__create_issue, mcp__github__create_pull_request]
  decide: ask
```

---

## Nested rules

`rules:` groups sub-rules under shared parent conditions. The parent needs no `decide` -- it is a pure filter:

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

---

## Troubleshooting

- `NOMATCH` in `.claude/permissions-log/` -- no rule matched; add one.
- All fields AND'd -- one mismatch makes the whole rule abstain.
- A rule under `git:` does not match `git push` -- nest under the subcommand key.
- Regex must be wrapped in `/` slashes; bare string = literal match.
