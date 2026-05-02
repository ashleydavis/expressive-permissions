# Step 12: Update documentation

Review `README.md` and `docs/HOW_IT_WORKS.md` against the finished code and correct anything that drifted during implementation.

## What to check

Review each of the following docs alongside the corresponding source files:

- `README.md`
- `docs/HOW_IT_WORKS.md`
- `docs/USER-DEFINED-RULES.md`
- `docs/DEVELOPMENT.md`

Specific things to verify in each:

- **Scripts table** — verify every script name and command matches `package.json` exactly.
- **File paths** — confirm all source paths cited in the docs exist (e.g. `src/rules/`, `plugin/dist/hook.js`).
- **Rule names and behaviour** — check the built-in rules table and user rules table reflect what actually shipped (names, what they match, what decision they return).
- **YAML schema** — verify the matcher field reference table in `docs/USER-DEFINED-RULES.md` matches the fields actually supported by `load-config.ts`.
- **Install commands** — confirm the `/plugin marketplace add` and `/plugin install` commands are correct.
- **Mermaid diagrams** — check that node names, file names, and flow match the real call graph in `src/`.
- **HOW_IT_WORKS operator table** — confirm env propagation semantics match the `interpret.ts` implementation.
- **Version number** — ensure `plugin/.claude-plugin/plugin.json` version is reflected correctly anywhere the docs mention it.

## How to approach it

Read each doc section alongside the corresponding source file. Where they differ, update the doc — not the code. Flag anything that was intentionally left as a known limitation or future work rather than silently removing it.

## Verification

Run all tests and confirm they pass before marking this step complete.
