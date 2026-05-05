# PostToolUse Audit Logging

## Overview
The plugin currently logs via a `PreToolUse` hook only, capturing the decision process (tool_request, rule_match, aggregation, final_decision entries). This gives no record of what Claude Code actually ran and what the result was. Adding a `PostToolUse` hook fills that gap: every tool that was allowed and executed will produce a `tool_execution` entry in the same audit log files (`HH.json` / `HH.log`), including the tool name, input summary, response, and whether it errored.

## Issues

## Steps

1. **Add `IToolExecutionEntry` to `src/audit-log.ts`**
   - New interface with fields: `type: "tool_execution"`, `tool: string`, `input: Record<string, unknown>`, `cwd: string`, `response: Record<string, unknown>`, `isError: boolean`
   - Extend `IAuditLogEntry` union to include `IToolExecutionEntry`
   - Add a `"tool_execution"` case to `formatTextEntry`: format as `HH:MM:SS  EXECUTE  <tool>: <input-summary>  [ERROR]` (omit `[ERROR]` when `isError` is false)

2. **Add `IPostToolUseCall` interface to `src/types.ts`**
   - Fields: `tool_name: string`, `tool_input: Record<string, ToolInputValue>`, `tool_response: Record<string, unknown>`, `cwd: string`

3. **Create `src/post-hook.ts`**
   - Abort timer (same 5-second pattern as `hook.ts`)
   - `readPostStdin()` function: reads all stdin, returns UTF-8 string
   - `runPostHook()` function:
     - Parses stdin as `IPostToolUseCall`
     - Reads `CLAUDE_PROJECT_DIR` env var; throws if absent
     - Creates `FileAuditLogger` via `createLogger(projectDir, new Date())`
     - Extracts `isError` from `tool_response.isError` (boolean, default `false`)
     - Logs a `tool_execution` entry with `tool`, `input`, `cwd`, `response`, `isError`
     - Exits 0 (no stdout output required by PostToolUse)
   - Guard: only call `runPostHook()` when `NODE_ENV !== "test"`

4. **Add `bundle:post` script to `package.json`**
   - `"bundle:post": "bun build src/post-hook.ts --outfile plugin/dist/post-hook.js --target bun"`
   - Update `"b"` alias to run both: `"bun run bundle && bun run bundle:post"`

5. **Register `PostToolUse` hook in `plugin/hooks/hooks.json`**
   - Add a `"PostToolUse"` key alongside the existing `"PreToolUse"` key
   - Same matcher `"*"` catching all tools
   - Command: `"bun ${CLAUDE_PLUGIN_ROOT}/dist/post-hook.js"`

6. **Extend `scripts/run-e2e-test.ts` to support PostToolUse test cases**
   - Add `post_input?: IPostToolUseInput` and `post_expected?: IPostToolUseExpected` fields to `ITestCase`
   - `IPostToolUseInput`: `tool_name`, `tool_input`, `tool_response`, `cwd`
   - `IPostToolUseExpected`: optional `audit_log?: IAuditLogExpectedEntry[]`
   - After the existing PreToolUse assertions, if `testCase.post_input` is present, spawn `bun post-hook.ts` with `post_input` as stdin, then assert `post_expected.audit_log` against the log file

7. **Add unit tests `src/test/post-hook.test.ts`**
   - Test `runPostHook` with a valid Bash tool execution: verifies `tool_execution` entry is written to the logger
   - Test `runPostHook` with `isError: true` in `tool_response`: verifies `isError` field is `true` in the logged entry
   - Test that missing `CLAUDE_PROJECT_DIR` causes process to exit with error

8. **Add unit tests for `formatTextEntry` in `src/test/audit-log.test.ts`**
   - Test `tool_execution` case with `isError: false`: expect no `[ERROR]` suffix
   - Test `tool_execution` case with `isError: true`: expect `[ERROR]` suffix
   - Test `tool_execution` case with `file_path` input: uses file path as summary
   - Test `tool_execution` case with `command` input: uses command string as summary

9. **Add e2e smoke test YAML `e2e/post/post-bash-execution-logged.yaml`**
   - `description`: "PostToolUse: Bash execution is logged with tool_execution entry"
   - `input`: a PreToolUse Bash tool call (e.g. `ls`)
   - `rules`: empty (no rules needed for PostToolUse logging)
   - `expected.decision`: `allow` (or `ask` since no rules)
   - `post_input`: `{ tool_name: "Bash", tool_input: { command: "ls" }, tool_response: { output: "file.txt", isError: false }, cwd: /home/user/project }`
   - `post_expected.audit_log`: `[{ type: "tool_execution", tool: "Bash", isError: "false" }]`

10. **Add e2e smoke test YAML `e2e/post/post-bash-error-logged.yaml`**
    - Same pattern but `tool_response.isError: true`
    - `post_expected.audit_log`: `[{ type: "tool_execution", tool: "Bash", isError: "true" }]`

## Unit Tests

- `src/test/audit-log.test.ts`: `formatTextEntry` with `tool_execution`, `isError: false`
- `src/test/audit-log.test.ts`: `formatTextEntry` with `tool_execution`, `isError: true`
- `src/test/audit-log.test.ts`: `formatTextEntry` with `tool_execution`, `file_path` input key
- `src/test/post-hook.test.ts`: `runPostHook` logs a `tool_execution` entry with correct fields
- `src/test/post-hook.test.ts`: `runPostHook` extracts `isError: true` from `tool_response`
- `src/test/post-hook.test.ts`: `runPostHook` exits 1 when `CLAUDE_PROJECT_DIR` is absent

## Smoke Tests

- `e2e/post/post-bash-execution-logged.yaml`: PostToolUse for a Bash tool call produces a `tool_execution` audit log entry
- `e2e/post/post-bash-error-logged.yaml`: PostToolUse for a failed Bash tool call produces a `tool_execution` entry with `isError: true`

## Verify

- `bun run compile` passes with no TypeScript errors
- `bun run test` passes all unit tests
- `bun run bundle && bun run bundle:post` produces `plugin/dist/hook.js` and `plugin/dist/post-hook.js` without errors
- `bun run smoke` passes all e2e tests including the new `e2e/post/` cases
- Manually inspect `<project>/.claude/permissions-log/YYYY-MM/DD/HH.log` after running Claude Code: each allowed tool call now produces a `EXECUTE` line alongside the existing `TOOL`/`RESULT` lines

## Notes

- `PostToolUse` hooks receive the tool response but cannot affect whether the tool ran (it already ran). The hook only needs to exit 0; no stdout output is required.
- `tool_response` shape varies by tool: Bash has `{ output, interrupted, isError }`, Read has `{ content }`, etc. Storing the raw response as `Record<string, unknown>` is correct; `isError` is extracted as a first-class field for easy filtering.
- The `run-e2e-test.ts` extension (step 6) reuses the existing `findNewestLogFile` and audit log assertion logic, minimising new code.
- Bundling two entry points (`hook.ts` and `post-hook.ts`) doubles the bundle step. The `"b"` alias chains both so a single `bun b` still rebuilds everything.
- `readStdin` is duplicated in `post-hook.ts` rather than extracted to a shared module to keep the change minimal and avoid coupling.
