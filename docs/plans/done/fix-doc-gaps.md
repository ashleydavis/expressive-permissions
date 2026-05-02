# Plan: Fix documentation gaps exposed by new tests

## Background

27 new tests were added to `src/test/load-config.test.ts` to cover every YAML example in `README.md` and `docs/USER-DEFINED-RULES.md`. 9 of them fail, exposing gaps between the documented behaviour and the code. This plan fixes all 9.

---

## Gap 1 — `args` object with boolean `true` value does not match flag presence

**Failing test:** `USER-DEFINED-RULES: args object boolean true value matches flag presence`

**Symptom:** The docs show this as a valid way to check flag presence via the object form of `args`:

```yaml
rm:
  args:
    r|recursive: true
  decide: deny
```

`rm -r` produces `node.args = { r: true }`. In `matchesArgs`, the code does `if (typeof val !== "string") { return false; }` which filters out boolean flag values, so the rule always abstains.

**Fix:** In `matchesArgs` in `src/load-config.ts`, when the YAML pattern for an object key is not a string (e.g., boolean `true`), treat it as a presence check using `flagPresent` rather than a value match.

```typescript
// Before
const val = flagValue(aliasExpr, node.args);
if (val === undefined) { return false; }
if (typeof val !== "string") { return false; }
if (!matchesPattern(pattern, val)) { return false; }

// After
if (typeof pattern !== "string") {
    if (!flagPresent(aliasExpr, node.args)) { return false; }
} else {
    const val = flagValue(aliasExpr, node.args);
    if (val === undefined) { return false; }
    if (typeof val !== "string") { return false; }
    if (!matchesPattern(pattern, val)) { return false; }
}
```

**Files:** `src/load-config.ts` (`matchesArgs`), `src/test/load-config.test.ts` (test passes after fix — no test changes needed).

---

## Gap 2 — `host` field silently ignored in bash rules

**Failing test:** `USER-DEFINED-RULES: curl host in bash rules - internal host → allow, external → ask`

**Symptom:** The docs show this under "Top-level binary (no subcommand)":

```yaml
bash:
  curl:
    - host: "*.internal.example.com"
      decide: allow
    - decide: ask
```

`host` is in `KNOWN_FIELDS` so it is not treated as a subcommand key, but `buildBashRule` never reads `entry.host`. The rule becomes a catch-all that fires on every `curl` invocation. Both rules fire for every URL and `ask` (rank 3) beats `allow` (rank 2), so the result is always `ask`.

**Fix:** In `buildBashRule`, after the existing matchers, add host matching by extracting the hostname from the first URL-shaped positional argument (i.e., `pos[posOffset]`):

```typescript
if (entry.host !== undefined || entry["host-in"] !== undefined) {
    const urlArg = posArray[posOffset];
    const hostname = urlArg !== undefined ? extractHost(urlArg) : "";
    if (entry["host-in"] !== undefined) {
        const hostIn = entry["host-in"] as string[];
        if (!hostIn.some((pattern: string) => matchesPattern(pattern, hostname))) {
            return ABSTAIN;
        }
    } else if (entry.host !== undefined) {
        if (!matchesPattern(entry.host, hostname)) {
            return ABSTAIN;
        }
    }
}
```

`extractHost` is already defined in `src/load-config.ts` for the webfetch rule builder.

**Files:** `src/load-config.ts` (`buildBashRule`), `src/test/load-config.test.ts` (test passes after fix).

---

## Gap 3 — `allow` + `ask` catch-all: six patterns documented as working do not

**Failing tests:**
- `USER-DEFINED-RULES: npm install ask, npm run build/test/lint allow, npm run other ask`
- `USER-DEFINED-RULES: edit list allows src files and asks for others`
- `USER-DEFINED-RULES: webfetch known hosts allow, unknown host ask`
- `USER-DEFINED-RULES: webfetch deny internal, allow known, ask others`
- `USER-DEFINED-RULES: MCP list operations allow, delete deny, others ask`
- `README table: webfetch docs.anthropic.com allow, unknown host ask`

**Root cause:** Strictest-wins aggregation means `ask` (rank 2) beats `allow` (rank 1). When a specific `allow` rule and a broad `ask` catch-all both match the same command, `ask` always wins.

**Fix:** The default behaviour when no rule matches is already `ask`, so an explicit `ask` catch-all is redundant and harmful. Remove the `- decide: ask` catch-all lines from all doc examples. Commands not matched by any rule fall through to the default `ask` automatically.

**Files:** `docs/USER-DEFINED-RULES.md`, `README.md` (doc-only fix — no code changes), `src/test/load-config.test.ts` (update 6 failing test YAML fixtures to remove the catch-all ask).

---

## Gap 4 — `cwd: ./**` does not scope to the current project directory

**Failing test:** `USER-DEFINED-RULES: cwd ./** is scoped to the current project directory`

**Symptom:** The docs say:

> In a `.claude/permissions.yaml` at your repo root, `cwd: ./**` means "anywhere within the current project".

But `picomatch` strips the `./` prefix before matching, so `./**` compiles to `**` and matches every absolute path on the machine. A rule with `cwd: ./**` fires for commands run in `/some/other/path` just as readily as inside the project.

**Fix:** In `loadConfigRules` (or a helper it calls), after loading each YAML file, resolve any `cwd` patterns that begin with `./` against the directory of that config file. Concretely, when loading `projectDir/.claude/permissions.yaml`, replace `./` at the start of any `cwd` (and `cwd-in` entries) with `<projectDir>/`:

```typescript
// After loading projectYaml, before compiling:
resolveRelativeCwdPatterns(projectYaml, projectDir);
// Same for homeYaml with homeDir
```

```typescript
function resolveRelativeCwdPatterns(config: IYamlConfig, baseDir: string): void {
    // Walk every IYamlEntry in bash/read/write/edit/multi_edit/webfetch/mcp sections
    // and rewrite entry.cwd / entry["cwd-in"] when they start with "./"
}
```

`./` at the start of `cwd: ./**` becomes `<projectDir>/`, so the compiled pattern is `<projectDir>/**`, which matches only paths under the project root.

**Files:** `src/load-config.ts`, `src/test/load-config.test.ts` (test passes after fix).

---

## Summary of changes

| File | Changes |
|---|---|
| `src/load-config.ts` | Fix boolean `true` in object `args`; add `host`/`host-in` matching in `buildBashRule`; add relative `cwd` resolution |
| `docs/USER-DEFINED-RULES.md` | Remove redundant `ask` catch-alls from all examples |
| `README.md` | Remove redundant `ask` catch-all from git add example |
| `src/test/load-config.test.ts` | Update 6 failing tests to remove `ask` catch-all from YAML fixtures |

## Open question

Gap 4 (`cwd: ./**`) requires walking every `IYamlEntry` in the config tree, which is structurally the same walk that `compileBashBinary` already does. Consider whether `resolveRelativeCwdPatterns` should be a pre-pass over the raw YAML object or whether `cwd` resolution should happen inside the individual `matchesCwd` call (passing the `baseDir` through the compilation context). The pre-pass approach is simpler but requires duplicating the tree walk; the compilation-context approach avoids that but means threading `baseDir` through several functions.
