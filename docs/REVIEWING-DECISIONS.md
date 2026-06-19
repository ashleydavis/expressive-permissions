# Reviewing decisions and closing rule gaps

How to take a decision the permissions plugin made (from the audit log or a pending approval prompt), understand why it happened, and turn an unconfigured command into a rule. This is the workflow behind the `/permissions:check`, `/permissions:allow`, and `/permissions:deny` commands, but it is just as useful by hand.

- [1. Read the snippet](#1-read-the-snippet)
- [2. Explain why the decision happened](#2-explain-why-the-decision-happened)
- [3. Find the gaps (NOMATCH)](#3-find-the-gaps-nomatch)
- [4. Judge whether a sub-command is safe](#4-judge-whether-a-sub-command-is-safe)
- [5. Apply a decision](#5-apply-a-decision)
- [6. Finish up](#6-finish-up)

---

## 1. Read the snippet

A decision comes from one of two sources. Identify which, then interpret it with the matching doc:

- **Audit log** line(s): `TOOL` / `RULE` / `NODE` / `NOMATCH` / `RESULT` / `EXECUTE` in the `.log` file, or `tool_request` / `rule_match` / `no_rule_match` / `aggregation` / `final_decision` / `tool_execution` objects in the `.json` file. See [AUDIT-LOG.md](AUDIT-LOG.md).
- **Pending approval file**: a Markdown file with Verdict, Command, Context, and Parsed command tree sections, written while an `ask` prompt is on screen. See [PENDING-APPROVALS.md](PENDING-APPROVALS.md) and the sample [example-pending-prompt-detail.md](plans/new/example-pending-prompt-detail.md).

From the snippet, extract for every leaf sub-command: the sub-command string, its decision, the rule that fired (`file:line`) and reason if any, and whether it was a **NOMATCH** (every rule abstained).

## 2. Explain why the decision happened

Walk the parsed command tree. For the whole command and each sub-command, state what was decided and which rule drove it (`file:line` + reason), or that nothing matched. The final result is the strictest decision across all nodes: `deny > ask > allow > abstain`. See [Strictest wins](CONFIGURATION.md#strictest-wins) and [Decision values](CONFIGURATION.md#decision-values).

## 3. Find the gaps (NOMATCH)

A **NOMATCH** / `no_rule_match` means no rule had anything to say, so the engine fell back to its default. These are the gaps to close with a new rule. See [Finding tool calls that no rule matched](CONFIGURATION.md#finding-tool-calls-that-no-rule-matched).

To confirm what the live engine currently does with a command (without running it), use the `analyze_permission` MCP tool, described in [MCP-SERVER.md](MCP-SERVER.md), or the offline [REPL](REPL.md).

## 4. Judge whether a sub-command is safe

Classify each unconfigured sub-command so you can recommend a decision. Name the concrete risk, not a generic warning.

| Class | What it means | Examples | Lean towards |
|---|---|---|---|
| **Safe / read-only** | Observes state only. No writes, no network, no arbitrary code, no destructive flags. | `ls`, `cat`, `grep`, `git status`, `kubectl get` | `allow`, scoped to the project where sensible |
| **Mutating but routine** | Changes local state in a recoverable way. | `mkdir`, `git commit`, `git add` | `ask`, so each one is reviewed |
| **Dangerous** | Destructive, hard to reverse, exfiltrates data, hits the network, escalates privilege, or runs arbitrary code. | `rm -rf`, `curl \| sh`, `git push --force`, `sudo` | `deny` |

A command can move between classes depending on its flags and arguments (a read-only tool with an in-place-edit flag is mutating; a path argument outside the project is riskier than one inside it). Judge the specific invocation in the snippet, not just the binary name.

## 5. Apply a decision

Write rules using [PERMISSIONS-QUICKREF.md](PERMISSIONS-QUICKREF.md) (quick syntax) or [CONFIGURATION.md](CONFIGURATION.md) (full reference). Key points:

- **Pick a file by category.** Group related rules into per-tool drop-in files, keeping read-only rules separate from state-changing ones, and prefer extending an existing file over creating a new one. See [Layered files](CONFIGURATION.md#layered-files-permissionsd). A `deny` in any layer beats every `allow`, so to deny something you only need to add a deny rule, never remove allows.
- **Nest bash rules** `bash` > command > subcommand; each level consumes one positional word. See [Subcommand matching](CONFIGURATION.md#subcommand-matching).
- **Scope `allow` rules tightly.** Anchor path arguments to the project with `${{PROJECT_DIR}}/**` ([Anchoring rules to the project directory](CONFIGURATION.md#anchoring-rules-to-the-project-directory)), and use `options` / `not:` to exclude dangerous flags ([Inverting matches](CONFIGURATION.md#inverting-matches)). Match the style of neighbouring rules in the same file.
- **Always add a short `reason:`.**
- **Add a command descriptor** only when a rule must match a flag's *value* and that flag takes an argument. See [Command descriptor files](CONFIGURATION.md#command-descriptor-files-commands).
- **Edit only the lines you need.** Do not reformat a file.

## 6. Finish up

- Report exactly which file(s) changed and the rule added.
- Run `/reload-plugins` so the plugin picks up the change.
- Re-run the command, or re-analyse it, to confirm the new decision. See [Confirming the config is loaded](CONFIGURATION.md#confirming-the-config-is-loaded).
