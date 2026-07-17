# Development guide

This doc explains how to clone, build, and run the plugin locally.

## Table of contents

- [Prerequisites](#prerequisites)
- [Running it during development](#running-it-during-development)
    - [Enabling for all Claude instances (including IDE extensions)](#enabling-for-all-claude-instances-including-ide-extensions)
- [How to test the plugin is working](#how-to-test-the-plugin-is-working)
- [Scripts](#scripts)
- [Running the MCP server locally](#running-the-mcp-server-locally)
- [Permission engine layout](#permission-engine-layout)
- [Adding a built-in rule](#adding-a-built-in-rule)
- [Testing](TESTING.md)
- [Publishing](PUBLISHING.md)

## Prerequisites

- [Bun](https://bun.sh): bundler, package manager, and local runner for TypeScript sources
- [Node.js](https://nodejs.org): required to run the bundled plugin hooks and MCP server.

```bash
cd ~
git clone https://github.com/ashleydavis/expressive-permissions
cd expressive-permissions
bun install

# bundle pre-hook, post-hook, and mcp-server into plugin/dist/
bun run bundle 
```

## Running it during development

From inside the repo:

```bash
claude --plugin-dir ./plugin
```

Or from any other project directory:

```bash
claude --plugin-dir ~/expressive-permissions/plugin
```

Note: `--plugin-dir` is a CLI flag and does not apply to Claude Code running inside IDE extensions (VS Code, JetBrains). Use the global hook approach below if you need the plugin active in those environments.

### Enabling for all Claude instances (including IDE extensions)

Add the hook directly to `~/.claude/settings.json`. This is equivalent to what the plugin system does internally and applies to every Claude Code instance on the machine, including the VS Code extension:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "bun ~/expressive-permissions/src/pre-hook.ts"
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "bun ~/expressive-permissions/src/post-hook.ts"
          }
        ]
      }
    ]
  }
}
```

Configuration is reloaded automatically on the next hook run, so rule edits apply without `/reload-plugins`.

## Allowing all tools through to the plugin

The plugin's hook is the sole decision-maker, so Claude Code's own permission system must be set to allow all tools. Otherwise Claude Code prompts separately before the hook fires, producing double prompts.

> **Warning:** Only apply these settings after you have verified the plugin is working (see [How to test the plugin is working](#how-to-test-the-plugin-is-working)). Without the plugin active, these settings remove all permission checks.

Add the following to `~/.claude/settings.json` (global) or `.claude/settings.json` in the project root (project-local):

```json
{
  "permissions": {
    "allow": [
      "Bash",
      "Read",
      "Write",
      "Edit",
      "MultiEdit",
      "Glob",
      "Grep",
      "WebFetch",
      "WebSearch",
      "TodoWrite",
      "Agent",
      "NotebookEdit",
      "ExitPlanMode",
      "BashOutput",
      "KillShell",
      "mcp__*"
    ]
  }
}
```

With this in place, every tool call flows through your permissions rules and nothing prompts twice.

## How to test the plugin is working

The repo ships several `echo` rules in `.claude/permissions.yaml` that cover all three outcomes as well as pipeline position, `cd`-based cwd changes, and env-var matching:

| Command | Expected outcome |
|---|---|
| `echo hello` | **Prompt**: no rule matches, plugin defaults to `ask` |
| `echo foobar` | **Denied**: a deny rule matches `cmd: foobar` |
| `echo dogears` | **Allowed silently**: an allow rule matches `cmd: dogears` |
| `echo pipeblock && echo hello` | **Denied**: `echo pipeblock` is first in the pipeline, deny rule fires |
| `echo hello && echo pipeblock` | **Denied**: `echo pipeblock` is second in the pipeline, deny rule still fires |
| `cd /tmp && echo cwdblock` | **Denied**: `cd` changes cwd to `/tmp`, satisfying the `cwd: /tmp` rule |
| `BLOCK_ECHO=true echo envblock` | **Denied**: env prefix sets `BLOCK_ECHO=true`, satisfying the `env` rule |

Run each of those commands after loading the plugin and verify you see the expected behaviour. Each command also produces an audit log entry. To confirm the decisions were recorded, tail the current hour's log file:

```bash
tail .claude/permissions-log/$(date +%Y-%m/%d/%H).log
```

To confirm the plugin itself loaded without errors, check the Claude startup output for a line referencing the hook, or run:

```bash
/plugins
```

This lists all active plugins. `expressive-permissions` should appear in the list.

If the hook is silently not firing, the most common causes are:

- `plugin/dist/pre-hook.js` or `plugin/dist/post-hook.js` is missing: run `bun run bundle` to generate both.
- The plugin directory path is wrong: verify the path passed to `--plugin-dir` points to the `plugin/` subdirectory, not the repo root.
- A stale hook after editing source: run `bun run bundle && /reload-plugins`.
- Node.js is not on `PATH`: the installed plugin invokes `node` for hooks and the MCP server.

## Scripts

| Script | Short | Description |
|---|---|---|
| `bundle:pre` | (none) | Bundle `src/pre-hook.ts` → `plugin/dist/pre-hook.js` |
| `bundle:post` | (none) | Bundle `src/post-hook.ts` → `plugin/dist/post-hook.js` |
| `bundle:mcp` | (none) | Bundle `src/mcp-server.ts` → `plugin/dist/mcp-server.js` |
| `bundle` | `b` | Run all three bundle scripts |
| `compile` | `c` | TypeScript type-check (no emit) |
| `test` | `t` | Run Jest unit tests |
| `test:watch` | `tw` | Jest in watch mode |
| `smoke` | (none) | Run e2e, bash-parser, and decision smoke scripts |
| `smoke:repl` | (none) | REPL smoke tests |
| `test:all` | `ta` | validate + unit tests + all smoke suites including hook and REPL |
| `repl` | `r` | Run the interactive permission REPL |
| `dev` | `d` | Start Claude Code with the plugin loaded from this repo |

## Running the MCP server locally

The repo-root `.mcp.json` registers the MCP server against the TypeScript source so you can use it without bundling or installing the plugin:

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

This file is already present in the repo. Run `/reload-plugins` in Claude Code to activate it, then ask Claude a permission question such as "Why would `rm -rf /` be denied?" Claude will call `analyze_permission` and explain the result.

To test `analyze_permission` without Claude, use the REPL instead:

```bash
bun run repl "rm -rf /"
```

See [docs/REPL.md](REPL.md) and [docs/MCP-SERVER.md](MCP-SERVER.md) for full usage details.

## Permission engine layout

The permission engine lives under `src/`:

| Area | Path | Role |
|---|---|---|
| Parse | `src/parse.ts` | Tool call → AST |
| Load | `src/load.ts` | Built-ins + YAML → flat rule list |
| Decide | `src/decision.ts` | Walk AST, evaluate rules, bubble up |
| Built-ins | `src/rules/builtin/` | Semantic rules for cwd and env threading |
| YAML rules | `src/rules/` | Rule factories compiled from config |

[`src/analyze.ts`](../src/analyze.ts) ties parse, load, and decide together for the REPL and MCP server. [`src/pre-hook.ts`](../src/pre-hook.ts) and [`src/post-hook.ts`](../src/post-hook.ts) call the same pipeline on live tool calls and write the audit log.

For architecture details (AST shape, context threading, bubble-up), see [HOW_IT_WORKS.md](HOW_IT_WORKS.md). For end-user YAML policy, see [CONFIGURATION.md](CONFIGURATION.md).

## Adding a built-in rule

Semantic built-ins are classes implementing `IRule` under `src/rules/builtin/`. Register new instances in `src/rules/builtin/index.ts`. They are prepended before any YAML rules at load time.

Permission policy for end users is YAML, not ad-hoc TypeScript rule files. Reserve built-ins for engine semantics (cwd changes, env merging, and similar) that YAML cannot express. The current built-ins are documented in [Built-in rules](HOW_IT_WORKS.md#built-in-rules).

Add unit tests under `src/test/` for any new or changed built-in.

## Testing

See [TESTING.md](TESTING.md).

## Publishing

See [PUBLISHING.md](PUBLISHING.md).
