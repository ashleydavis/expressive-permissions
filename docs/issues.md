# Issues

Known design and implementation problems. Add one section per issue; list affected examples under each.

---

## Command substitutions use a sidecar field instead of AST nodes

Backtick and `$(...)` substitutions are not represented as proper intermediate nodes (unlike `redirect`). The outer `command` keeps the substitution as literal text in `cmd`, and inner commands are attached on `substitutions[]` on the same leaf.

For `echo $(whoami)` the tree should be three levels deep: a `command` node for `echo`, a child substitution node for `$(whoami)`, and a child `command` node for `whoami` inside that substitution. The mermaid diagrams in the affected examples already show this shape, but the YAML does not: `cmd` still holds the literal `$(whoami)` string and `whoami` is parked on a sibling `substitutions[]` array instead of nesting under a substitution node.

**Recommended fix:** Add a proper substitution AST node (like `redirect`) and put the inner command tree under it, instead of keeping backticks or `$(...)` as literal text in `cmd` with a sidecar `substitutions` array on the same leaf.

Illustrative target shape for `echo $(whoami)`:

```yaml
type: command
binary: echo
options: {}
cmd: []   # or a structured word list; not the literal "$(whoami)"
envPrefix: {}
raw: "echo $(whoami)"
substitution:          # new node type, analogous to redirect.command
  type: substitution   # or command_substitution
  raw: "$(whoami)"
  command:
    type: command
    binary: whoami
    options: {}
    cmd: []
    envPrefix: {}
    raw: "whoami"
```

Same hierarchy applies to backtick form (`rm \`cat list\``: `rm` command → backtick substitution node → `cat` command).

**Affected examples:**

- `examples/ast/backtick-substitution/`
- `examples/ast/command-substitution/`

---

## AST child fields are ad hoc per node type

Each node type exposes children on differently named fields (`left`/`right`, `ast`, `body`, `child`, `condition`, `thenBranch`, `clauses`, `substitutions`, and so on). Walkers must special-case every type to find and recurse into children.

**Recommended fix:** Refactor every AST node so child references live under a single `children` object. Named children use their role as the key (e.g. `left`, `right`, `body`, `condition`). When a node has only a positional list of children, store them under `children._` as an array.

Example shapes (illustrative):

```yaml
# binop: named children
type: binop
op: "&&"
children:
  left: { ... }
  right: { ... }

# case_statement: positional children under _
type: case_statement
word: foo
children:
  _: [ { type: command, ... }, { type: command, ... } ]
```

A generic visitor can then walk any node by iterating `children` keys (and recursing into `children._` when present) instead of maintaining a separate dispatch table per node type.

**Affected:** entire AST representation (`src/types.ts`, `src/build-ast.ts`, all walkers and interpreters, all `examples/ast/`).

---

## File-tool paths are flat fields, not AST child nodes

For Read, Write, Edit, and MultiEdit tool calls, `file_path` is a scalar field on the tool root node (e.g. `type: edit` with `file_path: /tmp/foo.ts`). Rules in `write:`, `edit:`, and similar sections match only when the walker is at that root and inspect `node.file_path` directly.

Bash shell writes work differently. Each redirect is an intermediate `redirect` node with a `target` field; `redirect.out` rules fire during tree traversal on those nodes, independent of the inner `command` binary. That gives granular, path-centric policy for shell file writes without a separate `bash:` rule per command.

If file-tool targets were represented as child AST nodes (analogous to `redirect` wrapping a command with a `target`), the same walk-and-match model could apply to Edit, Write, and MultiEdit. A unified "writes to files" policy could cover both `redirect.out` targets and file-tool paths in one place, with path rules evaluated at the target node during traversal instead of only at the tool root.

Illustrative target shape for `Edit` on `/tmp/foo.ts`:

```yaml
type: file_write          # new intermediate node, analogous to redirect
path: /tmp/foo.ts
operation:
  type: edit
  old_string: foo
  new_string: bar
```

Read tools could use a sibling `file_read` node with the same `path` field for symmetry.

**Recommended fix:** Introduce intermediate file-target AST nodes (`file_write`, `file_read`, or similar) that hold the resolved path and wrap the operation-specific payload. Teach walkers and YAML matchers to evaluate path rules on those nodes the way `redirect.out` / `redirect.in` work today.

**Affected examples:**

- `examples/ast/edit-basic/`
- `examples/ast/edit-replace-all/`
- `examples/ast/write-basic/`
- `examples/ast/multiedit-single/`
- `examples/ast/multiedit-multiple/`
- `examples/ast/read-basic/` (and other read examples, for symmetry)

---

## Standalone env assignments reuse an empty command node

A bare `FOO=bar` assignment is represented as a `command` node with `binary: ""`, empty `cmd`, and the vars parked on `envPrefix`. That overloads the command leaf: it is not a command at all, and walkers must special-case `binary === ""` to distinguish standalone assignment from `FOO=bar cmd` (where the same `envPrefix` field means something different semantically).

**Recommended fix:** Introduce a dedicated env-assignment AST node (e.g. `env_set` or `env_assignment`) that holds the variable map. Any command scoped by those vars becomes a child of that node instead of carrying `envPrefix` on the command leaf.

Illustrative target shapes:

```yaml
# standalone: FOO=bar
type: env_set
vars:
  FOO: "bar"
raw: "FOO=bar"

# prefix: FOO=bar cmd
type: env_set
vars:
  FOO: "bar"
raw: "FOO=bar cmd"
child:
  type: command
  binary: cmd
  options: {}
  cmd: []
  raw: "cmd"
```

For `FOO=bar && cmd`, the env-set node would be the left child of the `binop`; the right `cmd` command would not inherit `FOO` unless the shell semantics thread env through the sequence (today `envSetRule` updates env for subsequent siblings in a sequence).

Built-in rules `envSetRule` and `envPrefixRule` would move to match and walk the new node type instead of inspecting empty commands.

**Affected examples:**

- `examples/ast/env-assignment/`
- `examples/ast/env-prefix/`
- `examples/ast/multi-env-prefix/`
- (and any example where `envPrefix` appears on a `command` node)
