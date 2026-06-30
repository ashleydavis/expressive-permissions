# Development guide

For contributors and anyone who wants to write TypeScript rules, run tests, or publish the plugin.

## Table of contents

- [Prerequisites](#prerequisites)
- [Running it during development](#running-it-during-development)
    - [Enabling for all Claude instances (including IDE extensions)](#enabling-for-all-claude-instances-including-ide-extensions)
- [How to test the plugin is working](#how-to-test-the-plugin-is-working)
- [Scripts](#scripts)
- [Adding a TypeScript rule](#adding-a-typescript-rule)
    - [What a rule can match](#what-a-rule-can-match)
    - [Registry ordering](#registry-ordering)
- [Testing](#testing)
- [Publishing](#publishing)

## Prerequisites

- [Bun](https://bun.sh) — runtime, bundler, and package manager

```bash
cd ~
git clone https://github.com/ashleydavis/expressive-permissions
cd expressive-permissions
bun install
bun run bundle        # bundle plugin/dist/pre-hook.js and plugin/dist/post-hook.js
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

After editing rules, reload:

```bash
/reload-plugins
```

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

With this in place, every tool call flows through `permissions.yaml` rules and nothing prompts twice.

## How to test the plugin is working

The repo ships several `echo` rules in `.claude/permissions.yaml` that cover all three outcomes as well as pipeline position, `cd`-based cwd changes, and env-var matching:

| Command | Expected outcome |
|---|---|
| `echo hello` | **Prompt** — no rule matches, plugin defaults to `ask` |
| `echo foobar` | **Denied** — a deny rule matches `cmd: foobar` |
| `echo dogears` | **Allowed silently** — an allow rule matches `cmd: dogears` |
| `echo pipeblock && echo hello` | **Denied** — `echo pipeblock` is first in the pipeline, deny rule fires |
| `echo hello && echo pipeblock` | **Denied** — `echo pipeblock` is second in the pipeline, deny rule still fires |
| `cd /tmp && echo cwdblock` | **Denied** — `cd` changes cwd to `/tmp`, satisfying the `cwd: /tmp` rule |
| `BLOCK_ECHO=true echo envblock` | **Denied** — env prefix sets `BLOCK_ECHO=true`, satisfying the `env` rule |

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

- `plugin/dist/pre-hook.js` or `plugin/dist/post-hook.js` is missing — run `bun run bundle` to generate both.
- The plugin directory path is wrong — verify the path passed to `--plugin-dir` points to the `plugin/` subdirectory, not the repo root.
- A stale hook after editing source — run `bun run bundle && /reload-plugins`.

## Scripts

| Script | Short | Description |
|---|---|---|
| `bundle:pre` | — | Bundle `src/pre-hook.ts` → `plugin/dist/pre-hook.js` |
| `bundle:post` | — | Bundle `src/post-hook.ts` → `plugin/dist/post-hook.js` |
| `bundle:mcp` | — | Bundle `src/mcp-server.ts` → `plugin/dist/mcp-server.js` |
| `bundle` | `b` | Run all three bundle scripts |
| `compile` | `c` | TypeScript type-check (no emit) |
| `test` | `t` | Run Jest unit tests |
| `test:watch` | `tw` | Jest in watch mode |
| `smoke` | — | Bundle then run smoke tests |
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

## Adding a TypeScript rule

Each rule is a single function `(node, env, call) => RuleOutcome` in its own file under `src/rules/`.

**1. Create the rule file** — `src/rules/block-curl.ts`:

```ts
import { ABSTAIN } from "../types.js";
import type { Rule } from "../types.js";

export const blockCurl: Rule = (node) => {
    if (node.type === "command" && node.binary === "curl") {
        return { decision: { action: "deny", reason: "curl is not allowed" } };
    }
    return ABSTAIN;
};
```

**2. Register it** in `src/rules/index.ts` — add after the other deny rules so the registry stays ordered (denies first, then asks, then allows):

```ts
import { blockCurl } from "./block-curl.js";
// add to the rules array
```

**3. Write a paired test** at `src/test/rules/block-curl.test.ts`. Three cases are the minimum: a positive match, a near-miss that should not match, and a wrong node kind:

```ts
import { describe, expect, test } from "@jest/globals";
import { blockCurl } from "../../rules/block-curl.js";
import { makeCommand, makeOptions, makeEnv, dummyCall } from "../../rules/test-helpers.js";

describe("blockCurl", () => {
    test("denies curl", () => {
        expect(blockCurl(makeCommand("curl", makeOptions({}, ["https://example.com"])), makeEnv(), dummyCall))
            .toMatchObject({ decision: { action: "deny" } });
    });
    test("abstains on other binaries", () => {
        expect(blockCurl(makeCommand("wget", makeOptions({}, [])), makeEnv(), dummyCall))
            .toEqual({ decision: { action: "abstain" } });
    });
    test("abstains on non-command nodes", () => {
        const editNode = { type: "edit" as const, file_path: "/x", old_string: "", new_string: "" };
        expect(blockCurl(editNode, makeEnv(), dummyCall))
            .toEqual({ decision: { action: "abstain" } });
    });
});
```

**4. Build and reload**:

```bash
bun run bundle && /reload-plugins
```

### What a rule can match

Match on `node.kind` to target the right call type:

| `node.type` | When it matches | Key fields |
|---|---|---|
| `"command"` | Bash leaf (one command in a pipeline) | `binary`, `options`, `envPrefix`, `raw` |
| `"bash"` | Bash root (the whole command string) | `raw`, `ast` |
| `"read"` | Read tool call | `file_path` |
| `"write"` | Write tool call | `file_path`, `content` |
| `"edit"` | Edit tool call | `file_path`, `old_string`, `new_string` |
| `"multiedit"` | MultiEdit tool call | `file_path`, `edits[]` |
| `"other"` | Any other tool (Grep, Task, WebFetch, MCP, …) | `tool_name`, `tool_input` |

The `env` argument carries the live environment at this point in the walk: `env.cwd` (current directory, updated by `cdRule`), `env.cwdResolved` (false after `cd $VAR` or `cd -`), and `env.env` (accumulated env vars from `export` / `FOO=bar` prefixes).

### Registry ordering

Rules in `src/rules/index.ts` run in array order with strictest-wins semantics:

- **Built-in semantic rules first** (`cdRule`, `envPrefixRule`, `envSetRule`, `exportRule`) — their env updates are visible to permission rules at the same node.
- **Deny permission rules next** — a deny short-circuits all later rules at the same node.
- **Ask permission rules after denies** — an ask cannot be downgraded by a later allow.
- **Allow permission rules last** — recorded only if nothing stricter was seen.
- **User rules (YAML)** — appended after all TypeScript rules via `...loadConfigRules()`.

## Testing

```bash
bun run test          # run all unit tests
bun run test:watch    # watch mode
bun run compile       # type-check only (no emit)
bun run smoke         # build first, then run smoke tests
```

To run a single smoke test:

```bash
bun run scripts/run-e2e-test.ts e2e/bash/bash-and-both-allow
```

Unit tests live under `src/test/` mirroring the source tree. `src/test/pre-hook.test.ts` covers the hook runner (stdin parsing, stdout output, error path). Run `bun run smoke` to build and then run the end-to-end smoke tests in `scripts/smoke-tests.sh`.

### AST example fixtures

Parser behaviour is pinned by YAML fixtures under [`examples/ast/`](../examples/ast): each file carries a `tool_call`, optional inline command `descriptors`, and the expected `ToolRoot` `ast`. Bash construct fixtures also exist under [`examples/bash/`](../examples/bash) in compact form (legacy; same cases are duplicated in `examples/ast/` under matching directory names). Fixtures are checked by `scripts/check-ast-example.ts` via `scripts/smoke-tests-bash-parser.sh`. Each fixture has a sibling `.md` file with a Mermaid diagram. Edit fixtures and diagrams by hand when parser output changes. The suite runs as part of `bun run test:all`.

## Publishing

The `plugin/` subdirectory is the distribution subtree:

```
plugin/
├── .claude-plugin/
│   └── plugin.json     # manifest
├── hooks/
│   └── hooks.json      # registers the PreToolUse and PostToolUse hooks
├── .mcp.json           # registers the MCP server for plugin users
└── dist/
    ├── pre-hook.js     # bundled PreToolUse entry point — commit this
    ├── post-hook.js    # bundled PostToolUse entry point — commit this
    └── mcp-server.js  # bundled MCP server — commit this
```

Commit all three dist files so users installing from a path or the marketplace don't need to run a build step themselves. Run `bun run bundle` before committing to keep all three up to date.

The plugin is distributed via the Claude Code marketplace system. The repo root contains `.claude-plugin/marketplace.json` which lists the plugin at `./plugin`. Users install it with:

```
/plugin marketplace add ashleydavis/expressive-permissions
/plugin install expressive-permissions
```

Before tagging a release, bundle all three dist files so the committed files are up to date:

```bash
bun run bundle
git add plugin/dist/pre-hook.js plugin/dist/post-hook.js plugin/dist/mcp-server.js
git commit -m "bundle for release"
git tag v1.2.3
git push origin v1.2.3
```

The `publish` GitHub Actions workflow triggers on tags matching `v*.*.*` and runs compile, Jest tests, and both smoke test suites as a final validation gate.

The `ci` workflow runs on every push and pull request: compile, Jest tests, `scripts/smoke-tests.sh`, and `scripts/smoke-tests-bash-parser.sh`.
