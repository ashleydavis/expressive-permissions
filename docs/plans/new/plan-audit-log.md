# Audit Log

## Overview

Add a rolling audit log to `.claude/permissions-log` that records every tool call, every rule match, each AST-level aggregation decision, and the final allow/deny/ask outcome. Log files are organised as `YYYY-MM/DD/HH.log` (one file per UTC hour) using JSON Lines format. On every hook invocation the logger also prunes month directories older than two calendar months. All changes are covered by unit tests, and one smoke test runs real tool calls through simple rules then verifies log file creation and content.

## Issues

## Steps

1. **src/audit-log.ts** (new file) - All audit log types and implementation:
   - Interfaces (exported so `interpret.ts` can import them directly from this module):
     - `IAuditLogEntryBase` - base interface with `type` discriminator and `timestamp: string`
     - `IToolRequestEntry extends IAuditLogEntryBase` - `type: "tool_request"`, `tool`, `input`, `cwd`
     - `IRuleMatchEntry extends IAuditLogEntryBase` - `type: "rule_match"`, `nodeType`, optional `ruleName`, `decision`, optional `reason`
     - `IAggregationEntry extends IAuditLogEntryBase` - `type: "aggregation"`, `nodeType`, optional `op` (BinOp operator), `childrenDecision`, `ownDecision`, `combined`
     - `IFinalDecisionEntry extends IAuditLogEntryBase` - `type: "final_decision"`, `tool`, `decision`, optional `reason`
     - `IAuditLogEntry` - union of the four entry interfaces
     - `IAuditLogger` - interface with `log(entry: IAuditLogEntry): void`
   - `resolveLogBaseDir(projectDir: string): string` - returns `<projectDir>/.claude/permissions-log`
   - `resolveLogPath(baseDir: string, now: Date): string` - returns `<baseDir>/YYYY-MM/DD/HH.log` using UTC fields, zero-padded
   - `cleanupOldMonths(baseDir: string, now: Date): void` - lists subdirs matching `YYYY-MM`, removes any whose month key (`year * 12 + month`) is more than 2 below the current month key; skips gracefully if `baseDir` does not exist
   - `NullAuditLogger` class implementing `IAuditLogger` - `log()` is a no-op; exported for test use
   - `FileAuditLogger` class implementing `IAuditLogger` - constructor takes `(baseDir: string, now: Date)`; `log()` calls `resolveLogPath`, creates directories with `mkdirSync(..., { recursive: true })`, appends `JSON.stringify(entry) + "\n"` via `appendFileSync`
   - `createFileAuditLogger(logBaseDir: string, now: Date): FileAuditLogger` - factory function
   - All imports (`appendFileSync`, `existsSync`, `mkdirSync`, `readdirSync`, `rmSync` from `"fs"`, `join` from `"path"`) must be at the top of the file

3. **src/interpret.ts** - Thread `IAuditLogger` through all internal functions:
   - Add `logger: IAuditLogger` as the last parameter to `decide()`, `interpret()`, `runRules()`, and `walkChildren()`
   - In `decide()`, after building the AST and before calling `interpret()`, call `logger.log({ type: "tool_request", timestamp, tool: call.tool_name, input: call.tool_input, cwd: call.cwd })`
   - In `decide()`, just before returning the final decision, call `logger.log({ type: "final_decision", timestamp, tool: call.tool_name, decision: decision.action, reason: ... })`
   - In `runRules()`, after each call to `rule(...)`, if `outcome.decision.action !== "abstain"`, call `logger.log({ type: "rule_match", timestamp, nodeType: node.type, ruleName: rule.name || undefined, decision: outcome.decision.action, reason: ... })`
   - In `interpret()` for the intermediate (non-leaf) branch, after every call to `combine()`, call `logger.log({ type: "aggregation", timestamp, nodeType: node.type, op: node.type === "binop" ? (node as BinOp).op : undefined, childrenDecision: childrenAnnotation.decision.action, ownDecision: rulesResult.annotation.decision.action, combined: annotation.decision.action })`
   - Also log aggregation in the early-deny short-circuit path (before the early `return`), with `ownDecision: "abstain"` and `combined: "deny"`
   - Pass `logger` through all recursive calls: `interpret()` calls `walkChildren(node, env, call, logger)`, `walkChildren` passes `logger` to each `interpret()` call, and `interpret()` and `decide()` pass `logger` to `runRules()`
   - Add `import { IAuditLogger } from "./audit-log"` to the imports; `BinOp` is already imported from `"./types"`

4. **src/hook.ts** - Create the logger and pass to `decide()`:
   - Import `NullAuditLogger`, `createFileAuditLogger`, `cleanupOldMonths`, `resolveLogBaseDir`, `IAuditLogger` from `"./audit-log"`
   - Inside `runHook()`, before calling `decide()`, resolve the logger:
     - Read `process.env["CLAUDE_PROJECT_DIR"]`
     - If set: compute `logBaseDir = resolveLogBaseDir(projectDir)`, call `cleanupOldMonths(logBaseDir, new Date())`, then `logger = createFileAuditLogger(logBaseDir, new Date())`
     - If not set: `logger = new NullAuditLogger()`
   - Change `const decision = decide(call)` to `const decision = decide(call, logger)`

5. **src/test/interpret.test.ts** - Update all `decide()` calls to pass a logger:
   - Add `import { NullAuditLogger } from "../audit-log"` at the top
   - Add `new NullAuditLogger()` as the second argument to every `decide(...)` call in the file (approximately 40 occurrences)

6. **docs/AUDIT-LOG.md** (new file) - User-facing documentation:
   - Explain the purpose of the audit log and where it is written
   - Describe the directory structure (`YYYY-MM/DD/HH.log`)
   - Describe the JSON Lines format and each of the four entry types with example output
   - Show how to view blocked commands: `grep '"decision":"deny"' .claude/permissions-log/**/*.log`
   - Show how to view approved commands: `grep '"decision":"allow"'`
   - Explain the 2-month retention policy

7. **docs/DEVELOPMENT.md** - In the "## How to test the plugin is working" section, after the existing verification table, add one or two sentences explaining that each command tested also produces an audit log entry and showing the one-liner to tail the current hour's log file to confirm the decisions were recorded.

8. **README.md** - Add a sentence to the introductory section stating that all decisions are fully auditable, with a link to `docs/AUDIT-LOG.md`

9. **plugin/README.md** - Add a sentence to the introductory section stating that all decisions are fully auditable, with a link to `docs/AUDIT-LOG.md`

## Unit Tests

**src/test/audit-log.test.ts** (new file):
- `resolveLogBaseDir`: returns correct path with `.claude/permissions-log` suffix
- `resolveLogPath`: correct `YYYY-MM/DD/HH.log` path for a known date
- `resolveLogPath`: zero-pads month, day, and hour (e.g. month=3 → `"03"`)
- `resolveLogPath`: uses UTC fields (not local time)
- `cleanupOldMonths`: does nothing when base dir does not exist
- `cleanupOldMonths`: does not remove current month directory
- `cleanupOldMonths`: does not remove directory exactly 2 months ago
- `cleanupOldMonths`: removes directory that is 3 months ago
- `cleanupOldMonths`: keeps multiple recent months, removes only the old one
- `cleanupOldMonths`: ignores entries that do not match `YYYY-MM` pattern
- `FileAuditLogger.log`: creates directory structure and writes a JSON line to the log file
- `FileAuditLogger.log`: appends a second entry on a newline without overwriting the first
- `NullAuditLogger.log`: does not throw and writes nothing

**src/test/interpret.test.ts** - all existing tests continue to pass after adding `new NullAuditLogger()` to each `decide()` call

## Smoke Tests

One new e2e YAML test file run via the existing `scripts/run-e2e-test.ts` + `scripts/smoke-tests.sh` harness.

**e2e/integration/audit-log.yaml** (new file):
- Uses simple rules that allow `ls` and deny `rm`
- Sends a `Bash` tool call for `ls` and asserts `decision: allow`
- After the run, `run-e2e-test.ts` must be extended to verify that a log file was created at `<projectDir>/.claude/permissions-log/YYYY-MM/DD/HH.log` and that it contains at least one `tool_request` entry and one `final_decision` entry with the correct decision value

To support the log-file assertion, **scripts/run-e2e-test.ts** needs a small extension:
- After the hook exits 0, check whether `<projectDir>/.claude/permissions-log` exists
- If an `expected.audit_log` key is present in the YAML, read the newest log file and assert each listed entry field is present in the parsed JSON Lines

## Verify

- `bun run compile` - no TypeScript errors
- `bun test` - all tests pass (existing + new unit tests + smoke test)
- Manual check: set `CLAUDE_PROJECT_DIR=/tmp/test-project` and pipe a fake tool call JSON to `plugin/dist/hook.js`; confirm a log file appears at `.claude/permissions-log/YYYY-MM/DD/HH.log` with correct JSON Lines content

## Notes

- Log format is JSON Lines (NDJSON): one JSON object per line, newline-terminated, UTF-8 encoded
- All timestamp fields use `new Date().toISOString()` (ISO 8601 UTC)
- File writes use synchronous `fs.appendFileSync` because the hook process must complete before Claude Code proceeds; async writes could leave log entries missing if the process exits first
- The `NullAuditLogger` is exported from `src/audit-log.ts` (not from a test helper) so it is available in any test file without circular imports
- `hook.test.ts` does not need modification: `runHook()` creates the logger internally, and `CLAUDE_PROJECT_DIR` is typically unset in test environments so `NullAuditLogger` is used automatically
- Cleanup runs on every hook invocation; this is cheap because there are at most ~3 monthly directories to inspect
- `cleanupOldMonths` threshold: delete if `year * 12 + month < currentYear * 12 + currentMonth - 2` (strictly more than 2 months old); keep 3 most recent months including the current one
- The two README files to link are `README.md` (root) and `plugin/README.md`
