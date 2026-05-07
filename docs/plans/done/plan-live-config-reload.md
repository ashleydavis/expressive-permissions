# Live Configuration Reload (Layered Rule Registry)

## Overview

Replace the flat `rules: Rule[]` export in `src/rules/index.ts` with a layered registry. Rules are private to each layer; no layer or registry method exposes them. All rule-running logic is delegated down the chain:

```
Hook (interpret.ts) → RuleRegistry → RuleLayer | FileLayer → Rule
```

**Three layers:**
1. Built-in rules (static, never reloads)
2. Home config (`~/.claude/permissions.yaml`) — reloads when the file changes
3. Project config (`.claude/permissions.yaml`) — reloads when the file changes

**Behavior change:** The current implementation shallow-merges both YAML configs before compiling, so any top-level section (`bash`, `read`, `write`, `edit`, `multi_edit`, `webfetch`, `mcp`) defined in both files has the home version silently replaced. With layers, both files are compiled independently and all their rules are evaluated.

## Steps

### 1. Extract helpers from `interpret.ts` to break future circular imports

`rule-registry.ts` will need several symbols currently in `interpret.ts`. If it imported them from there, a circular dependency would form (`rule-registry` → `interpret` → `rules/index` → `rule-registry`). Move them first:

**Move to `src/build-ast.ts`:** `expandToken`, `expandCommandOptions`, `describeNode` — all operate on AST nodes and belong there. Update `interpret.ts` imports accordingly. Move their unit tests to the corresponding `build-ast` test file.

**Move to `src/types.ts`:** `IRunRulesResult` (the return type of `runRules`) and `rank` (the decision ranking function). Update `interpret.ts` imports accordingly. Move any unit tests for `rank` to a `types` test file.

### 2. New `src/rule-registry.ts`

```typescript
interface IRuleLayer {
    runRules(node: AstNode, env: Environment, call: ToolCall, logger: IAuditLogger): IRunRulesResult;
}

interface IRuleRegistry {
    runRules(node: AstNode, env: Environment, call: ToolCall, logger: IAuditLogger): IRunRulesResult;
}

class RuleLayer implements IRuleLayer {
    private readonly _rules: Rule[];
    constructor(rules: Rule[]);
}

class FileLayer implements IRuleLayer {
    private _rules: Rule[];
    constructor(loadFn: () => Rule[], filePath: string | undefined);
}

class RuleRegistry implements IRuleRegistry {
    private readonly _layers: IRuleLayer[];
    constructor(layers: IRuleLayer[]);
}
```

`RuleLayer.runRules` iterates `_rules` privately: for each rule, expands command options against the current running env, calls the rule, threads persistent/scoped env updates, logs non-abstaining outcomes to the audit logger, short-circuits on deny, and accumulates strictest-wins.

`FileLayer` constructor takes a `filePath` (the full path to `permissions.yaml`, or `undefined`) and uses `fs.watchFile` to watch that exact file. Unlike `fs.watch`, `fs.watchFile` works even when the file does not yet exist — no async existence check, no static factory, no top-level await needed. The constructor calls `loadFn` immediately to populate `_rules`, then registers `fs.watchFile(filePath, { persistent: false }, callback)`. When the file changes or is created, the callback calls `loadFn` again to refresh `_rules`. `FileLayer.runRules` is identical to `RuleLayer.runRules`.

`RuleRegistry.runRules` iterates `_layers`: calls each layer's `runRules` with the current env, threads the persistent env from each layer's result to the next, short-circuits on deny, and accumulates strictest-wins across layers.

Export all five symbols.

### 3. `src/load-config.ts` — add per-file loading helpers

Add three new exported functions. Keep `loadConfigRules()` unchanged so its existing tests continue to pass.

**`loadConfigRulesFromFile(filePath, displayFile, baseDir)`** — reads and compiles a single YAML file. Returns `[]` if the file does not exist. This extracts and reuses the core logic already in `loadConfigRules`.

**`loadHomeConfigRules()`** — resolves `$HOME/.claude/permissions.yaml` and delegates to `loadConfigRulesFromFile`. Returns `[]` if `HOME` is unset.

**`loadProjectConfigRules()`** — resolves `$CLAUDE_PROJECT_DIR/.claude/permissions.yaml` and delegates to `loadConfigRulesFromFile`. Returns `[]` if `CLAUDE_PROJECT_DIR` is unset.

### 4. `src/rules/index.ts` — rewrite with three layers

Create one `RuleLayer` for the four built-in rules. Create two `FileLayer` instances: one for the home config (passing `loadHomeConfigRules` and the full path to `$HOME/.claude/permissions.yaml`) and one for the project config (passing `loadProjectConfigRules` and the full path to `$CLAUDE_PROJECT_DIR/.claude/permissions.yaml`). Pass `undefined` as the file path when the relevant env var is absent.

Construct `RuleRegistry` with the three layers in order and export it as `registry`. Remove the old `rules` export.

### 5. `src/interpret.ts` — remove `runRules`, call registry

Remove the `runRules` function. At the call site, replace `runRules(node, env, call, logger)` with `registry.runRules(node, env, call, logger)`. Import `registry` from `./rules` instead of `rules`.

### 6. `docs/HOW_IT_WORKS.md` — update section 7

In "Registry ordering and conflict resolution", replace the description of the flat array and `loadConfigRules()` merge with the three-layer delegation model: `Hook → RuleRegistry → RuleLayer | FileLayer → Rule`. Note that both config files are always evaluated independently.

## File Watching

`FileLayer` watches for config changes using `fs.watchFile`:

- At construction time, if `filePath` is defined, `fs.watchFile(filePath, { persistent: false }, callback)` is registered. `fs.watchFile` uses `stat`-based polling and works even when the file does not yet exist — no existence check is required.
- The `persistent: false` option means the watcher does not keep the process alive — it will exit naturally when other work is done.
- The callback fires whenever the file's `mtime` changes (created, modified, or deleted). The load function is called again and `_rules` is reassigned with the freshly compiled result.
- Because `runRules` reads `_rules` each time it is called, the next rule evaluation after a reload automatically uses the updated rules. No restart is required.
- On deletion, `loadFn` returns `[]` (file absent), so the layer goes silent until the file is recreated and the watcher fires again.

## Unit Tests

Each new class (`RuleLayer`, `FileLayer`, `RuleRegistry`) and each new function in `load-config.ts` must have unit tests. Tests verify behavior through `runRules` only — no direct rule access.

## Smoke Tests

Add a new smoke test that proves both config files are loaded and active simultaneously. The test should set up both a home `permissions.yaml` and a project `permissions.yaml` with non-overlapping rules, then verify that a tool call covered only by the home config resolves correctly and a tool call covered only by the project config also resolves correctly.

## Verify

```
bun run compile   # zero TypeScript errors
bun run test      # all tests pass including new registry and layer tests
bun run smoke     # existing smoke tests unaffected
```

## Notes

- `FileLayer` uses `fs.watchFile` (polling-based, not `fs.watch`). It works on files that do not yet exist, so no existence check — sync or async — is required.
- `IRunRulesResult` and `rank` move to `types.ts`; `expandToken`, `expandCommandOptions`, `describeNode` move to `build-ast.ts`. These moves are prerequisites to avoid the circular import.
- `loadConfigRules()` is kept unchanged so its existing tests pass without modification.
- The env threading between layers ensures that built-in rules (e.g. `envPrefixRule`) update the env before YAML rules in later layers evaluate it — preserving the existing cross-rule env visibility guarantee.
