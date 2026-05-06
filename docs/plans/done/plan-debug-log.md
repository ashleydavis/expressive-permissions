# Debug Log for Pre/Post Hooks

## Overview

Debugging the permissions hook is hard because there is no easy way to see what stdin the hooks receive, what env vars are present, or what decisions were reached. This plan adds a plain-text debug log written to `.claude/permissions-debug.log` (next to `permissions.yaml`) that captures raw hook entry data, exit decisions, and errors from both the PreToolUse and PostToolUse hooks.

## Steps

1. **Create `src/debug-log.ts`** with three exported functions:
   - `resolveDebugLogPath(projectDir: string): string` - returns `join(projectDir, ".claude", "permissions-debug.log")`
   - `appendDebugBlock(logPath: string, lines: string[]): void` - creates the directory if needed, then appends a timestamped block: first line gets a full `toLocalISOString` timestamp prefix, every subsequent line (including internal newlines from pretty-printed JSON) is indented two spaces; single `appendFileSync` call
   - `logDebugError(logPath: string | undefined, error: unknown): void` - writes an `[ERROR]` line to the debug log (if path is known) and to `process.stdout`

2. **Modify `src/hook.ts`** (`runHook`):
   - Declare `logPath: string | undefined` in outer scope so the catch block can access it
   - After `readStdin()`, read `CLAUDE_PROJECT_DIR` early; if set, compute `logPath = resolveDebugLogPath(projectDir)`
   - Log `[PRE-HOOK ENTRY]` block: the parsed tool call object (pretty-printed JSON), `process.env.CLAUDE_PROJECT_DIR`, and `process.env` (pretty-printed JSON)
   - After computing `permissionDecision` and `permissionDecisionReason`, log `[PRE-HOOK EXIT]` block: decision and optional reason
   - In `catch`, call `logDebugError(logPath, hookError)` before the existing `stderr` write

3. **Modify `src/post-hook.ts`** (`runPostHook`):
   - Same outer-scope `logPath` pattern
   - Log `[POST-HOOK ENTRY]` block: the parsed post-call object (pretty-printed JSON) and `process.env` (pretty-printed JSON)
   - After the `logger.log(...)` call, log `[POST-HOOK EXIT]` block: tool name and `isError` value
   - In `catch`, call `logDebugError(logPath, hookError)` before the existing `stderr` write

## Unit Tests

- `src/test/debug-log.test.ts` (new file):
  - `resolveDebugLogPath` returns the correct path under `.claude/`
  - `appendDebugBlock` creates missing directories and writes a timestamped block with correct indentation
  - `logDebugError` writes to the log file and to stdout when a path is provided
  - `logDebugError` writes only to stdout when path is `undefined`

## Smoke Tests

No new smoke test scripts needed. The existing smoke test suite exercises the hook end-to-end; after implementation, manually invoke:

```sh
echo '{"tool_name":"Bash","tool_input":{"command":"ls"},"cwd":"/tmp"}' \
  | CLAUDE_PROJECT_DIR=/tmp bun run plugin/dist/hook.js
```

and confirm `/tmp/.claude/permissions-debug.log` is created with the expected entry/exit lines.

## Verify

1. `bun run bundle` and `bun run bundle:post` complete without errors
2. `bun test` passes with no failures
3. Manual invocation (above) produces `.claude/permissions-debug.log` containing:
   - A `[PRE-HOOK ENTRY]` block with the raw stdin and env vars
   - A `[PRE-HOOK EXIT]` block with the decision
4. When `CLAUDE_PROJECT_DIR` is unset, the hook writes the error to stdout and exits 1 (no crash from missing log path)

## Notes

- The debug log is enabled by default (no config flag) for immediate debugging utility; a toggle can be added later via `permissions.yaml` if needed.
- Writing errors to `process.stdout` (in addition to stderr) is intentional per user request, even though it may produce non-JSON output on that channel.
- Objects (tool call, `process.env`) are serialized with `JSON.stringify(obj, null, 2)` and split across lines, each line indented under its label. No filtering is applied so all env vars are visible.
- `logPath` is `undefined` only when `CLAUDE_PROJECT_DIR` is not set; in that case debug file writes are silently skipped while the error still reaches stdout.
