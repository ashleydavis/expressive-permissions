# claude-permissions

## Table of contents

- [Why?](#why)
- [Examples](#examples)
- [Motivation](#motivation)
    - [Relative paths are matched against your project directory](#relative-paths-are-matched-against-your-project-directory)
    - [Absolute paths are matched against your entire computer](#absolute-paths-are-matched-against-your-entire-computer)
    - [Argument matching across flags and aliases](#argument-matching-across-flags-and-aliases)
    - [Environment variables and working directory are tracked](#environment-variables-and-working-directory-are-tracked)
- [Installation](#installation)
    - [Stable release](#stable-release)
    - [Pre-release / testing (pin to `dev` branch)](#pre-release--testing-pin-to-dev-branch)
- [Verifying the plugin](#verifying-the-plugin)
- [Configuration](#configuration)
    - [Global configuration (applies to every project)](#global-configuration-applies-to-every-project)
    - [Local project configuration (applies to one project)](#local-project-configuration-applies-to-one-project)
- [Quick start: adding a rule](#quick-start-adding-a-rule)
- [Further reading](#further-reading)
- [License](#license)

A permissions system for Claude that actually works. Easily allow everything that's safe. Easily deny everything that's dangerous. Prompt the user for everything else.

This is a plugin for Claude Code to handle permissions. You delegate all of Claude's permission requests to this plugin and then it will decide, through rules you have laid down in yaml configuration files, whether to allow or deny any particular tool use or command invocation.

This gives you permissions that work, even when:
- Commands are embedded in a pipeline in a variable order.
- Arbitrary (and usually hard to match) paths are included in command arguments (both positional and labelled).
- The working directory or environment variables are changed within the pipeline.

## Why?

Claude Code's built-in permission system operates at the tool level: you can allow or deny entire tool categories by matching them against inflexible patterns, but it cannot make decisions based on individual commands within a pipeline, variable file paths in arguments, environment variables (whether set in the shell or inline in the command), the working directory (including `cd` calls mid-pipeline), or context-specific values like the active AWS profile or kubectl context.

This plugin goes further: it converts each tool call into an abstract syntax tree (AST), threads a simulated environment (cwd + env vars) through the tree, and runs your rules at every node in the AST. 

You have fine-grained control over what Claude is allowed to do and an expressive system for defining permissions so that you don't have to keep repeating yourself for every combination of commands that Claude might come up with.

It's all about allowing Claude the freedom to do what it needs to do, without constantly interupting you for permissions, but at the same time protecting you from the most damaging things it can do. Rules can also be scoped by environment, so you can allow full read/write access in a sandbox AWS account or dev cluster while locking down production to read-only - or blocking writes entirely. See [docs/PROTECTING-PRODUCTION.md](docs/PROTECTING-PRODUCTION.md) for recipes covering AWS CLI and kubectl.

All decisions are fully auditable. Every permission decision (allow, deny, or ask) and every tool execution result is written to a machine-readable JSON Lines file and a human-readable plain-text log, both under `.claude/permissions-log/`. See [docs/AUDIT-LOG.md](docs/AUDIT-LOG.md) for the format and retention policy.

> **Safe by default:** if you add no rules, or if a tool call matches no rule, the plugin always falls back to `ask`. Claude will never run an unmatched command silently.

## Examples

Some examples of rules you can write:

| Scenario | Decision |
|---|---|
| `git status`, `git diff`, `git log` | always **allow**, no prompt |
| `rm -rf` anything | always **deny** |
| `sudo anything` | always **deny** |
| Edit or Write to a `.env` file | always **deny** |
| `git add ...` | **ask**: confirm before staging |
| Read `.env`, `~/.ssh/id_rsa`, `~/.aws/credentials` | **ask**: confirm before reading secrets |
| WebFetch to `docs.anthropic.com` | always **allow** |
| WebFetch to an unknown host | **ask** |
| `aws ... describe-*`, `list-*`, or `get-*` | always **allow** |
| `aws` anything when `AWS_PROFILE` is `sandbox` | always **allow** |
| `aws ... delete-*`, `create-*`, or `modify-*` when `AWS_PROFILE` is not `sandbox` | always **deny** |
| `kubectl get`, `describe`, or `logs` on any cluster | always **allow** |
| `kubectl` anything when kubeconfig `current-context` is `sandbox` | always **allow** |
| `kubectl apply`, `delete`, or `exec` when kubeconfig context is not `sandbox` | always **deny** |

## Motivation

Claude Code's built-in permission system works at the tool level. You can allow or deny `Bash` as a whole, or write glob patterns that match against the entire shell string Claude passes to the terminal. 

The problem is that Claude constructs pipelines, and a pipeline is an open-ended and variable combination of commands. You can write a rule for `git status`, but Claude will run `git status && git diff`, or `cd /some/path && git status | grep foo`, or something else entirely. Every new combination requires a new rule, and Claude will always produce combinations you have not seen before. Explicit pattern matching against full pipeline strings does not scale.

This plugin parses the pipeline into an abstract syntax tree (AST) and evaluates your rules against each node individually. A rule for `git status` matches whether the command appears alone, chained with `&&`, or buried inside a longer pipeline, regardless of what other arguments are passed to it or what the working directory is. You write one rule per command instead of a growing list of rules chasing every new combination Claude invents.

### Relative paths are matched against your project directory

Rules that use relative path patterns apply only within your project directory. This covers both path arguments passed to commands and the working directory of any command in the pipeline. A rule like `path: "**/.env"` matches any `.env` file anywhere inside the project, and a rule like `cwd: "**/worktrees/**"` matches any command whose effective working directory falls inside a git worktree within the project. Neither rule will trigger outside the project. You can also write relative patterns that extend beyond the project root, such as `path: "../*"` to match paths one level up, if you need a rule to cover directories adjacent to your project.

This also means your rules travel with the project. A pattern like `path: "**/.env"` works on Alice's laptop at `/home/alice/projects/myapp` and on Bob's machine at `/home/bob/work/myapp` without any changes.

### Absolute paths are matched against your entire computer

If you want a rule to apply globally across your whole machine rather than just within the current project, use an absolute path pattern. A rule like `path: "/home/**/.ssh/id_rsa"` or `cwd: "/etc/**"` will match regardless of which project Claude is working in. This is useful for protecting sensitive files or system directories that live outside any project, such as SSH keys, AWS credentials, or system configuration files.

### Argument matching across flags and aliases

Claude Code permission patterns match the raw command string. A rule written to catch `rm -rf` will miss `rm -r -f`, `rm --recursive --force`, `rm -fr`, or any other combination that means the same thing. You would need a separate pattern for every permutation, and Claude will always find one you missed.

This plugin parses flags individually and normalises them, so a single rule can cover every syntactic form. A rule declaring `options: ["r|recursive", "f|force"]` matches when all listed flags are present, regardless of how they are written: `rm -rf`, `rm -fr`, `rm -r -f`, `rm --recursive --force`, and every other equivalent form. Use `options-in: [r, f]` when any one of the listed flags is sufficient to match the rule.

### Environment variables and working directory are tracked

In a pipeline like `cd /restricted && SECRET=1 some-tool --flag`, the working directory and the environment change mid-sequence. Claude Code sees none of that; it only sees the raw string. By the time Claude Code would evaluate a permission rule, the context is already lost.

This plugin simulates `cd` and environment-variable assignments as it walks the AST, so every command node in the pipeline is evaluated with the cwd and env vars it would actually have at runtime. A rule that checks `cwd` or a specific env var will see the right values no matter where in the pipeline the command appears.

## Installation

### Stable release

```
/plugin marketplace add ashleydavis/claude-permissions
/plugin install claude-permissions@claude-permissions
```

### Pre-release / testing (pin to `dev` branch)

```
/plugin marketplace add https://github.com/ashleydavis/claude-permissions.git#dev
/plugin install claude-permissions@claude-permissions
/plugin marketplace update ash-tools   # pull latest dev commits
```

## Verifying the plugin

To confirm the plugin is active and intercepting tool calls, ask Claude to run a command that has no matching rule. For example, ask it to run `echo hello`. With no rule covering `echo`, the plugin defaults to `ask` and you should see a confirmation prompt. If the command runs silently without any prompt, the plugin is not intercepting calls.

## Configuration

The plugin intercepts tool calls via a `PreToolUse` hook. When the plugin is installed, every tool call passes through the hook before it runs. The hook evaluates your `permissions.yaml` rules and returns `allow`, `deny`, or `ask`. This makes the plugin the sole decision-maker, so Claude Code's own permission system must be set to allow all tools. Otherwise Claude Code prompts separately before the hook even runs, resulting in double prompts.

> **Warning:** Only add the allow-all settings below after the plugin is installed and you have verified it is working (see [Verifying the plugin](#verifying-the-plugin)). Once the plugin is active, these settings are safe: every tool call is intercepted by the hook and evaluated against your `permissions.yaml` rules before anything runs, and any call with no matching rule defaults to `ask`. Without the plugin active, however, these settings remove all permission checks and Claude will run every tool call without prompting.

Add the following to your settings to allow all tools. This causes the plugin's hook to be the sole decision-maker while still respecting any `deny` rules in other settings files.

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

The plugin's PreToolUse hook fires on every tool call and enforces your `permissions.yaml` rules.

### Global configuration (applies to every project)

Add one of the blocks above to `~/.claude/settings.json`. Place your global rules in `~/.claude/permissions.yaml`. These apply to every project on your machine.

### Local project configuration (applies to one project)

Add one of the blocks above to `.claude/settings.json` in your project root. Place your project rules in `.claude/permissions.yaml` at the project root. These are layered on top of your global rules and take precedence when both match.

With either (or both) in place, every tool call flows through your `permissions.yaml` rules and nothing prompts twice.

## Quick start: adding a rule

Add to `.claude/permissions.yaml` in your project root (or `~/.claude/permissions.yaml` for user-global rules), then run `/reload-plugins` to pick up changes.

Following are some quick examples of rules.

Always allow `git status`:

```yaml
git:
  status:
    decide: allow
```

Deny `rm -rf`:

```yaml
rm:
  options:
    - r|recursive
    - f|force
  decide: deny
  reason: rm -rf in any format is not allowed
```

Ask before any `git add`, but deny `git add .` outright:

```yaml
git:
  add:
    pos: .
    decide: deny
    reason: Use specific files instead of "git add ."
```

For the full rule syntax (matchers, AND/OR logic, file-path rules, WebFetch rules, cwd scoping) see [docs/CONFIGURATION.md](docs/CONFIGURATION.md).

## Further reading

- [docs/CONFIGURATION.md](docs/CONFIGURATION.md) - Full rule syntax: matchers, AND/OR logic, file-path rules, WebFetch rules, and cwd scoping.
- [docs/PROTECTING-PRODUCTION.md](docs/PROTECTING-PRODUCTION.md) - Recipes for locking down production environments covering AWS CLI and kubectl.
- [docs/AUDIT-LOG.md](docs/AUDIT-LOG.md) - Audit log format and retention policy for the machine-readable and human-readable logs.
- [docs/HOW_IT_WORKS.md](docs/HOW_IT_WORKS.md) - Architecture deep-dive with AST diagrams, env-threading details, and a guide to writing non-trivial rules.
- [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) - Instructions on cloning, building, and running the plugin locally.

## License

MIT
