# xargs Built-in Rule and AST Node

## Overview

Add first-class `xargs` support to the permissions engine. `xargs` is treated as an intermediate
AST node (like `BinOp` or `for_loop`) whose single child is the parsed subcommand that xargs will
invoke. The decision for an `xargs` node is entirely driven by whether the subcommand is allowed --
YAML rules match the child `Command` as usual, and the result bubbles up through the `xargs` node.
A built-in `xargsRule` is registered (always abstains) to make the intent explicit and serve as an
extension point, matching the pattern of `cdRule` and peers.

## Issues

_(populated by plan:check)_

## Steps

### 1. Export `IToken` and `lex` from `src/parse-bash.ts`

- Change `interface IToken` to `export interface IToken`.
- Change `function lex(input: string): IToken[]` to `export function lex(input: string): IToken[]`.
- No other changes to this file.

### 2. Add `IXargsNode` to `src/types.ts`

Insert a new interface directly after `ForLoop`:

```typescript
// An intermediate node representing an xargs invocation. The child is the parsed subcommand
// that xargs will invoke; its decision bubbles up to become the decision of this node.
export interface IXargsNode {
    // Discriminator for the xargs node type
    type: "xargs";
    // Options that belong to xargs itself (not to the subcommand), e.g. { n: "1", I: "{}" }
    options: Record<string, string | boolean>;
    // The parsed subcommand Command that xargs will run
    child: Command;
    // The original raw command string including the xargs binary and all arguments
    raw: string;
}
```

Update `BashAstNode`:

```typescript
export type BashAstNode = Command | BinOp | ForLoop | IXargsNode;
```

(`AstNode = ToolRoot | BashAstNode` already includes `IXargsNode` transitively -- no change needed.)

### 3. Add xargs parsing and transformation to `src/build-ast.ts`

Add imports: `IToken, IXargsNode` from `"./types"` and `lex, parseBash` from `"./parse-bash"`.
(`parseBash` is already imported via `parse-bash`; check existing import and extend it.)

Add two constants before the existing functions:

- `XARGS_VALUE_FLAGS: Set<string>` -- single-character xargs flags that consume the next token as
  their value: `n`, `P`, `I`, `i`, `L`, `l`, `s`, `a`, `d`, `E`, `e`.
- `XARGS_VALUE_LONG_FLAGS: Set<string>` -- long xargs option names (without `--`) that consume the
  next token as their value: `max-args`, `max-procs`, `replace`, `max-lines`, `max-chars`,
  `arg-file`, `delimiter`, `eof`.

Add interface `IXargsParseResult`:

```typescript
// Result of parseXargsCommand: the xargs-specific options and the parsed subcommand child.
interface IXargsParseResult {
    // Options consumed by xargs itself
    options: Record<string, string | boolean>;
    // The subcommand Command to be evaluated for permissions
    child: Command;
}
```

Add function `parseXargsCommand(raw: string): IXargsParseResult`:

1. Call `lex(raw)` to obtain a flat `IToken[]`.
2. Skip index 0 (the `xargs` binary word token).
3. Walk tokens while `tokens[index].kind === "word"`:
   - If token value is `"--"`: advance index past it and break.
   - If token value does not start with `"-"`: break (subcommand start found).
   - If token starts with `"--"`:
     - If contains `"="`: extract key/value from the long option (self-contained), advance 1.
     - Else if long name is in `XARGS_VALUE_LONG_FLAGS`: record `options[longName] = nextTokenValue`,
       advance 2.
     - Else: record `options[longName] = true`, advance 1.
   - If token starts with `"-"` (short option, `rest = token.substring(1)`):
     - If `rest[0]` is in `XARGS_VALUE_FLAGS`:
       - If `rest.length > 1` (value attached, e.g. `-I{}` or `-n1`): record
         `options[rest[0]] = rest.substring(1)`, advance 1.
       - Else (value separate, e.g. `-n 1`): record `options[rest] = nextTokenValue`, advance 2.
     - Else (boolean flags, possibly bundled like `-0t`): record each char as `true`, advance 1.
4. After the options loop, skip any `op`-kind tokens (redirections before the subcommand, e.g.
   `2>/dev/null`): for each op token, also skip the following word token (redirect target).
5. If no tokens remain: return `{ options, child: emptyCommand }` where `emptyCommand` is
   `{ type: "command", binary: "", options: {}, cmd: [], envPrefix: {}, redirects: [], raw: "" }`.
6. Otherwise: `subcmdStart = tokens[index].start`, `subcmdRaw = raw.substring(subcmdStart)`,
   call `parseBash(subcmdRaw)`. If the result is a `Command`, return `{ options, child: result }`.
   If not a `Command` (unexpected), return `{ options, child: emptyCommand }`.

Add function `transformXargsNodes(node: BashAstNode): BashAstNode`:

- If `node.type === "command"` and `node.binary === "xargs"`:
  - Call `parseXargsCommand(node.raw)` to get `{ options, child }`.
  - Return `IXargsNode { type: "xargs", options, child, raw: node.raw }`.
- If `node.type === "command"` and `node.binary !== "xargs"`: return `node` unchanged.
- If `node.type === "binop"`: return a spread copy with `left: transformXargsNodes(node.left)`
  and `right: transformXargsNodes(node.right)`.
- If `node.type === "for_loop"`: return a spread copy with `body: transformXargsNodes(node.body)`.
- Otherwise (already `IXargsNode`): return `node` unchanged.

Update `buildAst`, case `"Bash"`: wrap the result of `parseBash(command)` with
`transformXargsNodes(...)` before assigning to `ast`.

Update `describeNode`: add a `case "xargs": return node.raw;` branch to the switch.

### 4. Update `src/interpret.ts`

**`isLeaf`**: add `&& node.type !== "xargs"` to the condition so xargs nodes are treated as
intermediate (non-leaf).

**`walkChildren`**: add a new branch before the BinOp fallthrough:

```typescript
if (node.type === "xargs") {
    const childResult = interpret(node.child, env, call, logger, registry);
    return {
        childAnnotations: [childResult.annotation],
        envOut: childResult.envOut,
    };
}
```

No other changes to this file.

### 5. Create `src/rules/builtin/xargs.ts`

Create a new file containing `xargsRule: Rule`. The rule:
- Returns `ABSTAIN` for any node whose type is not `"xargs"`.
- Returns `ABSTAIN` for `IXargsNode` nodes (always abstains; the child decision propagates via
  `combine`).
- Imports: `AstNode`, `Environment`, `Rule`, `RuleOutcome`, `ToolCall`, `ABSTAIN` from
  `"../../types"`.

### 6. Register `xargsRule` in `src/rules/index.ts`

- Add `import { xargsRule } from "./builtin/xargs";`.
- Append `xargsRule` to the `builtinRules` array.

### 7. Create `src/test/rules/builtin/xargs.test.ts`

Unit tests for `xargsRule`:

- Non-xargs node types (`read`, `bash`, `command` with different binary) all return abstain with
  no env update.
- An `IXargsNode` node returns abstain.
- Decision is always abstain regardless of the child Command's contents.
- No `env` field is set in the returned `RuleOutcome`.

### 8. Create `src/test/build-ast-xargs.test.ts`

Unit tests for xargs AST shape via `buildAst` (Bash tool calls):

- `"xargs grep -l \"pattern\""` -- xargs Command at top of AST becomes an `IXargsNode` with
  `child.binary === "grep"`.
- `"xargs -n 1 rm"` -- `IXargsNode` with `child.binary === "rm"` and `options.n === "1"`.
- `"xargs -I{} cp {} /dest"` -- `IXargsNode` with `child.binary === "cp"` and
  `options.I === "{}"`.
- `"xargs"` (no subcommand) -- `IXargsNode` with `child.binary === ""`.
- `"find . | xargs rm"` -- `BinOp` with `right` being an `IXargsNode` whose `child.binary === "rm"`.
- `"xargs grep -l \"loadDesktopConfig\\|saveDesktopConfig\\|desktopConfig\" 2>/dev/null"` -- the
  example from the requirements: `IXargsNode` with `child.binary === "grep"` and `child.options.l`
  containing the pattern string; `child.redirects` contains the `2>/dev/null` entry.
- `"ls && xargs rm"` -- `BinOp` with right being `IXargsNode`.
- `"ls -la"` -- no transformation; `Command` with `binary === "ls"` (non-xargs commands unchanged).
- `IXargsNode.raw` equals the full original xargs command string.

### 9. Create `src/test/interpret-xargs.test.ts`

Integration tests that call `decide(call, logger, registry)` with a minimal rule registry:

- `xargs grep` with a rule that allows `grep` Command nodes -- decision is `allow`.
- `xargs rm -f` with a rule that denies `rm` Command nodes -- decision is `deny`.
- `xargs` (no subcommand, empty child binary) with no matching rules -- decision is `ask`
  (falls through to default).
- `"find . | xargs grep"` with rules allowing both `find` and `grep` -- decision is `allow`.
- `"find . | xargs rm"` with a rule denying `rm` -- decision is `deny`.
- `"xargs -n 1 grep"` with a rule allowing `grep` -- xargs option `-n 1` does not interfere;
  decision is `allow`.

Use the built-in rule registry (including `xargsRule`) plus a simple test rule that allows/denies
by binary name.

### 10. Create smoke tests

Create one `test.yaml` per directory under `e2e/bash/`:

**`e2e/bash/bash-xargs-grep-allow/test.yaml`**

```yaml
description: "bash: xargs grep with pattern should be allowed"
input:
  tool_name: Bash
  tool_input:
    command: 'xargs grep -l "pattern" 2>/dev/null'
  cwd: ${PROJECT_DIR}
rules: {}
home_dir_files:
  bash-rules.yaml:
    bash:
      grep:
        decide: allow
expected:
  decision: allow
```

**`e2e/bash/bash-xargs-rm-deny/test.yaml`**

```yaml
description: "bash: xargs rm should be denied"
input:
  tool_name: Bash
  tool_input:
    command: "xargs rm -f"
  cwd: ${PROJECT_DIR}
rules: {}
home_dir_files:
  bash-rules.yaml:
    bash:
      rm:
        decide: deny
expected:
  decision: deny
```

**`e2e/bash/bash-xargs-no-subcmd-ask/test.yaml`**

```yaml
description: "bash: xargs with no subcommand defaults to ask"
input:
  tool_name: Bash
  tool_input:
    command: "xargs"
  cwd: ${PROJECT_DIR}
rules: {}
home_dir_files:
  bash-rules.yaml:
    bash:
      grep:
        decide: allow
expected:
  decision: ask
```

**`e2e/bash/bash-xargs-pipe-find-grep-allow/test.yaml`**

```yaml
description: "bash: find piped to xargs grep should be allowed when both are allowed"
input:
  tool_name: Bash
  tool_input:
    command: "find . -name '*.ts' | xargs grep -l 'pattern'"
  cwd: ${PROJECT_DIR}
rules: {}
home_dir_files:
  bash-rules.yaml:
    bash:
      find:
        decide: allow
      grep:
        decide: allow
expected:
  decision: allow
```

**`e2e/bash/bash-xargs-complex-pattern-allow/test.yaml`**

```yaml
description: "bash: xargs grep with complex alternation pattern and redirect should be allowed"
input:
  tool_name: Bash
  tool_input:
    command: 'xargs grep -l "loadDesktopConfig\|saveDesktopConfig\|desktopConfig" 2>/dev/null'
  cwd: ${PROJECT_DIR}
rules: {}
home_dir_files:
  bash-rules.yaml:
    bash:
      grep:
        decide: allow
expected:
  decision: allow
```

### 11. Update `docs/HOW_IT_WORKS.md`

**Section 2 (Tool call → AST)**: extend the description to mention the xargs post-processing step.
After the `parseBash` sentence, add: "After parsing, `buildAst` applies `transformXargsNodes` to
the sub-tree: every `Command` leaf with `binary: "xargs"` is replaced by an `IXargsNode`
intermediate node whose `child` is the parsed subcommand." Add an example mermaid diagram for
`find . | xargs grep -l "pattern"` showing `BinOp(|)` with left `Command(find)` and right
`IXargsNode` containing `Command(grep)`.

**Section 6 (Built-in rules)**: add a row to the table for `xargsRule`:

| Rule | File | Matches | Env effect |
|---|---|---|---|
| `xargsRule` | `src/rules/builtin/xargs.ts` | `IXargsNode` (any xargs command) | None -- always abstains; child decision propagates |

## Unit Tests

- `src/test/rules/builtin/xargs.test.ts` -- tests for `xargsRule` (abstain on all node types)
- `src/test/build-ast-xargs.test.ts` -- tests for xargs AST shape: `IXargsNode` structure,
  option extraction, child Command binary, pipe combinations, no-subcommand case
- `src/test/interpret-xargs.test.ts` -- integration tests for decisions: allow/deny/ask propagated
  from child, pipe combinations

## Smoke Tests

- `e2e/bash/bash-xargs-grep-allow/` -- xargs grep allowed
- `e2e/bash/bash-xargs-rm-deny/` -- xargs rm denied
- `e2e/bash/bash-xargs-no-subcmd-ask/` -- xargs with no subcommand → ask
- `e2e/bash/bash-xargs-pipe-find-grep-allow/` -- find | xargs grep allowed
- `e2e/bash/bash-xargs-complex-pattern-allow/` -- user's example command with complex pattern

## Verify

1. Run `bun run compile` -- must exit 0 with no TypeScript errors.
2. Run `bun run test` -- all unit tests must pass.
3. Run `bun run smoke` -- all smoke tests must pass, including the five new xargs cases.
4. Run `bun run test:all` -- all tests must pass.

## Human Verification

1. Run `bun run compile && bun run test:all` and confirm all tests pass with no errors.
2. Run `echo "test" | bun run src/pre-hook.ts` (or the compiled hook) with input JSON for
   `xargs grep -l "pattern"` and a YAML rule allowing `grep` -- confirm the decision is `allow`.
3. Run with input for `find . | xargs rm -f` and a YAML rule denying `rm` -- confirm `deny`.
4. Run `bun run smoke` and verify all five new smoke test directories produce green output.

## Notes

- `xargs` is an intermediate node (not a leaf) so the "all rules abstain → default ask" path at
  leaf nodes does not apply. If the child has no matching rule and defaults to ask, that ask
  propagates to the xargs node via `combine`.
- The `2>/dev/null` redirect at the xargs level ends up in the child Command's `redirects` field.
  This is semantically imprecise (the redirect belongs to xargs, not grep) but has no effect on
  permission decisions, which only care about `binary`, `options`, and `cmd`.
- `xargs` with no subcommand (bare `xargs`) runs `echo` by default in real shells. The plugin
  treats this as an empty `Command` child (binary `""`), which no rule will match, so the result
  is `ask` -- a safe conservative default.
- Unusual redirect placement before the subcommand (e.g., `xargs 2>/dev/null grep`) is handled:
  op-kind tokens between the xargs options and the subcommand are skipped along with their targets.
- The xargs options field on `IXargsNode` contains only xargs-own options (correctly parsed).
  The generic `parseArgv` that ran at the `Command` level is discarded; we re-parse from raw.
