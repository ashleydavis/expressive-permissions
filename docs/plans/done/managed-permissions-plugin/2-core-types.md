# Step 2: Core types

Create `src/types.ts` with every shared interface and type used across the codebase. No logic — types only.

## Files to create

- `src/types.ts` — contains:
  - `ToolCall` — the stdin JSON payload from Claude Code.
  - `Decision` — union of `allow | deny | ask | abstain` variants.
  - `IRedirect` — named interface for redirect entries (op + target); used in `Command.redirects`.
  - `Command`, `BinOp`, `BashAstNode` — Bash sub-AST nodes.
  - `IEditEntry` — named interface for a single MultiEdit operation.
  - `Bash`, `Read`, `Write`, `Edit`, `MultiEdit`, `OtherTool` — tool-root nodes.
  - `ToolRoot`, `AstNode` — union types.
  - `Environment` — `{ cwd, cwdResolved, env }`.
  - `Annotation` — `{ decision, ruleName?, triggeringRaw? }`.
  - `RuleOutcome` — `{ decision, env?, scopedEnv? }`.
  - `ABSTAIN` — sentinel constant.
  - `Rule` — function type `(node, env, call) => RuleOutcome`.

All interfaces require a `//` comment block above the declaration and a `//` comment above each field. All global symbols (constants, type aliases) require a `//` comment block above them. Do not use `unknown` in any type; do not use anonymous inline object types.

## Verification

Run `npx tsc --noEmit` and confirm the file compiles with no errors.

Run all tests and confirm they pass before marking this step complete.
