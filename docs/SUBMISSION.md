# Community marketplace submission

This doc has paste-ready copy for the Claude plugin submission form.

- Repo URL: https://github.com/ashleydavis/expressive-permissions
- Plugin name: expressive-permissions
- Marketplace: codecapers

## Plugin description

expressive-permissions extends Claude Code's tool-level permission checks with fine-grained, flexible, rule-based decisions. It intercepts every tool call via a PreToolUse hook, parses Bash commands into an abstract syntax tree, threads a simulated environment (working directory + env vars) through that tree, and evaluates your YAML rules at every node. Decisions aggregate strictest-wins and fall back to "ask" for anything not explicitly allowed or denied.

Key features:

- Per-command rules that match inside pipelines regardless of order, chaining, or surrounding commands, so you write one rule instead of chasing every combination.
- Flag normalization: a single rule matches `rm -rf`, `rm -fr`, `rm -r -f`, `rm --recursive --force`, and every equivalent form.
- Path-aware matching: relative patterns are scoped to your project; absolute patterns apply across the whole machine.
- Tracks `cd` and inline env-var assignments mid-pipeline, so rules see the real working directory and environment.
- Environment-scoped rules (e.g. allow writes under a sandbox AWS profile, deny in production).
- Full audit log of every decision and tool result, plus a REPL and an MCP server that explains why a command was allowed or denied.

## Example use cases

Example 1: Always allow read-only git (`git status`, `git diff`, `git log`) with no prompt, ask before `git add`, and deny `git add .` outright.

Example 2: Deny `rm -rf` in any form and block writes/edits to `.env` files; ask before reading secrets like `~/.ssh/id_rsa` or `~/.aws/credentials`.

Example 3: Protect production: allow `aws describe-*/list-*/get-*` and `kubectl get/describe/logs` everywhere, but deny destructive AWS or kubectl operations unless the active AWS profile or kube-context is a sandbox.

Example 4: Allow `WebFetch` to trusted hosts (e.g. `docs.anthropic.com`) and ask for any unknown host.
