# Audit Log

This doc explains the audit log format, location, and retention for permission decisions and tool executions.

## Location

Every hook invocation writes structured entries to `.claude/permissions-log/` inside the project root. The plugin uses `CLAUDE_PROJECT_DIR` to locate that directory, which Claude Code always sets when invoking hooks.

Files are partitioned by hour in local time. Two files are written per hour to the same directory:

```
.claude/permissions-log/
└── YYYY-MM/
    └── DD/
        ├── HH.json   # JSON Lines: one entry per line, machine-readable
        └── HH.log    # plain text: human-readable summary
```

## Retention

On every hook invocation the plugin automatically removes month directories older than two calendar months. The three most recent months (including the current one) are always kept.

## Format

**`.json`**: [JSON Lines](https://jsonlines.org/) (NDJSON): one JSON object per line, newline-terminated, UTF-8 encoded. Intended for programmatic querying with tools like `jq`.

**`.log`**: plain text, one line per entry, intended for direct human reading. All timestamps use ISO 8601 format in local time with timezone offset.

### Human-readable example (`.log`)

```
10:23:01  TOOL     Bash      "ls && rm -rf /"
10:23:01  RULE               "ls" → .claude/permissions.yaml:4 → allow
10:23:01  RULE               "rm -rf /" → .claude/permissions.yaml:8 → deny "rm is not allowed"
10:23:01  NODE               "ls && rm -rf /" → deny "rm is not allowed"
10:23:01  RESULT   Bash      "ls && rm -rf /" → DENY "rm is not allowed"
10:23:02  EXECUTE  Bash      "ls -la"
```

Columns: `HH:MM:SS`, label (9 chars), tool name (10 chars), then the entry detail. The tool name column is blank on `RULE` and `NODE` lines.

For an allowed tool the full sequence is: `TOOL` (request received) → `RULE`/`NODE` lines → `RESULT` (decision) → `EXECUTE` (tool ran, written by the PostToolUse hook). When a tool is denied there is no `EXECUTE` line.

`RULE` lines show the matched sub-command, the source file and line of the rule that fired, and the decision. `NODE` lines show the aggregated decision at each intermediate AST node (e.g. a `&&` expression).

### Entry types

| Type | Written by | When |
|---|---|---|
| `config_load` | `pre-hook.js` | Once per config file loaded |
| `tool_request` | `pre-hook.js` | Once per invocation, before decisions |
| `rule_match` | `pre-hook.js` | Once per non-abstaining rule at a node |
| `no_rule_match` | `pre-hook.js` | Once per node where every rule abstained (`.log` label `NOMATCH`) |
| `aggregation` | `pre-hook.js` | Once per intermediate node after combining children and own rules |
| `final_decision` | `pre-hook.js` | Once per invocation before returning |
| `tool_execution` | `post-hook.js` | Once per allowed tool execution |

### JSON Lines entry types (`.json`)

**`config_load`**: logged once per config file loaded. In the `.log` file this appears as a `CONFIG` line at the top of the hour.

```json
{"type":"config_load","timestamp":"2025-06-15T10:00:00.000+10:00","filePath":".claude/permissions.yaml","ruleCount":12}
```

**`tool_request`**: logged once per hook invocation before any rule evaluation.

```json
{"type":"tool_request","timestamp":"2025-06-15T10:23:01.000+10:00","tool":"Bash","input":{"command":"ls -la"},"cwd":"/home/user/project"}
```

**`rule_match`**: logged for each rule that returns a non-abstain decision. `ruleFile` and `ruleLine` identify the source of the rule; both are omitted for built-in rules that have no source file.

```json
{"type":"rule_match","timestamp":"2025-06-15T10:23:01.001+10:00","ruleFile":".claude/permissions.yaml","ruleLine":4,"cmd":"ls","decision":"allow"}
```

**`no_rule_match`**: logged for each AST node (command, read, write, edit, multiedit, other) where every rule abstained. Surfaces gaps in the user's `permissions.yaml`.

```json
{"type":"no_rule_match","timestamp":"2025-06-15T10:23:01.001+10:00","nodeType":"command","cmd":"pwd"}
```

In the `.log` file this appears as a `NOMATCH` line; the second column is the AST node type and the third is the `cmd` value the engine tried to match (command text or file path).

**`aggregation`**: logged once per intermediate AST node (bash root, binop) after combining children and own-rule results.

```json
{"type":"aggregation","timestamp":"2025-06-15T10:23:01.002+10:00","cmd":"ls && rm -rf /","decision":"deny","reason":"rm is not allowed"}
```

**`final_decision`**: logged once per hook invocation just before returning the result.

```json
{"type":"final_decision","timestamp":"2025-06-15T10:23:01.003+10:00","tool":"Bash","cmd":"ls && rm -rf /","decision":"deny","reason":"rm is not allowed"}
```

**`tool_execution`**: logged once per PostToolUse invocation, after the tool has run. Only appears for tools that were allowed (denied tools never execute).

```json
{"type":"tool_execution","timestamp":"2025-06-15T10:23:02.000+10:00","tool":"Bash","input":{"command":"ls -la"},"cwd":"/home/user/project","response":{"output":"total 8\n...","isError":false},"isError":false}
```

`isError` is extracted as a first-class field from the tool response for easy filtering. The full raw response is stored in `response`.

## Useful one-liners

Tail the current hour's human-readable log:

```sh
tail -f .claude/permissions-log/$(date +%Y-%m/%d/%H).log
```

View all blocked commands (JSON):

```sh
grep '"decision":"deny"' .claude/permissions-log/**/*.json
```

View all approved commands (JSON):

```sh
grep '"decision":"allow"' .claude/permissions-log/**/*.json
```

View all tool executions that errored:

```sh
grep '"type":"tool_execution"' .claude/permissions-log/**/*.json | grep '"isError":true'
```

## Pending approval files

When the pre-hook returns `ask`, a separate Markdown file is written under `.claude/permissions-log/pending/` for use while the approval prompt is on screen. These files are not part of the hourly audit log. See [PENDING-APPROVALS.md](PENDING-APPROVALS.md) for the format, lifecycle, and how to list outstanding prompts.
