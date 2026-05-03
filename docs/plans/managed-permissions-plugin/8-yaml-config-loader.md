# Step 8: YAML config loader

Implement `load-config.ts` - loads `.claude/permissions.yaml` from project and home directories, compiles each entry into a `Rule` function, and returns the combined list.

## Files to create

- `src/load-config.ts` - exports `loadConfigRules(): Rule[]`:
  - Reads `${HOME}/.claude/permissions.yaml` (skip silently if env var absent or file missing).
  - Reads `${CLAUDE_PROJECT_DIR}/.claude/permissions.yaml` (skip silently if env var absent or file missing).
  - Merges with project beating home on conflict: `{ ...home, ...project }` (shallow - same top-level key means project section fully replaces home section).
  - Compiles each YAML section + entry into a `Rule` closure via `compileBashBinary`, and analogues for `read`/`write`/`edit`/`multi_edit`/`webfetch`/`mcp`.
  - Each compiled closure gets a descriptive `.name` via `Object.defineProperty` (e.g. `yaml:rm:deny`).
  - Each section value (binary or subcommand) is normalised: a plain object is treated as a single-entry list; an array is used as-is.
  - Supports all matcher fields: `args` (list of flag names for flag-presence; string or list of strings for positional match; object for flag-value matching), `cwd` (single string or list), `cwd_resolved` (boolean: `true` matches only when `env.cwdResolved === true`; `false` matches only when `env.cwdResolved === false`; omitting the field matches regardless), `env`, `path`, `host`/`host-in`, `tool`. Subcommands are structural keys (nested under the binary key), not matcher fields; they may be nested arbitrarily deep (e.g. `docker: { compose: { build: { decide: ask } } }`). When compiling a deeply-nested entry, the accumulated subcommand path (e.g. `["compose", "build"]`) is checked against the elements of `node.pos` (as an array), and positional `args` string values in the rule are offset by the path length so they address the remaining positionals. Globs use `picomatch`. `args` list entries (flag presence) and `args` object keys (flag values) support `|` for aliases (e.g. `r|recursive`, `m|message`).
  - Loaded synchronously at module init (called once; result spread into the registry).

- `src/test/load-config.test.ts` - covers:
  - Merging project + home YAML (write fixtures to a tmp dir, set env vars, call `loadConfigRules`).
  - One representative compile case per matcher field type (flags, args, pos, subcommand, cwd glob, cwd_resolved boolean, env value glob, path, host).
  - Glob semantics: `cwd: "/etc/**"` matches `/etc/foo` but not `/etc`; `env: { NODE_ENV: "prod*" }` matches `production` but not `dev`.
  - `cwd_resolved: false` fires when `env.cwdResolved === false` and abstains when `env.cwdResolved === true`; `cwd_resolved: true` is the inverse; omitting the field matches both.
  - Catch-all (no matcher fields) fires on any node of the section's kind.
  - Section-mismatch: a `git:` rule abstains on a `Command` whose binary is `npm`.
  - `CLAUDE_PROJECT_DIR` absent → returns `[]`, no error.
  - `HOME` absent → user-global YAML skipped, returns `[]`.
  - File not found (env var set but file missing) → returns `[]`, no error.
  - Multi-level subcommand: `docker: { compose: { build: { decide: ask } } }` produces a rule that fires on `docker compose build`, abstains on `docker compose up`, and abstains on `docker build`.
  - List with mixed subcommand entries and catch-all: `git: [{ push: { decide: deny } }, { decide: ask }]` produces two rules -- the `push` entry fires only on `git push`; the `decide: ask` item is a flat rule that fires on any `git` command. Because of strictest-wins, `git push` gets `deny`.
  - List mixed at nested level: `docker: [{ compose: [{ build: { decide: ask } }, { decide: deny }] }, { decide: ask }]` -- the inner `decide: deny` fires on `docker compose <not-build>`; the outer `decide: ask` fires on `docker <not-compose>`.
  - Multi-level subcommand with positional `args`: `args: "src/*"` on a two-level subcommand rule matches `pos[2]`, not `pos[0]`.
  - `args` positional OR semantics: `args: ["http://*", "ftp://*"]` fires when `pos[0]` matches either pattern; abstains when `pos[0]` matches neither.

## Verification

Run `bun test` and confirm all config loader tests pass.

Run all tests and confirm they pass before marking this step complete.
