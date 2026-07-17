# Publishing

This doc explains how the plugin is packaged, released, and validated for marketplace distribution.

## Plugin layout

The `plugin/` subdirectory is the distribution subtree:

```
plugin/
├── .claude-plugin/
│   └── plugin.json     # manifest
├── hooks/
│   └── hooks.json      # registers the PreToolUse and PostToolUse hooks (node)
├── .mcp.json           # registers the MCP server for plugin users (node)
└── dist/
    ├── pre-hook.js     # bundled PreToolUse entry point: commit this
    ├── post-hook.js    # bundled PostToolUse entry point: commit this
    └── mcp-server.js   # bundled MCP server: commit this
```

Commit all three dist files so users installing from a path or the marketplace don't need to run a build step themselves. Run `bun run bundle` before committing to keep all three up to date.

## Marketplace install

The plugin is distributed via the Claude Code marketplace system. The repo root contains `.claude-plugin/marketplace.json` which lists the plugin at `./plugin`. Users install it with:

```
/plugin marketplace add ashleydavis/expressive-permissions
/plugin install expressive-permissions
```

## Release

Before tagging a release, bundle all three dist files so the committed files are up to date:

```bash
bun run bundle
git add plugin/dist/pre-hook.js plugin/dist/post-hook.js plugin/dist/mcp-server.js
git commit -m "bundle for release"
git tag v1.2.3
git push origin v1.2.3
```

The `publish` GitHub Actions workflow triggers on tags matching `v*.*.*` and runs compile, Jest tests, and the smoke tests as a final validation gate.
