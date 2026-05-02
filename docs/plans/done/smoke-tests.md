# Plan: Smoke tests (e2e pipeline)

## Goal

End-to-end tests that feed real JSON into `src/hook.ts` via stdin, let the full pipeline run
(YAML config loading, AST building, rule evaluation), and compare `permissionDecision` and
`permissionDecisionReason` in the stdout JSON to expected values.

## Components

### 1. Test case format — `e2e/**/*.yaml`

Each file is a self-contained test case:

```yaml
description: "bash: deny rm by binary name"

input:
  tool_name: Bash
  tool_input:
    command: "rm file.txt"
  cwd: /home/user/project

rules:
  bash:
    rm:
      decide: deny
      reason: "rm is not allowed"

expected:
  decision: deny
  reason: "rm is not allowed"   # omit to skip reason comparison
```

The `rules` section is written verbatim as `.claude/permissions.yaml` for that test run.
The `expected.reason` field is optional — when absent the reason is not compared.

### 2. TypeScript runner — `src/run-e2e-test.ts`

Accepts a single test file path as `process.argv[2]`. For each run:

1. Parse the YAML file.
2. Create a temp directory with two subdirs: `home/` (empty) and `project/`.
3. Write the `rules` section as `project/.claude/permissions.yaml`.
4. Serialize `input` to JSON and spawn `bun src/hook.ts` as a subprocess with:
   - stdin: the input JSON
   - env: parent env minus `NODE_ENV`, with `HOME=<tmpdir>/home` and
     `CLAUDE_PROJECT_DIR=<tmpdir>/project`
5. Capture stdout, parse the JSON, extract `permissionDecision` and `permissionDecisionReason`.
6. Compare to `expected.decision` (required) and `expected.reason` (if present).
7. Print `PASS: <description>` or `FAIL: <description>` with a diff line.
8. Clean up the temp directory.
9. Exit 0 on pass, 1 on fail.

Setting `HOME` to an empty temp dir prevents the user's real `~/.claude/permissions.yaml`
from interfering with the test rules.

### 3. Shell driver — `smoke-tests.sh`

Located at the project root. Finds every `*.yaml` under `e2e/`, runs the TypeScript runner
for each, accumulates pass/fail counts, prints a summary, and exits 1 if any test failed.

```bash
#!/usr/bin/env bash
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PASS=0; FAIL=0; TOTAL=0
while IFS= read -r yaml_file; do
    TOTAL=$((TOTAL + 1))
    if bun run "$SCRIPT_DIR/src/run-e2e-test.ts" "$yaml_file"; then
        PASS=$((PASS + 1))
    else
        FAIL=$((FAIL + 1))
    fi
done < <(find "$SCRIPT_DIR/e2e" -name "*.yaml" | sort)
echo "Results: $PASS/$TOTAL passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
```

## Test coverage — `e2e/` directory

### `e2e/bash/` — Bash tool features

| File | Feature tested |
|------|----------------|
| `bash-allow-by-binary.yaml` | simple allow rule |
| `bash-deny-by-binary.yaml` | simple deny rule with reason |
| `bash-ask-by-binary.yaml` | ask rule with reason |
| `bash-no-rule-default-ask.yaml` | no matching rule → default ask |
| `bash-subcommand-allow.yaml` | `git status` subcommand allow |
| `bash-subcommand-deny.yaml` | `git push` subcommand deny |
| `bash-deep-subcommand.yaml` | `docker compose up` 3-level hierarchy |
| `bash-subcommand-no-match.yaml` | unmatched subcommand falls back to ask |
| `bash-args-flag-presence.yaml` | flag present (`-r`) → deny |
| `bash-args-alias.yaml` | flag alias (`--recursive` matches `r\|recursive`) |
| `bash-args-value-pattern.yaml` | flag value glob (`-m "wip*"`) |
| `bash-args-multiple-and.yaml` | multiple flags all required (AND) |
| `bash-args-in.yaml` | any of listed flags triggers (OR) |
| `bash-args-no-match.yaml` | flag absent → abstain → ask |
| `bash-pos-single.yaml` | single positional glob match |
| `bash-pos-array.yaml` | positional array AND match |
| `bash-pos-in.yaml` | any positional matches (OR) |
| `bash-pos-subcommand-offset.yaml` | positional checked after subcommand offset |
| `bash-cwd-glob.yaml` | cwd glob match |
| `bash-cwd-in.yaml` | cwd-in OR list match |
| `bash-cwd-resolved-true.yaml` | `cwd_resolved: true` matches resolved cwd |
| `bash-cwd-resolved-false.yaml` | `cwd_resolved: false` matches after `cd $UNKNOWN` |
| `bash-env-var.yaml` | env var match after export |
| `bash-host-single.yaml` | `host:` pattern for curl-like commands |
| `bash-host-in.yaml` | `host-in:` OR list |
| `bash-multiple-rules-deny-wins.yaml` | allow + deny → deny (strictest wins) |
| `bash-multiple-rules-ask-over-allow.yaml` | allow + ask → ask |
| `bash-regex-pattern.yaml` | `/regex/` pattern in pos field |
| `bash-and-both-allow.yaml` | `cmd1 && cmd2` both allow → allow |
| `bash-and-right-deny.yaml` | `cmd1 && cmd2` right deny → deny |
| `bash-or-left-deny.yaml` | `cmd1 \|\| cmd2` left deny → deny |
| `bash-pipe-both-allow.yaml` | `cmd1 \| cmd2` both allow → allow |
| `bash-seq-right-deny.yaml` | `cmd1; cmd2` right deny → deny |

### `e2e/integration/` — Built-in rule + env threading

| File | Feature tested |
|------|----------------|
| `cd-cwd-update.yaml` | `cd /foo/bar; cmd` — cwd rule fires with new cwd |
| `env-prefix.yaml` | `FOO=bar cmd` — env prefix visible to same-command rule |
| `env-set-sequence.yaml` | `FOO=bar; cmd` — standalone assignment visible downstream |
| `export-sequence.yaml` | `export FOO=bar; cmd` — export visible downstream |

### `e2e/file/` — File tool features

| File | Feature tested |
|------|----------------|
| `read-allow.yaml` | path glob allow |
| `read-deny-sensitive.yaml` | `**/.env*` deny with reason |
| `read-path-in.yaml` | `path-in:` OR list deny |
| `read-no-rule.yaml` | no rule → ask |
| `write-allow.yaml` | write path allow |
| `write-deny.yaml` | write to `/etc/**` deny |
| `edit-allow.yaml` | edit `**/*.ts` allow |
| `edit-deny.yaml` | edit `/etc/**` deny |
| `multiedit-allow.yaml` | multi_edit path allow |
| `multiedit-deny.yaml` | multi_edit path deny |

### `e2e/webfetch/` — WebFetch tool

| File | Feature tested |
|------|----------------|
| `webfetch-host-allow.yaml` | exact hostname allow |
| `webfetch-host-deny.yaml` | exact hostname deny with reason |
| `webfetch-host-in.yaml` | `host-in:` OR list allow |
| `webfetch-no-rule.yaml` | no rule → ask |

### `e2e/mcp/` — MCP tool

| File | Feature tested |
|------|----------------|
| `mcp-tool-allow.yaml` | `tool:` glob allow |
| `mcp-tool-deny.yaml` | `tool:` glob deny with reason |
| `mcp-tool-in.yaml` | `tool-in:` OR list allow |
| `mcp-glob-deny.yaml` | broad glob deny |
| `mcp-no-rule.yaml` | no rule → ask |

## Dependencies

This plan depends on the `fix-reason-forwarding` plan being implemented first, so that
`expected.reason` assertions in the YAML files actually verify meaningful behaviour.

## Critical files

- `src/run-e2e-test.ts` — new file
- `smoke-tests.sh` — new file at project root
- `e2e/` — new directory with ~56 YAML files
