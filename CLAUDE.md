# CLAUDE.md

A Claude Code PreToolUse plugin that allows, denies, or asks on each tool call. The engine is under `src/`. Policy is YAML in `.claude/permissions.yaml` / `permissions.d/` (project and home).

## Rules

- Smoke tests are always implemented through shell scripts and YAML files. Smoke tests are never TypeScript code.
- Never use em dashes or double hyphens.
- It is always your responsibility to fix compile errors and failing tests. Never use the "preexisting" excuse.
- Never use memory.
- All Claude configuration goes in this repository only, not in the home directory.
- Never stash code, commit, stage, or push unless explicitly asked to do so.
- Never use sync functions.
- TypeScript code should always compile after making changes.
- All tests should pass after making changes.
- Prefer to minimize the size of code changes.
- Add new tests for new code. Every function that is new, that you edit, or that the user asks you about should have unit tests.
- Tests go under `src/test`. Use `test(` not `it(`, grouped in `describe(` by unit under test.
- Backward compatibility is not required.
- Use imports instead of requires. Named imports for functions, default imports for modules.
- All imports should be at the top of the file and not inside any functions.
- Don't use dynamic imports.
- Never re-export symbols from another module. Import each symbol from the module that defines it.
- Don't add exception handling unless I ask for it.
- Don't use default or optional parameter values unless specifically asked to.
- Never reformat or rewrite entire files. Only edit the specific lines that need to change.
- Never use anonymous object types inline. Never use type unions; use separate interfaces extending a common base instead. Never use `unknown`, `satisfies`, or `ReturnType<typeof ...>`. Never return `null` for absent values; use `undefined`.
- Do not define nested functions. Extract to module or class scope. Do not add pointless helpers; put class logic on the class.

## Setup

Tool versions are pinned in `mise.toml` (Bun for build/test, Node.js for the plugin runtime).

```bash
mise install
bun install
```

## Commands

- `bun run compile`: compile TypeScript (use this, not tsc directly)
- `bun run test`: unit tests
- `bun run smoke`: smoke tests
- `bun run test:all`: all tests

## Tech Stack

Bun (build/test; never Node or npx for those), Node.js (plugin runtime only), TypeScript, Jest (never the Bun test runner).

## Coding Style

- **Types**: Use interfaces with PascalCase (`IFoo`) for types, explicit return types. Prefer inferred local types; annotate parameters, return types, and class fields.
- **Naming**: camelCase for variables/methods, PascalCase for classes/interfaces. Never use single-character names.
- **Functions**: Named functions for top-level methods, arrow functions for callbacks.
- **Formatting**: 4-space indentation, braces on same line as control statements, `else`/`catch` on a new line. Always brace `if` bodies. Prefer truthy/falsy checks over explicit `null`/`undefined` comparisons.
- **Comments**: `//` docs above globals and methods stating intent, not how. Blank line before field comments. Do not put a function's name in its own comment.
- **Tests**: `any` is ok in tests sometimes, not in normal code.
