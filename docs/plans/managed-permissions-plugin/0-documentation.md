# Step 0: Documentation

Write the two user-facing documentation files: `README.md` (user entry point, ~150 lines) and `docs/HOW_IT_WORKS.md` (architecture deep-dive, ~250–400 lines with Mermaid diagrams).

## Files to create

- `README.md` — sections as specified in the plan:
  1. What it does (one-paragraph pitch).
  2. Why (concrete examples of allow/deny/ask rules).
  3. Installation — three paths: stable release, pre-release `#dev`, local development.
  4. Quick start: adding a rule — TypeScript path and YAML path.
  5. Scripts — table of every `package.json` script with its short alias and what it does (`bundle`/`b`, `compile`/`c`, `test`/`t`, `test:watch`/`tw`, `smoke`, `dev`/`d`).
  6. Built-in rules — short table (4 built-ins + 7 user rules).
  7. YAML schema reference (matcher field table).
  8. How it works — link to `docs/HOW_IT_WORKS.md`.
  9. License.

- `docs/HOW_IT_WORKS.md` — sections:
  1. End-to-end flow (Mermaid flowchart).
  2. Tool call → AST (two example Mermaid AST diagrams: `cd /etc && rm -rf /` and `Edit .env`).
  3. Walking the AST with an Environment (Mermaid sequence diagram, operator-semantics table).
  4. Per-node rule evaluation (Mermaid flowchart, numbered explanation).
  5. Bubble-up at intermediate nodes (pseudo-code or flowchart + worked examples).
  6. Built-in rules table.
  7. User extensibility (TS vs YAML, registry ordering).
  8. Testing strategy (architecture view).

## Verification

Review both files for accuracy against the implemented code (file paths, rule names, schema fields). Confirm Mermaid diagram syntax is valid (no unclosed brackets or broken labels).

Run all tests and confirm they pass before marking this step complete.
