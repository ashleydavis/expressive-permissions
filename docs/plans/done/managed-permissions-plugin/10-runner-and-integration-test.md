# Step 10: Runner and integration test

Implement `hook.ts` (the process entry point) and the integration test that verifies its error path. Also run a full build to confirm `bun build` bundles cleanly.

## Files to create

- `src/hook.ts` — the runner (not meant to be edited after this step):
  - Sets a 5-second abort timer at the very top with `.unref()`.
  - Exports two named `async` functions: `readStdin(): Promise<string>` and `runHook(): Promise<void>` (no IIFE). Call `runHook()` at the bottom of the file.
  - `readStdin` reads all stdin and returns a UTF-8 string.
  - `runHook` calls `JSON.parse(await readStdin()) as ToolCall`, calls `decide(call)`, and writes `{ hookSpecificOutput: { hookEventName, permissionDecision, permissionDecisionReason } }` to stdout, then exits 0.
  - On any error: writes to stderr and exits 1 (non-blocking error per hooks docs; never uses exit 2).
  - Variable names: use `decision` (not `d`) for the decide result; use `hookError` (not `e`) in the catch clause.
  - All exported and module-level symbols require `//` comment blocks above them.
  - `catch` block goes on a new line after the closing `}` of `try`.

- `src/test/hook.integration.test.ts` — spawns `bun dist/hook.js` via `spawnSync`:
  - Malformed JSON input → process exits with code 1.
  - Empty input → process exits with code 1.

## Build verification

Run `bun bundle` and confirm `plugin/dist/hook.js` is produced with no errors.

Run `bun test` (unit tests) and `bun smoke` (integration test — requires the bundle) and confirm both pass.

Run all tests and confirm they pass before marking this step complete.
