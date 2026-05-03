# Audit Log

Every tool call processed by the permissions hook is recorded to an audit log so you can review exactly what was allowed, denied, or escalated and why.

## Location

Log files are written to:

```
<project-dir>/.claude/permissions-log/YYYY-MM/DD/HH.log
```

One file is created per local hour. The plugin uses `CLAUDE_PROJECT_DIR` to locate the project directory, which Claude Code always sets when invoking hooks.

## Retention

On every hook invocation the plugin automatically removes month directories older than two calendar months. The three most recent months (including the current one) are always kept.

## Format

Each log file is [JSON Lines](https://jsonlines.org/) (NDJSON): one JSON object per line, newline-terminated, UTF-8 encoded. All timestamps use ISO 8601 format in local time with timezone offset.

### Entry types

**`tool_request`** — logged once per hook invocation before any rule evaluation.

```json
{"type":"tool_request","timestamp":"2025-06-15T10:23:01.000+10:00","tool":"Bash","input":{"command":"ls -la"},"cwd":"/home/user/project"}
```

**`rule_match`** — logged for each rule that returns a non-abstain decision.

```json
{"type":"rule_match","timestamp":"2025-06-15T10:23:01.001+10:00","nodeType":"command","ruleName":"ls","decision":"allow"}
```

**`aggregation`** — logged once per intermediate AST node (bash root, binop) after combining children and own-rule results.

```json
{"type":"aggregation","timestamp":"2025-06-15T10:23:01.002+10:00","nodeType":"bash","childrenDecision":"allow","ownDecision":"abstain","combined":"allow"}
```

**`final_decision`** — logged once per hook invocation just before returning the result.

```json
{"type":"final_decision","timestamp":"2025-06-15T10:23:01.003+10:00","tool":"Bash","decision":"allow"}
```

## Useful one-liners

View all blocked commands:

```sh
grep '"decision":"deny"' .claude/permissions-log/**/*.log
```

View all approved commands:

```sh
grep '"decision":"allow"' .claude/permissions-log/**/*.log
```

Tail the current hour's log file (replace date/hour as needed):

```sh
tail -f .claude/permissions-log/$(date +%Y-%m/%d/%H).log
```
