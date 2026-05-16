# Permission REPL

The permission REPL is an interactive terminal tool for testing commands against your `permissions.yaml` in real time. Type a command, see which rules fired, and get the final decision without having to involve Claude at all.

---

- [Running the REPL](#running-the-repl)
- [One-shot mode](#one-shot-mode)
- [Input prefix syntax](#input-prefix-syntax)
- [REPL commands](#repl-commands)
- [Reading the output](#reading-the-output)

---

## Running the REPL

From the project root:

```sh
bun run repl
```

Or with `CLAUDE_PROJECT_DIR` pointing at the project whose `permissions.yaml` you want to test:

```sh
CLAUDE_PROJECT_DIR=/path/to/project bun run repl
```

The REPL prints a startup banner showing the project directory and current working directory, then prompts:

```
permissions>
```

Type any Bash command (or a prefixed non-Bash tool call -- see below) and press Enter. The REPL evaluates it against your rules and prints a trace followed by the verdict.

## One-shot mode

Pass the command as a positional argument to skip the interactive session and print the result immediately:

```sh
bun run repl "git status"
```

This is useful for scripting and CI checks.

## Input prefix syntax

By default the input is treated as a Bash command. Prepend a prefix (case-insensitive) to test other tool types:

| Prefix | Tool | Example |
|---|---|---|
| `read <path>` | Read | `read /etc/hosts` |
| `write <path>` | Write | `write /tmp/out.txt` |
| `edit <path>` | Edit | `edit src/main.ts` |
| `webfetch <url>` | WebFetch | `webfetch https://api.example.com` |
| `tool <name>` | Generic tool | `tool mcp__github__create_issue` |
| (none) | Bash | `git push --force` |

## REPL commands

These control the session and are not evaluated as commands:

| Command | Effect |
|---|---|
| `:cwd <path>` | Change the working directory used for subsequent evaluations |
| `:quit` or `:q` | Exit the REPL |
| Ctrl-D | Exit the REPL |

Changing `:cwd` is useful when a rule uses `cwd` matching and you want to test it from different directories without leaving the session.

## Reading the output

Each evaluation prints a trace followed by a verdict line.

The trace shows every rule that ran (RULE), every leaf node where no rule matched (NOMATCH), and the aggregated decision at each tree node (NODE). `config_load` and `tool_request` entries are suppressed because they appear on every run and add noise.

The verdict line shows the decision in colour:

- **green** -- allow
- **red** -- deny
- **yellow** -- ask

If the decision carries a reason (from the `reason:` field of the matching rule), it appears after a dash on the same line.

Example output for `git status` with an allow rule:

```
  10:00:01  RULE               "git status" -> .claude/permissions.yaml:3 -> allow
  10:00:01  NODE               "git status" -> allow
  10:00:01  RESULT   Bash      "git status" -> ALLOW

ALLOW
```

Example output for `ls /tmp` with no matching rule:

```
  10:00:01  NOMATCH  command   "ls"
  10:00:01  RESULT   Bash      "ls /tmp" -> ASK

ASK
```

The REPL rebuilds the rule registry on every input, so edits to `permissions.yaml` or any file under `permissions.d/` are picked up immediately without restarting.
