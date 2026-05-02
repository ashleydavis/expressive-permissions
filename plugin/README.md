# claude-permissions

A permissions plugin for Claude Code that intercepts every tool call and decides allow, deny, or ask based on rules you define in a YAML config file.

For the full explanation of why this exists and how it works, see the [project README on GitHub](https://github.com/ashleydavis/claude-permissions).

## Installation

```
/plugin marketplace add ashleydavis/claude-permissions
/plugin install claude-permissions@claude-permissions
```

## Configuration

Place your rules in `.claude/permissions.yaml` at your project root (or `~/.claude/permissions.yaml` for global rules):

```yaml
git:
  status:
    decide: allow

rm:
  args:
    - r|recursive
    - f|force
  decide: deny
  reason: rm -rf in any format is not allowed
```

Then set Claude Code to allow all tools so the plugin is the sole decision-maker. Add to `~/.claude/settings.json`:

```json
{
  "permissions": {
    "allow": ["Bash", "Read", "Write", "Edit", "MultiEdit", "WebFetch", "mcp__*"]
  }
}
```

Run `/reload-plugins` after editing rules to pick up changes.

## Verifying the plugin

Ask Claude to run a command with no matching rule (e.g. `echo hello`). You should see a confirmation prompt. If the command runs silently, the plugin is not active.

## Full documentation

- [Rule syntax reference](https://github.com/ashleydavis/claude-permissions/blob/main/docs/USER-DEFINED-RULES.md)
- [How it works](https://github.com/ashleydavis/claude-permissions/blob/main/docs/HOW_IT_WORKS.md)
- [Protecting production](https://github.com/ashleydavis/claude-permissions/blob/main/docs/PROTECTING-PRODUCTION.md)
- [Development guide](https://github.com/ashleydavis/claude-permissions/blob/main/docs/DEVELOPMENT.md)
