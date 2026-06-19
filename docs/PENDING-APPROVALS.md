# Pending approval files

When the permissions engine returns `ask`, Claude Code shows an approval prompt. To help you decide quickly, the pre-hook writes a Markdown debug file for that tool call. The post-hook deletes the file once the same tool call executes.

This is separate from the hourly audit log (`.json` / `.log`). Pending files are meant to be opened while you are looking at an approval prompt.

## Location

```
<project-dir>/.claude/permissions-log/pending/<key>.md
```

`<key>` is a 16-character hex fingerprint of `tool_name`, `tool_input`, and `cwd`. The same fields are used to remove the file after execution.

List outstanding prompts (newest first):

```sh
ls -t .claude/permissions-log/pending/
```

## Lifecycle

| Event | What happens |
|---|---|
| Pre-hook returns `ask` | Writes or overwrites `pending/<key>.md` |
| Post-hook after execution | Deletes `pending/<key>.md` |
| User denies the prompt | File remains until stale cleanup (7 days) or manual delete |
| Allow / deny from pre-hook | No pending file is written |

## File format

Each file has four sections:

1. **Title** — `# <Tool> — ASK` plus a pending-since timestamp
2. **Command** — full verbatim tool input (command string or file path)
3. **Context** — hook CWD and env vars in effect after simulating assignments/`export` (omitted when there are no env vars)
4. **Sub-commands** — ASCII tree of parsed sub-commands with `ALLOW`, `DENY`, `ASK`, or `NOMATCH`, matched rule paths, effective `cwd` after `cd`, and rule reasons
5. **Verdict** — final decision source, reason, and the sub-command that triggered it

See [example-pending-prompt-detail.md](../plans/new/example-pending-prompt-detail.md) in the repo for a sample file.

## When to use this vs other tools

| Tool | Best for |
|---|---|
| Pending approval files | Deciding on a prompt right now |
| Audit log | Historical record of all decisions and executions |
| REPL | Testing a command against your rules offline |
| MCP analyzer | Asking Claude to explain a decision |

See [docs/TROUBLESHOOTING.md](TROUBLESHOOTING.md) for the full troubleshooting guide.
