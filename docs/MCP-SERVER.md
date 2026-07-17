# Permission Analyzer MCP Server

This doc explains the MCP server that lets Claude analyze and explain permission decisions.


- [What it does](#what-it-does)
- [Installation](#installation)
- [Using it with Claude](#using-it-with-claude)
- [The analyze_permission tool](#the-analyze_permission-tool)
- [Input prefix syntax](#input-prefix-syntax)
- [How project_dir is resolved](#how-project_dir-is-resolved)
- [Rebuilding the bundle](#rebuilding-the-bundle)


## What it does

Every time you ask Claude a question like "why is `git push` being denied?" or "would `Read /etc/passwd` be allowed?", Claude calls `analyze_permission` with the command, runs it through the full permissions engine against your `permissions.yaml`, and returns the decision plus a trace of every rule that fired. Claude then explains the result in plain language.

This works with the same rule evaluation logic used by the live PreToolUse hook, so what the analyzer reports matches exactly what would happen in a real Claude session.

For an interactive terminal alternative that does not involve Claude, see [docs/REPL.md](REPL.md).

## Installation

### Plugin users

When you install the plugin via `/plugin install`, Claude Code reads `plugin/.mcp.json` automatically. The entry uses `${CLAUDE_PLUGIN_ROOT}` so paths resolve correctly regardless of where the plugin is installed:

```json
{
    "mcpServers": {
        "permissions-analyzer": {
            "command": "node",
            "args": ["${CLAUDE_PLUGIN_ROOT}/dist/mcp-server.js"],
            "type": "stdio"
        }
    }
}
```

### Repository developers

When working in the repository directly, the repo-root `.mcp.json` registers the server against the TypeScript source so changes take effect without rebundling:

```json
{
    "mcpServers": {
        "permissions-analyzer": {
            "command": "bun",
            "args": ["run", "src/mcp-server.ts"],
            "type": "stdio"
        }
    }
}
```

After adding or changing either entry, run `/reload-plugins` in Claude Code to pick up the new server.

### Allow the tool in your permissions.yaml

Because the plugin intercepts every tool call, including MCP calls, you must add a rule to allow `analyze_permission`. Without it the plugin will prompt you every time Claude calls the tool. Add this to your `~/.claude/permissions.yaml` (or your project's `.claude/permissions.yaml`):

```yaml
mcp__permissions-analyzer__analyze_permission:
  decide: allow
```

## Using it with Claude

Once the server is registered, explicitly ask Claude to use the tool. Mentioning `analyze_permission` by name, or using the word "analyze", is the most reliable trigger:

- "Use analyze_permission to check why `git push --force` would be denied."
- "Analyze the permission for `rm -rf /tmp/scratch`."
- "Call analyze_permission on `read /etc/passwd` and explain what you find."

Without an explicit prompt, Claude may try to answer by reading `permissions.yaml` directly rather than calling the tool. If you see it doing that, ask again with one of the phrasings above.

## The analyze_permission tool

| Parameter | Type | Required | Description |
|---|---|---|---|
| `command` | string | yes | The command or tool input to analyze. Bare text is treated as a Bash command. Use a prefix for other tool types. |
| `cwd` | string | no | Working directory for the analysis. Defaults to `CLAUDE_PROJECT_DIR` or `process.cwd()`. |
| `project_dir` | string | no | Config root used to locate `permissions.yaml`. Defaults to `CLAUDE_PROJECT_DIR` or `process.cwd()`. |

The tool returns a text block with three sections:

```
Decision: allow
Reason: git status is always allowed

Trace:
rule_match      10:00:01  RULE               "git status" -> .claude/permissions.yaml:3 -> allow
final_decision  10:00:01  RESULT   Bash      "git status" -> ALLOW
```

`config_load` and `tool_request` lines are stripped from the trace because they appear on every invocation and do not help explain why a particular rule matched.

## Input prefix syntax

Prepend a prefix (case-insensitive) to analyze non-Bash tool calls:

| Prefix | Tool analyzed |
|---|---|
| `read <path>` | Read |
| `write <path>` | Write |
| `edit <path>` | Edit |
| `webfetch <url>` | WebFetch |
| `tool <name>` | Generic tool by name |
| (none) | Bash |

Examples you can ask Claude:

- "Analyze `read /etc/shadow`" -- checks your `read:` rules against that path
- "What happens with `webfetch https://api.github.com`?" -- checks your `webfetch:` rules against that host
- "Would `tool mcp__github__delete_repo` be allowed?" -- checks your generic tool rules

## How project_dir is resolved

The MCP server resolves `project_dir` from `process.env["CLAUDE_PROJECT_DIR"]` if set, otherwise from `process.cwd()`. Claude Code launches the server from the project root, so `process.cwd()` is the project root -- the correct value in almost every case.

If you need to analyze rules from a different project, pass `project_dir` explicitly in the tool call, or ask Claude to pass it: "Analyze `git push` as if the project dir is `/home/me/other-project`."

## Rebuilding the bundle

The MCP server is bundled into `plugin/dist/mcp-server.js` for distribution:

```sh
bun run bundle:mcp
```

Or rebuild all three bundles at once:

```sh
bun run bundle
```
