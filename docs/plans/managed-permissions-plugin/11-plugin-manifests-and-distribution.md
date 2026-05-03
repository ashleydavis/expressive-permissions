# Step 11: Plugin manifests and distribution layout

Create all Claude Code plugin manifest files, set up the `plugin/` distribution subtree, and add `marketplace.json` for self-hosted publishing.

## Files to create

- `plugin/.claude-plugin/plugin.json` — plugin manifest: `name: "claude-permissions"`, `description`, `version: "0.1.0"`, `author`.
- `plugin/hooks/hooks.json` — one `PreToolUse` entry: `matcher: "*"`, `command: "bun ${CLAUDE_PLUGIN_ROOT}/dist/hook.js"`.
- `.claude-plugin/marketplace.json` — marketplace catalog: `name: "ash-tools"`, owner Ashley Davis, one plugin entry pointing at `source: "./plugin"`.

Note: `plugin/dist/hook.js` is produced by `bun bundle` (Step 10) — it must be committed so the plugin works without a build step on the user's machine.

## Local dev verification

Run:

```
claude --plugin-dir /home/ash/projects/claude-permissions
```

Inside Claude Code, confirm:
- The plugin loads without errors.
- Ask Claude to run `echo hello` — confirm Claude Code's permission dialog appears (default `ask` path for unmatched rules).
- Ask Claude to run `rm -rf /` — confirm the call is blocked with the deny reason.
- Ask Claude to run `git status` — confirm it runs without a prompt (allow path).

Run all tests and confirm they pass before marking this step complete.
