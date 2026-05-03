# Writing rules

Rules are declared in `.claude/permissions.yaml` in your project root, or `~/.claude/permissions.yaml` for user-global rules. Run `/reload-plugins` to pick up changes.

## Structure overview

The top-level keys are either **Bash binary names** (`rm`, `git`, `curl`) or **tool kinds** (`read`, `write`, `edit`, `multi_edit`, `webfetch`, `mcp`).

For binaries that take subcommands (e.g. `git`, `npm`), nest rules under the subcommand name. For binaries without subcommands (e.g. `rm`, `sudo`), put rules directly under the binary name.

A **rule** is an object with zero or more fields plus a `decide` field (`allow`, `deny`, or `ask`) and an optional `reason` string.

## Single rule vs list

You can write a single rule (object) or a list of rules for the same entry. Use a list when you need multiple rules at the same subcommand level.

Single rule:

```yaml
rm:
  decide: deny
  reason: rm is not allowed
```

List of rules:

```yaml
rm:
  - options:
      - r|recursive
      - f|force
    decide: deny
    reason: rm -rf is not allowed
  - options:
      - r|recursive
    decide: ask
    reason: Confirm before removing recursively
```

## Pattern matching

Every string value is pattern matched using one of the three following forms.

### Exact string

If the value contains no glob metacharacters and is not wrapped in `/`, it is matched literally.

### Globs

The default for values that contain metacharacters. Powered by [picomatch](https://www.npmjs.com/package/picomatch).

| Wildcard | Matches |
|---|---|
| `*` | Any sequence of characters within a single path segment (no `/`) |
| `**` | Any number of path segments (including none) |
| `?` | Any single character |
| `{a,b}` | Either `a` or `b` (alternation) |

Examples:
- `"**/.env*"` - any `.env` file at any depth
- `"src/**"` - anything under `src/`
- `"*.{ts,tsx}"` - any TypeScript file in the current directory

### Regular expressions

Wrap in `/` slashes. The content between the slashes is passed to `new RegExp(...)`.

Examples:
- `"/(http|ftp)://"` - matches either HTTP or FTP URLs
- `"/^[0-9]+$/"` - matches strings that are purely numeric

## Matching field values

All patterns in an array or list are AND'd together (except `<field>-in` fields - explained in a moment). A rule only matches if every pattern in the array matches.

A single value matches directly against the field:

```yaml
rm:
  cwd: /etc/**
  decide: deny
```

This example rule denies any `rm` command run from `/etc/` or any subdirectory beneath it.

For fields that can satisfy multiple patterns simultaneously, the array form requires all to match:

```yaml
rm:
  options: [r, f]
  decide: deny
```

Or equivalently in list form:

```yaml
rm:
  options:
    - r
    - f
  decide: deny
```

These example rules match only when both `-r` and `-f` are present.

The `-in` form switches any field to OR semantics. For `options-in`, the rule matches when any one of the listed flags is present:

```yaml
git:
  push:
    options-in:
      - force
      - force-with-lease
    decide: ask
    reason: Confirm force push
```

This asks for confirmation before any `git push --force` or `git push --force-with-lease`.

For single-value fields like `cwd` or `path`, use the `-in` form to match any one of a list of patterns:

```yaml
rm:
  cwd-in:
    - /etc/**
    - /usr/**
  decide: deny
```

This matches when the cwd is `/etc/` or `/usr/`, or any subdirectory beneath them.

See the [field form reference](#field-form-reference) at the end of this document for the full syntax table.

## Short and long flag forms

Use `|` in a flag name to match either the short or long form:

```yaml
rm:
  options:
    - r|recursive
  decide: deny
```

This matches both `-r` and `--recursive`. The same syntax works as an object key:

```yaml
rm:
  options:
    r|recursive: true
  decide: deny
```

## Matching multiple fields

All fields in a rule must match simultaneously (AND semantics). 

An example that matches the subcommand (`commit`) a particular argument (`m` or `message`) and the argument value (any string containing `wip`):

```yaml
git:
  commit:
    options:
      m|message: "/wip/"
    decide: deny
    reason: Don't commit with WIP messages
```

This example rule only matches when both the subcommand and the argument value matches, for example `git commit -m "just a bit of wip"` would be a match.

All fields in a rule are AND'd together. This example matches a subcommand, an argument value, an environment variable, and a working directory, all of which must match simultaneously:

```yaml
git:
  push:
    options:
      remote: origin
    env:
      CI: "true"
    cwd: /projects/**
    decide: deny
    reason: No pushes to origin from CI inside /projects
```

This matches only when `git push --remote origin` is called with `CI=true` set and the working directory is under `/projects/`.

## Positional argument matching

Use `pos` to match positional arguments (non-flag values on the command line). 

A single string matches the first positional argument:

```yaml
curl:
  pos: "https://*"
  decide: allow
```

You can also use a regex to match multiple values against the first positional argument:

```yaml
curl:
  pos: "/(http|ftp):/"
  decide: deny
  reason: Only HTTPS allowed
```

Use an array or list to match multiple positional arguments in order. Each pattern is tested against the argument at the same index:

```yaml
mv:
  pos:
    - "src/**"
    - "dist/**"
  decide: ask
  reason: Confirm moving files from src to dist
```

This matches when the first argument matches `src/**` and the second matches `dist/**`, for example `mv src/main.ts dist/main.ts`.

## Matching field values with OR

The `-in` form works for all fields. For positional arguments, `pos-in` matches when any positional argument matches any entry in the list:

```yaml
curl:
  pos-in:
    - http://*
    - ftp://*
  decide: deny
  reason: Only HTTPS allowed
```

For file paths, `path-in` matches when the path matches any entry:

```yaml
read:
  path-in:
    - "**/.env*"
    - "**/.netrc"
    - ~/.ssh/*
  decide: ask
  reason: Confirm before reading secrets
```

Or use glob alternation to match one value against one or more alternatives:

```yaml
read:
  path: "**/{.env*,.netrc,.ssh/*}"
  decide: ask
  reason: Confirm before reading secrets
```

## Matching one of mulitple rules

To match on any of several distinct cases, use a list of rules. The strictest matching decision wins across all rules that match (deny beats ask beats allow beats abstain):

```yaml
git:
  add:
    - pos: .
      decide: deny
      reason: Use specific files instead of git add .
    - cwd: /etc/**
      decide: deny
      reason: No staging files from /etc
```

## Subcommand matching

### Top-level binary (no subcommand)

Rules sit directly under the binary name:

```yaml
sudo:
  decide: deny
  reason: sudo is not allowed

curl:
  host: "*.internal.example.com"
  decide: allow
```

### Binary with subcommands

Rules nest one level deeper under the subcommand name:

```yaml
git:
  status:
    decide: allow
  log:
    decide: allow
  add:
    decide: ask
    reason: Confirm before staging
  push:
    decide: deny
    reason: Pushing is not allowed
```

### Binaries with multi-word subcommand paths

For commands like `docker compose build` where the subcommand is multiple words, nest keys as deep as needed. Each key level consumes one positional word from the command line:

```yaml
docker:
  compose:
    build:
      decide: ask
      reason: Confirm docker compose build
    up:
      decide: deny
      reason: docker compose up is not allowed
```

When a `pos` matcher appears inside a deeply-nested rule, it addresses the positional arguments that come after the subcommand path tokens. For example, in the rule above, `pos: "0"` would match the first argument after `docker compose build`, not `compose` or `build` themselves.

### Mixing subcommand rules and a flat rule for the same binary

Use a list when you need both subcommand-specific rules and a flat rule that applies at the same level. Each list item is discriminated independently: an item without a `decide` key is a subcommand entry; an item with a `decide` key is a flat rule for the current level.

```yaml
git:
  - push:
      decide: deny
      reason: Pushing is not allowed
  - add:
      decide: ask
  - decide: deny
    reason: No other git commands allowed
```

The last item has `decide` but no subcommand key, so it matches any `git` invocation not already matched by a subcommand entry above it.

This works at any nesting depth:

```yaml
docker:
  compose:
    - build:
        decide: ask
    - decide: deny
      reason: Only docker compose build is allowed
```

### npm example

```yaml
npm:
  install:
    decide: ask
    reason: Confirm before installing packages
  run:
    - build:
        decide: allow
    - test:
        decide: allow
    - lint:
        decide: allow
```

## File tool rules (read, write, edit, multi_edit)

These match against the file path using `path`:

```yaml
read:
  path: "**/.env*"
  decide: ask
  reason: Confirm before reading env files

write:
  path: "**/.env*"
  decide: deny
  reason: Env files are read-only

edit:
  path: src/**
  decide: allow
```

Use `path-in` to match any one of several paths:

```yaml
read:
  - path-in:
      - "**/.env*"
      - "**/.netrc"
      - "~/.ssh/*"
    decide: ask
    reason: Confirm before reading secrets
  - decide: allow
```

`multi_edit` works the same way as `edit`.

## WebFetch rules

Match on `host` or `host-in`. Multiple rules let you allow known hosts while unknown hosts fall through to the default `ask`:

```yaml
webfetch:
  host-in:
    - docs.anthropic.com
    - "*.github.com"
    - npmjs.com
  decide: allow
```

Glob hosts:

```yaml
webfetch:
  - host: "*.internal.corp"
    decide: deny
    reason: Internal hosts not accessible externally
  - host: docs.anthropic.com
    decide: allow
```

## MCP tool rules

Match on the tool part of the MCP tool name (`mcp__server__tool`):

```yaml
mcp:
  - tool: mcp__*__list_*
    decide: allow
  - tool: mcp__*__delete_*
    decide: deny
    reason: Delete operations not allowed
```

Use `tool-in` to allow or deny a specific set of tools:

```yaml
mcp:
  - tool-in:
      - mcp__github__create_issue
      - mcp__github__create_pull_request
    decide: ask
    reason: Confirm before creating GitHub resources
  - decide: allow
```

## Matching the working directory

The `cwd` field accepts any pattern form. 

In a `.claude/permissions.yaml` at your repo root, `cwd: ./**` means "anywhere within the current project":

```yaml
git:
  add:
    cwd: ./**
    decide: allow
  commit:
    cwd: ./**
    decide: allow
  push:
    cwd: ./**
    decide: ask
    reason: Confirm push from project directory
```

That example rule allows `git add` and `commit` within the project you are currenlty working in (and no other project on your computer). `git push` is set to always `ask`.

A glob matches any path under a directory:

```yaml
rm:
  cwd: /home/**
  decide: ask
  reason: Confirm before deleting from home directories
```

A regex can match patterns that globs cannot express:

```yaml
rm:
  cwd: /\/projects\/[^/]+-prod\//
  decide: deny
  reason: No deletions in production project directories
```

Use `cwd-in` to match any one of several directories:

```yaml
rm:
  cwd-in:
    - /etc/**
    - /usr/**
  decide: deny
  reason: No deleting from system directories
```

Use absolute globs for system-wide restrictions:

```yaml
rm:
  pos: /etc/**
  decide: deny
  reason: No deleting from /etc
```

## Decision values

| Field | Required | Description |
|---|---|---|
| `decide` | yes | If the rule matches the command, this field specifies the action to take. One of the "Decision" values below. |
| `reason` | no | Appears in the prompt shown to the user. |

| Decision | Precedence | Action |
|---|---|---|
| `deny` | 4 (strictest) | Block the command unconditionally. |
| `ask` | 3 | Pause and ask the user to confirm. |
| `allow` | 2 | Permit the command without prompting. |
| `abstain` | 1 (weakest) | The rule has no opinion. Useful for temporarily disabling a rule without removing it. |

## Strictest wins

When multiple rules match the same command, the strictest decision wins:

```
deny > ask > allow > abstain
```

A `deny` from any matching rule always wins. An `ask` wins over `allow`. This means you can safely add an `allow` catch-all at the end of a list without worrying that it will override a more specific `deny` above it:

```yaml
git:
  add:
    - pos: "."
      decide: deny
      reason: "use specific files"
    - decide: allow    # only matches when the deny above does NOT match
```

For more on how decisions aggregate across the AST when commands are chained with `&&`, `|`, or `;`, see [HOW_IT_WORKS.md](HOW_IT_WORKS.md).

## Field form reference

Every field follows this unified pattern:

| Form | Semantics | Applies to |
|---|---|---|
| `field: X` | Matches the field value against pattern X (exact string, glob, or `/regex/`) | all fields |
| `field: ["A", "B", "C"]` | AND: all patterns must match | multi-value fields only (`options`, `pos`) |
| `field:`<br>`  - A`<br>`  - B`<br>`  - C` | AND: all patterns must match (list form) | multi-value fields only (`options`, `pos`) |
| `field-in: ["A", "B", "C"]` | OR: any pattern must match | all fields |
| `field-in:`<br>`  - A`<br>`  - B`<br>`  - C` | OR: any pattern must match (list form) | all fields |

## Field reference

| Field | Type | Applies to | Behavior |
|---|---|---|---|
| `pos` | string | Bash | Matches `pos[0]` against the pattern. |
| `pos` | array | Bash | Each pattern matches `pos[index]` in order (AND). |
| `pos-in` | array | Bash | Matches when any positional argument matches any entry (OR). |
| `options` | array | Bash | All listed flags must be present (AND). |
| `options-in` | array | Bash | Any listed flag must be present (OR). |
| `options` | object | Bash | All key/value pairs must match (AND). |
| `cwd` | string | any | cwd matches the pattern. |
| `cwd-in` | array | any | cwd matches any pattern (OR). |
| `path` | string | read, write, edit, multi_edit | path matches the pattern. |
| `path-in` | array | read, write, edit, multi_edit | path matches any pattern (OR). |
| `env` | object | any | All key/value pairs must be present (AND). |
| `cwd_resolved` | boolean | any | When true, only matches when cwd is known to be accurate. When false, only matches when cwd tracking was broken by an unresolvable `cd`. Omit to match either. |
| `host` | string | webfetch | Exact or glob match against the URL host. |
| `host-in` | array | webfetch | Host matches any entry (OR). |
| `tool` | string | mcp | Glob match against the full tool name (e.g. `mcp__github__list_repos`). Use `mcp__*__list_*` to match all list operations across any server. |
| `tool-in` | array | mcp | Tool name matches any entry (OR). |
