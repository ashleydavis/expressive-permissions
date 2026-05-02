# Step 4: AST builder

Implement `buildAst`, which converts a raw `ToolCall` into the typed root `AstNode` that the interpreter and rules see.

## Files to create

- `src/build-ast.ts` — exports `buildAst(call: ToolCall): ToolRoot`. Switches on `call.tool_name`:
  - `"Bash"` → `{ kind: "bash", raw: command, child: parseBash(command) }`
  - `"Read"` → `{ kind: "read", file_path, offset, limit, raw }`
  - `"Write"` → `{ kind: "write", file_path, content, raw }`
  - `"Edit"` → `{ kind: "edit", file_path, old_string, new_string, replace_all, raw }`
  - `"MultiEdit"` → `{ kind: "multi_edit", file_path, edits, raw }`
  - everything else → `{ kind: "tool", tool_name, input: call.tool_input, raw }`
  - `raw` for non-Bash tools is a short stringification of the input used in explanation strings.

- `src/test/build-ast.test.ts` — covers:
  - `Bash` call → `bash` root with correct `raw` and `child` sub-AST.
  - `Read` call → `read` node with correct `file_path`, `offset`, `limit`.
  - `Write` call → `write` node with `file_path`, `content`.
  - `Edit` call → `edit` node with all four fields.
  - `MultiEdit` call → `multi_edit` node with `file_path` and `edits[]`.
  - `Grep` call → `tool` node with `tool_name: "Grep"` and `input`.
  - `mcp__github__list_repos` call → `tool` node with `tool_name` and `input`.

## Verification

Run `bun test` and confirm all AST builder tests pass.

Run all tests and confirm they pass before marking this step complete.

## Smoke-test upgrade

Replace the raw Bash-parser smoke tests with AST-builder smoke tests covering every `ToolRoot` variant.

### Note on interface gaps

Before the yaml examples will round-trip correctly, two interface fields must be added to `src/types.ts` as part of this step:

- `Read` needs `offset?: number` and `limit?: number` (sourced from `tool_input`)
- `Edit` needs `replace_all?: boolean` (sourced from `tool_input`)

`buildAst` should copy these optional fields from `tool_input` onto the node only when they are present in the input.

### New file: `scripts/check-ast-example.ts`

Mirrors the structure of `scripts/check-bash-example.ts` but imports `buildAst` from `src/build-ast` instead of `parseBash` from `src/parse-bash`.

YAML fixture format:

```yaml
tool_call:
  tool_name: <string>
  tool_input:
    <key>: <value>
    ...
ast:
  type: <expected ToolRoot type>
  ...
```

The script reads the fixture, calls `buildAst(toolCall)`, serialises both the actual and expected values with `stableJson`, and exits non-zero with a diff when they differ.

### New directory: `examples/ast/`

One YAML fixture per meaningful input variant. Each file round-trips through `buildAst` — the `tool_call` block is the input and `ast` is the expected `ToolRoot`.

#### Bash fixtures

**`bash-simple-ls.yaml`**
```yaml
tool_call:
  tool_name: Bash
  tool_input:
    command: "ls -la /tmp"
ast:
  type: bash
  raw: "ls -la /tmp"
  ast:
    type: command
    binary: ls
    args:
      l: true
      a: true
    pos: /tmp
    envPrefix: {}
    redirects: []
    raw: "ls -la /tmp"
```

**`bash-and.yaml`** — `cd /tmp && rm -rf *` — binop `&&` wrapping two commands (same tree as the existing `examples/bash/and-operator.yaml` but expressed as a `tool_call`)

**`bash-or.yaml`** — `test -f foo.txt || echo missing` — binop `||`

**`bash-pipe.yaml`** — `git status | grep modified` — binop `|`

**`bash-sequence.yaml`** — `echo a; echo b` — binop `;`

**`bash-env-prefix.yaml`** — `FOO=bar node index.js` — command with `envPrefix: {FOO: bar}`

**`bash-redirect-stdout.yaml`** — `cmd > out.log` — command with `redirects: [{op: ">", target: out.log}]`

**`bash-redirect-stderr.yaml`** — `cmd 2> err.txt` — command with `redirects: [{op: "2>", target: err.txt}]`

**`bash-empty.yaml`** — empty command string — bash root with `binary: ""`, empty `args`, `pos: []`, `envPrefix: {}`, `redirects: []`, `raw: ""`

**`bash-quoted-arg.yaml`** — `echo "hello world"` — command with `pos: hello world`

#### Read fixtures

**`read-basic.yaml`** — `file_path` only; expected `ast` has `type: read` and `file_path`

**`read-with-offset.yaml`** — `file_path` + `offset: 10`; expected `ast` includes `offset: 10`

**`read-with-limit.yaml`** — `file_path` + `limit: 50`; expected `ast` includes `limit: 50`

**`read-with-offset-and-limit.yaml`** — `file_path`, `offset: 5`, `limit: 100`; expected `ast` includes both

#### Write fixtures

**`write-basic.yaml`** — `file_path: /tmp/out.txt`, `content: "hello world"`

#### Edit fixtures

**`edit-basic.yaml`** — `file_path`, `old_string: "foo"`, `new_string: "bar"`; no `replace_all` field in expected `ast`

**`edit-replace-all.yaml`** — same plus `replace_all: true` in both input and expected `ast`

#### MultiEdit fixtures

**`multiedit-single.yaml`** — `file_path` with `edits` containing one entry (`old_string`, `new_string`)

**`multiedit-multiple.yaml`** — `file_path` with `edits` containing three entries; one entry includes `replace_all: true`

#### OtherTool fixtures

**`other-grep.yaml`**
```yaml
tool_call:
  tool_name: Grep
  tool_input:
    pattern: "TODO"
    path: /tmp
ast:
  type: other
  tool_name: Grep
  tool_input:
    pattern: "TODO"
    path: /tmp
```

**`other-mcp-github.yaml`** — `tool_name: mcp__github__list_repos`, `tool_input: {owner: octocat}`

**`other-agent.yaml`** — `tool_name: Agent`, `tool_input: {description: "test agent", prompt: "do stuff"}`

**`other-web-fetch.yaml`** — `tool_name: WebFetch`, `tool_input: {url: "https://example.com"}`

### Changes to `smoke-tests-bash-parser.sh`

- Change `EXAMPLES_DIR` to `$SCRIPT_DIR/examples/ast`
- Change `CHECK_SCRIPT` to `$SCRIPT_DIR/scripts/check-ast-example.ts`
- Update the "No example files found" message to reference `examples/ast`

### Verification

Run `./smoke-tests-bash-parser.sh` and confirm all fixtures pass (total should be 20, all passing).
