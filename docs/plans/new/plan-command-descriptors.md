# Command Descriptor YAML Files

## Overview

Introduce command descriptor files that define the argument semantics (flag arity, positional kinds) for shell commands. Descriptors are declared in YAML files placed by the user: global descriptors go under `~/.claude/permissions.d/commands/`, and project-level descriptors go under `.claude/permissions.d/commands/`. There are no built-in descriptors shipped with the plugin — if no descriptor exists for a command, all flags default to arity 0. Multiple commands per file, multiple files per layer. The parser looks up the descriptor for a command at parse time so it can correctly consume value-taking flag arguments without any inline config in rules.

## Examples

### Command descriptor file

A single file can describe any number of commands:

```yaml
# .claude/permissions.d/commands/search-tools.yaml

grep:
  description: Search file contents for patterns
  positionals:
    - kind: string
      description: Pattern to search for
    - kind: path
      description: Files to search
      variadic: true
  flags:
    f|file:
      arity: 1
      kind: path
      description: Read patterns from file
    e|regexp:
      arity: 1
      kind: string
      description: Match pattern
    m|max-count:
      arity: 1
      kind: string
      description: Stop after this many matches
    A|after-context:
      arity: 1
      kind: string
      description: Print lines of trailing context
    B|before-context:
      arity: 1
      kind: string
      description: Print lines of leading context
    C|context:
      arity: 1
      kind: string
      description: Print lines of output context

find:
  description: Search for files in a directory hierarchy
  positionals:
    - kind: path
      description: Directory to search
      variadic: true
  flags:
    maxdepth:
      arity: 1
      kind: string
      description: Descend at most this many levels
    mindepth:
      arity: 1
      kind: string
      description: Do not apply tests above this level
    name:
      arity: 1
      kind: string
      description: Match filename pattern
    path:
      arity: 1
      kind: string
      description: Match path pattern
    type:
      arity: 1
      kind: string
      description: File type filter
    exec:
      arity: 1
      kind: string
      description: Execute command on match
```

### Flag alias syntax and positional kinds

`r|recursive` declares both `-r` and `--recursive` as the same flag. Positionals use a fixed-index list; `variadic: true` on the last entry captures all remaining tokens of that kind:

```yaml
rm:
  description: Remove files or directories
  positionals:
    - kind: path
      description: Files or directories to remove
      variadic: true
  flags:
    r|recursive:
      arity: 0
      description: Remove directories and their contents recursively
    f|force:
      arity: 0
      description: Ignore nonexistent files, never prompt
    i|interactive:
      arity: 0
      description: Prompt before every removal

cut:
  description: Remove sections from lines of files
  positionals:
    - kind: path
      description: Input files
      variadic: true
  flags:
    d|delimiter:
      arity: 1
      kind: string
      description: Use this delimiter instead of tab
    f|fields:
      arity: 1
      kind: string
      description: Select only these fields
```

Flags absent from a descriptor default to arity 0 (boolean). Positionals absent from a descriptor default to `kind: string`. There is no need to list every flag -- only the value-taking ones matter for correct parsing.

### TypeScript interfaces

```typescript
// Arity 1 means the flag consumes the next token as its value; 0 means boolean
// kind indicates whether the consumed value is a path (subject to cmd rules) or an opaque string
// description is a human-readable summary of the flag's purpose
interface IFlagDescriptor {
    arity: 0 | 1;
    kind: "path" | "string";
    description: string;
}

// Describes one positional slot for a command
// kind: path means the token is subject to cmd rules; string means it is opaque
// variadic: true means this slot captures all remaining positional tokens (only valid on the last entry)
interface IPositionalDescriptor {
    kind: "path" | "string";
    description: string;
    variadic: boolean;
}

// description is a human-readable summary of the command
// positionals describes each positional slot in order; the last may be variadic
// flags keys are pipe-separated alias groups, e.g. "r|recursive"
interface ICommandDescriptor {
    description: string;
    positionals: IPositionalDescriptor[];
    flags: { [aliasGroup: string]: IFlagDescriptor };
}
```

## Steps

1. Add `IFlagDescriptor`, `IPositionalDescriptor`, and `ICommandDescriptor` to `src/types.ts` as shown above.

2. Write `src/load-commands.ts` with a `loadCommandDescriptors(projectDir: string)` function that:
   - Reads all `*.yaml` files from `~/.claude/permissions.d/commands/` (global user layer)
   - Merges in `.claude/permissions.d/commands/*.yaml` relative to `projectDir` (project layer, wins on conflict)
   - Expands pipe-separated alias groups (e.g. `r|recursive`) into individual flag lookups
   - Returns a `Map<string, ICommandDescriptor>` keyed by command name
   - Returns an empty map if neither directory exists (no built-in descriptors are shipped)

4. Thread the descriptor map through the parse/build-AST pipeline so `parseBash` (or `buildAst`) resolves flag arity from the descriptor when tokenising arguments.

   - Only `resolveFlagArity` is called from the parser. `resolvePositionalKind` is NOT called from the parser.
   - `ICommand` in `src/types.ts` does NOT get a `cmdKinds` field. Positional kind information stays in the descriptor and is never written to AST nodes.
   - The internal `IArgvResult` in `parse-bash.ts` does NOT get a `cmdKinds` field.

## Unit Tests

- `src/test/load-commands.test.ts`:
  - Pipe-separated alias `r|recursive` expands so both `-r` and `--recursive` resolve correctly
  - Project-layer descriptor wins over global-user layer on the same flag
  - Unknown command returns an empty descriptor (all flags arity 0, no positionals)
  - Description field is preserved on loaded descriptors for both commands and flags
  - `variadic: true` on the last positional is preserved correctly
  - Returns empty map when neither directory exists

- `src/test/build-ast.test.ts`:
  - `grep -f config.txt path` -- `-f` consumed as value flag (arity 1); `path` lands as a separate positional
  - `rm -r path` and `rm --recursive path` -- both resolve identically via alias expansion
  - Unknown command with unrecognised flag -- flag treated as arity 0, next token is a separate positional

## Smoke Tests

All e2e files listed here are new:

- `e2e/bash/bash-value-flags-arity-one-allow/test.yaml` -- `grep -f config.txt <path>` with a `cmd` rule and no inline flag config; built-in descriptor handles `-f` and the path matches, decision is allow.
- `e2e/bash/bash-cat-flag-before-path-allow/test.yaml` -- `cat -n <path>` with a `cmd` rule; `-n` is arity-0 so path is first positional and rule allows.
- `e2e/bash/bash-long-flag-alias-allow/test.yaml` -- `rm --recursive <path>` with a `cmd` rule; long-form alias resolves via descriptor, path is first positional and rule allows.
- `e2e/bash/bash-unknown-value-flag-ask/test.yaml` -- custom command with no descriptor and no rule; flags default to arity-0, rule does not match, decision is ask.
- `e2e/bash/bash-command-descriptor-user-override/test.yaml` -- descriptor in `.claude/permissions.d/commands/` overrides a built-in flag; correct arity is applied.

## Documentation

- `docs/CONFIGURATION.md` -- add a "Command Descriptors" section explaining the file format, flag alias syntax, layering order, and where to place files.
- `docs/PERMISSIONS-QUICKREF.md` -- add a short reference table for the descriptor YAML keys (`description`, `flags`, arity values).
- `docs/HOW_IT_WORKS.md` -- mention that the parser resolves flag arity from descriptors before building the AST.

## ~/tools descriptor files

Add command descriptor YAML files to `~/tools/config/home/.claude/permissions.d/commands/` for every command that has rules in the existing permissions files under `~/tools/config/home/.claude/permissions.d/`. The commands and their value-taking flags to cover:

- `kubectl` -- `context`, `n|namespace`, `o|output`, `l|selector`, `f|filename`, `field-selector`, `sort-by`, `chunk-size`, `replicas`, `image`, `container`, `port`, `timeout`, `as`, `as-group`
- `git` -- `C` (run as if started in directory), `m|message`, `b` (branch), `u` (upstream), `d` (delete), `f` (force/file)
- `gh` -- `repo`, `org`, `branch`, `base`, `head`, `limit`, `label`, `assignee`, `state`, `jq`, `template`, `json`, `job`, `log`
- `helm` -- `n|namespace`, `o|output`, `f|values`, `timeout`, `version`, `kube-context`, `kubeconfig`, `set`, `set-string`, `set-file`, `set-json`, `max-history`
- `grep` -- `e|regexp`, `f|file`, `m|max-count`, `A|after-context`, `B|before-context`, `C|context`
- `find` -- `maxdepth`, `mindepth`, `name`, `path`, `type`, `exec`
- `sed` -- `e|expression`, `f|file`
- `head` -- `n|lines`, `c|bytes`
- `tail` -- `n|lines`, `c|bytes`
- `jq` -- `n|null-input`, `e|exit-status` (arity 0); `f|from-file`, `L` (arity 1)
- `wc` -- all flags arity 0 (`l|lines`, `w|words`, `c|bytes`, `m|chars`)
- `cat` -- all flags arity 0 (`n|number`, `A|show-all`)
- `sort` -- `k|key`, `t|field-separator`, `o|output` (arity 1); `r|reverse`, `u|unique`, `n|numeric-sort` (arity 0)
- `bun` -- `filter`, `config` (arity 1)
- `tee` -- `a|append` (arity 0)

Each command gets its own file: `kubectl.yaml`, `git.yaml`, `gh.yaml`, `helm.yaml`, `grep.yaml`, `find.yaml`, `sed.yaml`, `head.yaml`, `tail.yaml`, `jq.yaml`, `wc.yaml`, `cat.yaml`, `sort.yaml`, `bun.yaml`, `tee.yaml`.

## Verify

- `bun run compile` passes with no errors.
- `bun run test` passes with no failures.
- `bun run smoke` passes with no failures.
- `grep -r "value-flags" src/` returns no results.

## Notes

- The layering order (global user < project) mirrors the permissions file layering, keeping the mental model consistent. There is no built-in layer — users are responsible for defining descriptors for any commands they care about.
- Flags not listed in any descriptor default to arity 0. This is the safe default -- an unlisted flag never accidentally consumes the next token as its value.
- Positional `kind` and flag `kind` fields are stored in the descriptor for future use (path-aware `cmd` matching). They are not currently written to the AST.
- The pipe alias syntax (`r|recursive`) is only for grouping short and long forms of the same flag. The parser expands aliases into a flat lookup map at load time.
- Backward compatibility is not required; there is no existing descriptor mechanism to preserve.
