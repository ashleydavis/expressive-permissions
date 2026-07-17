# Pending Prompt Debug Log

## Overview

When the permissions engine returns `ask`, Claude Code shows an approval prompt but the audit log is hard to use in the moment: entries are buried in hourly `.log`/`.json` files and mixed with every other tool call. Add dedicated pending-prompt Markdown files under `.claude/permissions-log/pending/` that the pre-hook writes when a tool call needs approval, and that the post-hook removes once that exact tool call executes. No shared index file: each hook only writes or deletes its own detail file, avoiding concurrent rewrite races. List outstanding prompts with `ls -t .claude/permissions-log/pending/`.

## Issues

## Examples

See also [example-pending-prompt-detail.md](example-pending-prompt-detail.md).

### Detail file

Path: `.claude/permissions-log/pending/<key>.md`

Concise sections only. One fenced block per section.

```markdown
# Bash: ASK

Pending since 2026-06-19T18:17:43+10:00

## Command

```
<full command, verbatim>
```

## Context

```
CWD: /home/user/project
<VAR>=<value>   # env vars in effect after simulating the command (assignments, export, etc.)
```

Omit `## Context` when hook CWD is the only line and `env` is empty.

## Sub-commands

```
<ascii tree>
├── <leaf>
│     ALLOW  .claude/permissions.yaml:5
├── cd /tmp
│     ALLOW  .claude/permissions.yaml:8
└── <leaf>
      cwd: /tmp                    # when leaf cwd differs from hook cwd
      NOMATCH
└── <leaf>
      ASK  .claude/permissions.yaml:12  "rule reason from yaml"
```

## Verdict

```
ASK (matched rule): network access requires approval
→ curl https://api.internal.corp/v1/deploy  (cwd: /tmp)
```
```

**Tree rules**

- Walk the root AST with the same env threading as `interpret` (`walkChildren` / built-in `cd` and env-assignment rules). For each **leaf**, record effective `cwd` and env map via `simulateLeafEnvironments`.
- Render compound structure (`|`, `&&`, `;`, etc.) with box-drawing prefixes.
- Label each leaf with `ALLOW`, `DENY`, `ASK`, or `NOMATCH` (uppercase).
- Matched leaves: `ruleFile:ruleLine` plus optional `"reason"` from the `rule_match` trace entry.
- Show `cwd: <path>` on a leaf line when its simulated cwd differs from the hook `call.cwd`.
- Pipes discard cwd/env changes between sides; `&&` / `;` thread them (same as the interpreter).

**Context block**

- First line always `CWD: <call.cwd>`.
- Following lines: env vars present after simulating the full command (keys sorted, `KEY=value`). Include vars set by inline assignments and built-in env rules only; omit empty env.

**Verdict block**

- Line 1: `<DECISION> (<source>): <reason>` where `<source>` is `matched rule`, `no rule matched`, or `deny rule` derived from the triggering leaf outcome.
- Line 2: `→ <cmd>` plus `(cwd: …)` when the trigger leaf’s cwd differs from hook cwd.

## Steps

1. Add `src/pending-prompt-log.ts` with the following exported symbols and behaviour.

   - `ILeafOutcome` interface: `decision: string` (uppercase), optional `ruleFile`, optional `ruleLine`, optional `reason`, optional `source` (`matched-rule` | `no-rule-match` | `deny-rule`).
   - `ILeafContext` interface: `cwd: string`, `env: Record<string, string>`.
   - `resolvePendingDir(projectDir: string): string`: returns `<projectDir>/.claude/permissions-log/pending`.
   - `computePendingPromptKey(call: IToolCall | IPostToolUseCall): string`: deterministic 16-character hex key derived from `tool_name`, `tool_input`, and `cwd`. Serialize with `JSON.stringify` on `{ tool_name, tool_input, cwd }` (object keys in that order) and hash with `createHash("sha256")` from `crypto`; take the first 16 hex characters. This is the correlation key between pre-hook write and post-hook cleanup because `IToolCall` and `IPostToolUseCall` share those three fields.
   - `buildLeafOutcomeMap(trace: IAuditLogEntry[]): Map<string, ILeafOutcome>`: index leaf outcomes by `cmd` from `rule_match` and `no_rule_match`.
   - `simulateLeafEnvironments(root: AstNode, env0: IEnvironment): Map<string, ILeafContext>`: walk the AST with the same env threading as `interpret` (reuse or mirror `walkChildren` and built-in env/cd semantics); key by `describeNode(leaf)`.
   - `formatContextBlock(call: IToolCall, root: AstNode, env0: IEnvironment): string | undefined`: render the Context fenced block; return `undefined` when only hook CWD and no env vars apply.
   - `formatPendingPromptTree(root: AstNode, leafOutcomeMap: Map<string, ILeafOutcome>, leafContextMap: Map<string, ILeafContext>, hookCwd: string): string`: render the ASCII tree with cwd annotations and rule reasons.
   - `resolveVerdictTrigger(trace: IAuditLogEntry[], finalDecision: string, leafOutcomeMap: Map<string, ILeafOutcome>): { cmd: string; source: string; reason: string | undefined; cwd: string | undefined }`: strictest leaf driving the outcome plus its context.
   - `formatPendingPromptMarkdown(call: IToolCall, root: AstNode, trace: IAuditLogEntry[], decision: string, reason: string | undefined, pendingSince: Date): string`: H1, pending-since line, then `## Command`, optional `## Context`, `## Sub-commands`, `## Verdict`.
   - `writePendingPrompt(projectDir: string, call: IToolCall, root: AstNode, trace: IAuditLogEntry[], decision: string, reason: string | undefined, pendingSince: Date): Promise<void>`: compute key, `mkdir` `pending/` if needed, `writeFile` `pending/<key>.md` only.
   - `removePendingPrompt(projectDir: string, call: IPostToolUseCall): Promise<void>`: compute key, `unlink` `pending/<key>.md` if present (ignore absent file).
   - `cleanupStalePendingPrompts(projectDir: string, now: Date, maxAgeDays: number): Promise<void>`: delete `pending/*.md` whose mtime is older than `maxAgeDays` (use 7). Called from both hooks so orphaned files from denied or ignored prompts do not accumulate forever.

2. Extend `decide()` in `src/interpret.ts` to return `{ decision, root, trace }`. The trace is captured inside `decide()` while still forwarding entries to the caller's logger for file audit output. Pre-hook and pending-prompt code use `decideResult.trace`; no tee wrapper in callers.

3. Wire the pre-hook in `src/pre-hook.ts`.

   - Pass `createLogger(...)` to `decide()` as today.
   - After `decide()` returns, when `decision.action === "ask"`, call `writePendingPrompt(..., decideResult.trace, ...)`.
   - Also call `cleanupStalePendingPrompts(projectDir, new Date(), 7)` on every pre-hook invocation (after `ensureLogDirIgnored`).
   - Keep existing audit log behaviour unchanged for allow/deny/ask.

5. Wire the post-hook in `src/post-hook.ts`.

   - After the existing `tool_execution` audit log write, call `removePendingPrompt(projectDir, call)`.
   - Also call `cleanupStalePendingPrompts(projectDir, new Date(), 7)`.

6. Do not re-enable `src/debug-log.ts` or write to `permissions-debug.log`. The pending prompt log is a separate feature with a different layout and lifecycle.

7. Update documentation.

   - `docs/AUDIT-LOG.md`: add a "Pending approvals" section describing `pending/<key>.md` files, the correlation key, write-on-ask / delete-on-execute lifecycle, 7-day stale cleanup, and `ls -t .claude/permissions-log/pending/` to list outstanding prompts.
   - `docs/TROUBLESHOOTING.md`: add a bullet pointing users to `.claude/permissions-log/pending/` when deciding whether to approve a prompt.
   - `README.md`: one sentence in the audit log bullet mentioning pending approval Markdown files.

8. Extend `scripts/run-e2e-test.ts` to support optional pending-prompt assertions in test YAML.

   - Add optional `expected.pending_prompt: true` on ask tests (assert `pending/<key>.md` exists).
   - Add optional `post_expected.pending_prompt_removed: true` when `post_input` is present (assert the detail file is gone after post-hook).
   - Compute expected key in the runner with the same `computePendingPromptKey` import so tests stay in sync.

## Unit Tests

Add `src/test/pending-prompt-log.test.ts`:

- `computePendingPromptKey` is stable for the same call and differs when `tool_input` or `cwd` changes.
- `simulateLeafEnvironments` threads cwd through `cd` and `&&`; pipes reset cwd changes.
- `formatContextBlock` lists hook CWD and simulated env vars.
- `formatPendingPromptMarkdown` includes pending-since, Context, leaf cwd lines, rule reasons, and verdict source `(matched rule)` / `(no rule matched)`.
- `writePendingPrompt` creates `pending/<key>.md` only (no index file).
- `removePendingPrompt` deletes the detail file.
- `cleanupStalePendingPrompts` removes files older than the threshold.

Add to `src/test/pending-prompt-log.test.ts`:

- `decide()` returns a trace for pending prompt formatting.

- Ask decision creates a pending detail file (use a temp project dir with an ask rule, same pattern as the existing `permissions.d` deny test).

Add to `src/test/post-hook.test.ts`:

- After pre-hook ask write, post-hook with matching `tool_name`/`tool_input`/`cwd` removes the pending file.

## Smoke Tests

Add one new e2e test (shell script + YAML, not TypeScript):

- `e2e/bash/bash-pending-prompt-ask-write-remove/test.yaml`
  - Pre-hook: `curl` with `decide: ask` and a reason; `expected.decision: ask`; `expected.pending_prompt: true`.
  - `post_input` matching the same Bash command; `post_expected.pending_prompt_removed: true`.

Register the test directory in `scripts/smoke-tests.sh` alongside the other e2e cases.

## Verify

- `bun run compile` passes with no errors.
- `bun run test` passes with no failures.
- `bun run smoke` passes with no failures.
- Manually (or via e2e): after pre-hook ask, confirm `.claude/permissions-log/pending/<key>.md` exists; after post-hook with the same tool input, confirm the file is gone.

## Notes

- **No index file.** Each hook touches only `pending/<key>.md` for its own tool call. Multiple outstanding prompts are listed with `ls -t .claude/permissions-log/pending/`; each file’s title and `Pending since` line identify it.
- **Correlation key.** Hooks only receive `tool_name`, `tool_input`, and `cwd` (see `IToolCall` / `IPostToolUseCall` in `src/types.ts`). There is no separate request id in the repo's hook contract, so the SHA-256 fingerprint of those three fields is the cleanup key. Two concurrent identical asks share one pending file; the pre-hook overwrites it with the latest trace. This matches the usual case of one outstanding approval per distinct command.
- **Write scope.** Only `ask` decisions create pending files. Allow and deny do not; the hourly audit log remains the source of truth for those.
- **User denies an ask.** PostToolUse never fires, so the pending file remains until the user executes the same command (unlikely) or stale cleanup removes it after 7 days. Document this in AUDIT-LOG.md.
- **Gitignore.** `ensureLogDirIgnored` already writes `*` / `!.gitignore` in `.claude/permissions-log/`, so `pending/*.md` stays out of version control automatically.
- **Async I/O.** All new file operations use `fs/promises` (`writeFile`, `readdir`, `unlink`, `mkdir`, `stat`), not sync variants.
- **Reuse.** Leaf outcomes come from the same `rule_match` / `no_rule_match` audit entries the interpreter already emits; tree shape comes from the same AST `decide()` evaluates. The pending file is a human view of that data, not a second trace format.
