# claude-permissions

A permissions plugin for Claude Code that intercepts every tool call and decides allow, deny, or ask based on rules you define in a YAML config file. All decisions are fully auditable — see the [audit log documentation](https://github.com/ashleydavis/claude-permissions/blob/main/docs/AUDIT-LOG.md).

For the full explanation of why this exists and how it works, see the [project README on GitHub](https://github.com/ashleydavis/claude-permissions).

## Installation

```
/plugin marketplace add ashleydavis/claude-permissions
/plugin install claude-permissions@claude-permissions
```

## Configuration

Place your rules in `.claude/permissions.yaml` at your project root (or `~/.claude/permissions.yaml` for global rules):

```yaml
bash:
  git:
    status:
      decide: allow

  rm:
    options:
      - r|recursive
      - f|force
    decide: deny
    reason: rm -rf in any format is not allowed
```

Then set Claude Code to allow all tools so the plugin is the sole decision-maker. Add the following to `~/.claude/settings.json` (global) or `.claude/settings.json` (project):

```json
{
  "permissions": {
    "allow": [
      "Bash",
      "Read",
      "Write",
      "Edit",
      "MultiEdit",
      "WebFetch",
      "mcp__*"
    ]
  }
}
```

See the [full documentation](https://github.com/ashleydavis/claude-permissions#configuration) for more details.

Run `/reload-plugins` after editing rules to pick up changes.

## Verifying the plugin

Ask Claude to run a command with no matching rule (e.g. `echo hello`). You should see a confirmation prompt. If the command runs silently, the plugin is not active.

## Troubleshooting rules

Three tools help when a rule is not behaving as expected:

- **Audit log** -- every permission decision and tool result is written to `.claude/permissions-log/`. Check it first when you want to understand what just happened.
- **Permission REPL** -- interactive terminal session for testing commands against your rules (`bun run repl`). Only available if you have cloned the repository.
- **Permission Analyzer MCP** -- ask Claude to analyze a command: "Use analyze_permission to check why `git push --force` is denied." Claude calls the tool and explains the trace.

See the [full troubleshooting guide](https://github.com/ashleydavis/claude-permissions/blob/main/docs/TROUBLESHOOTING.md) for setup and usage of all three tools.

## Full documentation

- [Permissions quick reference](https://github.com/ashleydavis/claude-permissions/blob/main/docs/PERMISSIONS-QUICKREF.md)
- [Rule syntax reference](https://github.com/ashleydavis/claude-permissions/blob/main/docs/CONFIGURATION.md)
- [How it works](https://github.com/ashleydavis/claude-permissions/blob/main/docs/HOW_IT_WORKS.md)
- [Protecting production](https://github.com/ashleydavis/claude-permissions/blob/main/docs/PROTECTING-PRODUCTION.md)
- [Development guide](https://github.com/ashleydavis/claude-permissions/blob/main/docs/DEVELOPMENT.md)
- [Permission REPL](https://github.com/ashleydavis/claude-permissions/blob/main/docs/REPL.md)
- [MCP server](https://github.com/ashleydavis/claude-permissions/blob/main/docs/MCP-SERVER.md)
