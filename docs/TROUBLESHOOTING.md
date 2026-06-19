# Troubleshooting rules

Four tools help you understand why the permissions engine makes a particular decision.

---

- [Pending approval files](#pending-approval-files)
- [Audit log](#audit-log)
- [Permission REPL](#permission-repl)
- [Permission Analyzer MCP server](#permission-analyzer-mcp-server)

---

## Pending approval files

When Claude Code shows an approval prompt, the pre-hook writes a Markdown debug file for that tool call. Open it to see the full command, parsed sub-commands with rule outcomes, effective cwd and env vars, and the verdict that triggered the ask.

List outstanding prompts (newest first):

```sh
ls -t .claude/permissions-log/pending/
cat .claude/permissions-log/pending/<key>.md
```

The file is removed automatically after you approve and the tool executes. If you deny the prompt, the file stays until stale cleanup (7 days) or you delete it manually.

See [docs/PENDING-APPROVALS.md](PENDING-APPROVALS.md) for the file format and lifecycle.

## Audit log

Every permission decision and every tool result is written to two files under `.claude/permissions-log/`: a machine-readable JSON Lines file and a human-readable plain-text log. Check these first when a rule is not behaving as expected.

See [docs/AUDIT-LOG.md](AUDIT-LOG.md) for the log format and retention policy.

## Permission REPL

Requires the repo to be cloned locally. An interactive terminal session. Type a rule and see the full rule trace and the final decision in colour:

```sh
bun run repl
permissions> git push --force
  ...trace...
DENY -- pushing is not allowed
```

One-shot mode (no interactive session, useful in scripts or CI):

```sh
bun run repl "git push --force"
```

See [docs/REPL.md](REPL.md) for the full reference including non-Bash tool prefixes and `:project` / `:cwd` session commands.

## Permission Analyzer MCP server

Once the MCP server is registered, ask Claude to analyze a command by name. Mentioning `analyze_permission` or the word "analyze" is the most reliable trigger:

- "Use analyze_permission to check why `git push --force` is denied."
- "Analyze the permission for `read /etc/passwd`."
- "Call analyze_permission on `kubectl delete pod` and explain what you find."

Without an explicit prompt, Claude may try to answer by reading `permissions.yaml` directly rather than calling the tool. If you see it doing that, ask again with one of the phrasings above.

See [docs/MCP-SERVER.md](MCP-SERVER.md) for setup and usage.
