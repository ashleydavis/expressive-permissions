# Testing

This doc explains how to run unit tests and smoke tests.

## Commands

```bash
bun run test          # run all unit tests
bun run test:watch    # watch mode
bun run compile       # type-check only (no emit)
bun run smoke         # e2e + AST examples + decision examples
bun run test:all      # validate + unit + full smoke gate
```

## Unit tests

Unit tests live under `src/test/` mirroring the source tree. 

To run a single unit test file or a matching test name:

```bash
bun run test -- src/test/rules/bash-rule.test.ts
bun run test -- src/test/rules/bash-rule.test.ts -t "cmd-in regex"
```

## Smoke tests

AST examples live under [`examples/ast/`](../examples/ast). Decision examples live under [`examples/decision/`](../examples/decision).

Run all examples:

```bash
./scripts/smoke-tests-bash-parser.sh
./scripts/smoke-tests-decision.sh
```

Run one example:

```bash
bun scripts/check-example.ts and-operator
bun scripts/check-decision.ts bash-cmd-in
```

Run one e2e smoke test:

```bash
bun run scripts/run-e2e-test.ts e2e/bash/bash-and-both-allow
```

## CI

The `ci` workflow runs on every push and pull request, compiles the code and runs all tests.
