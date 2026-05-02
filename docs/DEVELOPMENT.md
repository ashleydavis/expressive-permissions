# Development guide

For contributors and anyone who wants to write TypeScript rules, run tests, or publish the plugin.

## Prerequisites

- [Bun](https://bun.sh) — runtime, bundler, and package manager

```bash
git clone https://github.com/ashleydavis/claude-permissions
cd claude-permissions
bun install
bun bundle   # bundle plugin/dist/hook.js
```

## Running it during development

From inside the repo:

```bash
claude --plugin-dir ./plugin
```

Or from any other project directory:

```bash
claude --plugin-dir /path/to/claude-permissions/plugin
```

After editing rules, rebuild and reload:

```bash
bun bundle && /reload-plugins
```

## How to test the plugin is working

Once Claude is running with the plugin loaded, ask it to run a command that has no matching rule — for example `echo hello`. With no rule covering `echo`, the plugin defaults to `ask` and you should see a confirmation prompt. If the command runs silently without any prompt, the plugin is not intercepting calls.

To confirm the plugin itself loaded without errors, check the Claude startup output for a line referencing the hook, or run:

```bash
/plugins
```

This lists all active plugins. `claude-permissions` should appear in the list.

If the hook is silently not firing, the most common causes are:

- `plugin/dist/hook.js` is missing — run `bun bundle` to generate it.
- The plugin directory path is wrong — verify the path passed to `--plugin-dir` points to the `plugin/` subdirectory, not the repo root.
- A stale hook after editing source — run `bun bundle && /reload-plugins`.

## Scripts

| Script | Short | Description |
|---|---|---|
| `bundle` | `b` | Bundle `src/hook.ts` → `plugin/dist/hook.js` |
| `compile` | `c` | TypeScript type-check (no emit) |
| `test` | `t` | Run Jest unit tests |
| `test:watch` | `tw` | Jest in watch mode |
| `smoke` | — | Bundle then run smoke tests |
| `dev` | `d` | Start Claude Code with the plugin loaded from this repo |

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
import { makeCommand, makeArgs, makeEnv, dummyCall } from "../../rules/test-helpers.js";

describe("blockCurl", () => {
    test("denies curl", () => {
        expect(blockCurl(makeCommand("curl", makeArgs({}, ["https://example.com"])), makeEnv(), dummyCall))
            .toMatchObject({ decision: { action: "deny" } });
    });
    test("abstains on other binaries", () => {
        expect(blockCurl(makeCommand("wget", makeArgs({}, [])), makeEnv(), dummyCall))
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
bun bundle && /reload-plugins
```

### What a rule can match

Match on `node.kind` to target the right call type:

| `node.type` | When it matches | Key fields |
|---|---|---|
| `"command"` | Bash leaf (one command in a pipeline) | `binary`, `args`, `envPrefix`, `raw` |
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

Unit tests live under `src/test/` mirroring the source tree. `src/test/hook.test.ts` covers the hook runner (stdin parsing, stdout output, error path). Run `bun run smoke` to build and then run the end-to-end smoke tests in `scripts/smoke-tests.sh`.

## Publishing

The `plugin/` subdirectory is the distribution subtree:

```
plugin/
├── .claude-plugin/
│   └── plugin.json     # manifest
├── hooks/
│   └── hooks.json      # registers the PreToolUse hook
└── dist/
    └── hook.js         # bundled output — commit this
```

Commit `plugin/dist/hook.js` so users installing from a path or the marketplace don't need to run a build step themselves. Run `bun bundle` before committing to keep it up to date.

The plugin is distributed via the Claude Code marketplace system. The repo root contains `.claude-plugin/marketplace.json` which lists the plugin at `./plugin`. Users install it with:

```
/plugin marketplace add ashleydavis/claude-permissions
/plugin install claude-permissions
```

Before tagging a release, bundle the hook so the committed `plugin/dist/hook.js` is up to date:

```bash
bun bundle
git add plugin/dist/hook.js
git commit -m "bundle for release"
git tag v1.2.3
git push origin v1.2.3
```

The `publish` GitHub Actions workflow triggers on tags matching `v*.*.*` and runs compile, Jest tests, and both smoke test suites as a final validation gate.

The `ci` workflow runs on every push and pull request: compile, Jest tests, `scripts/smoke-tests.sh`, and `smoke-tests-bash-parser.sh`.
