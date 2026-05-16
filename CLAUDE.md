# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Rules

- SMOKE TESTS ARE ALWAYS IMPLEMENTED THROUGH SHELL SCRIPTS + YAML FILES, SMOKE TESTS ARE NEVER TYPESCRIPT CODE.
- THIS IS A BUN PROJECT, NOT NODE.JS
- NEVER USE EM DASHES OR DOUBLE HYPHENS
- IT IS ALWAYS YOUR RESPONSIBILTY TO FIX COMPILE ERRORS AND FAILING TESTS. NEVER USE THE "PREEXISTING" EXCUSE.
- Never use memory.
- All Claude configuration goes in this repository only, not in the home directory.
- Never stash code unless asked.
- NEVER USE SYNC VERSIONS OF FUNCTIONS (e.g. readFileSync, appendFileSync, mkdirSync). Always use async/await equivalents from `fs/promises`.
- This project uses the Jest test runner. Never use the Bun test runner.
- This project is Bun, never use Node or npx.

## Project Overview

A Claude Code plugin that intercepts every tool call (Bash, Read, Edit, Write, MultiEdit, MCP, etc.) via the PreToolUse hook and decides whether to allow, deny, or ask the user. The hook converts each tool call into an AST — Bash commands parse into operator/command sub-trees, other tools become typed leaves — then walks the tree threading an immutable Environment (cwd + env vars) and runs every registered rule at each node. Rule outcomes (allow / deny / ask / abstain, plus optional env updates) aggregate strictest-wins per node and bubble up to the root. Rules are authored as small TypeScript functions in `src/rules/` (one per file with paired tests) or declared in YAML — either in the main `.claude/permissions.yaml` (project) and `~/.claude/permissions.yaml` (home), or as per-category drop-ins under `.claude/permissions.d/*.yaml` (and the home equivalent), where each file becomes its own isolated layer. Built-in rules encode Bash semantics like `cd` and env-var assignments; everything else is user-defined.

## Commands

- `bun run compile` — compile TypeScript (use this, not tsc directly)
- `bun run test` — unit tests
- `bun run smoke` — smoke tests
- `bun run test:all` — all tests

## Tech Stack

- **Runtime**: Bun (runs `plugin/dist/hook.js`; users must have Bun installed)
- **Language**: TypeScript
- **Bundler**: `bun build` via `bun bundle` / `bun b` script (produces `plugin/dist/hook.js` from `src/hook.ts`)
- **Test runner**: Jest with `ts-jest`
- **Runtime deps** (bundled): `shell-quote`, `yaml`, `picomatch`
- **Dev deps**: `typescript`, `jest`, `ts-jest`, `@types/jest`, `@types/shell-quote`

## Coding Style
- **Types**: Use interfaces with PascalCase (`IFoo`) for types, explicit return types
- **Naming**: camelCase for variables/methods, PascalCase for classes/interfaces
- **Imports**: Named imports for functions, default imports for modules
- **Functions**: Named functions for top-level methods, arrow functions for callbacks
- **Async**: Use async/await pattern for asynchronous code
- **Error Handling**: Try/catch blocks with specific error handling, custom error classes
- **Formatting**: 4-space indentation, braces on same line as control statements
- **Comments**: Line comments with `//` preceded by blank line, method docs above function. Use `//` comments for method docs.
- All global symbols (functions, types, interfaces, classes, constants) must have a `//` comment block above them explaining their intent.
- All fields in interfaces and classes must have a `//` comment explaining their purpose.
- Never use single-character variable names, including arrow function parameters (e.g. use `fileName => ...` not `f => ...`). Use long descriptive identifiers.
- Avoid single line if statements. All if statements should have curly brackets around the function body.
- Never put multiple statements on one line. Each statement should be on its own line.
- Use 4 space tabs for indentation.
- Put `else` and `catch` blocks on a new line.
- Tests should go under the directory src/test in each package.
- Use `test(` not `it(` in Jest test files.
- Refrain from using the `any` type in normal code, although it's ok sometimes in test code.
- Never use anonymous object types inline (e.g. `Promise<{ foo: number }>`). Always define a named interface instead, unless specifically asked to use an anonymous type.
- Never use IIFE async generator pattern (`(async function* () { ... })()`). Extract to a named `async function*` instead.
- Never use `ReturnType<typeof ...>`. Use the actual type directly (e.g. `NodeJS.Timeout` instead of `ReturnType<typeof setTimeout>`).
- Never use inline type casts (e.g. `(x as Foo).bar`). Assign to a typed variable instead (e.g. `const foo: Foo = x; foo.bar`).
- Never use the `unknown` type. Use the actual type directly.

## Restrictions

- TypeScript code should always compile after making changes.
- All tests should pass after making changes.
- Prefer to minimize the size of code changes.
- Prefer not to update test code unless needed.
- Add new tests for new code. Every function that is new, that you edit, or that the user asks you about should have unit tests.
- Backward compatibility is not required.
- Use imports instead of requires.
- All imports should be at the top of the file and not inside any functions.
- Don't use dynamic imports.
- Don't add exception handling unless I ask for it.
- Don't use default or optional parameter values unless specifically asked to.
- Never reformat or rewrite entire files. Only edit the specific lines that need to change.
