# Step 9: Rule registry

Wire the rules into an ordered registry that `interpret.ts` imports directly.

## Files to create

- `src/rules/index.ts` — exports `rules: Rule[]` in registry order:
  1. Built-ins: `cdRule`, `envPrefixRule`, `envSetRule`, `exportRule`.
  2. YAML rules: `...loadConfigRules()` (default config, then home, then project — compiled by `load-config.ts`).

No orchestrator file is needed. The rule loop, `decide()`, and `$VAR` expansion all live in `src/interpret.ts` (implemented in step 5).

## Verification

Run `bun test` and confirm all interpreter tests pass with the real registry wired in.

Run all tests and confirm they pass before marking this step complete.
