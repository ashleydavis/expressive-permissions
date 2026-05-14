# Troubleshooting rules

Three tools help you understand why the permissions engine makes a particular decision.

---

- [Audit log](#audit-log)
- [Permission REPL](#permission-repl)
- [Permission Analyzer MCP server](#permission-analyzer-mcp-server)

---

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

See [docs/REPL.md](REPL.md) for the full reference including non-Bash tool prefixes and `:cwd` session commands.

## Permission Analyzer MCP server

Once the MCP server is registered, ask Claude to analyze a command by name. Mentioning `analyze_permission` or the word "analyze" is the most reliable trigger:

- "Use analyze_permission to check why `git push --force` is denied."
- "Analyze the permission for `read /etc/passwd`."
- "Call analyze_permission on `kubectl delete pod` and explain what you find."

Without an explicit prompt, Claude may try to answer by reading `permissions.yaml` directly rather than calling the tool. If you see it doing that, ask again with one of the phrasings above.

See [docs/MCP-SERVER.md](MCP-SERVER.md) for setup and usage.
