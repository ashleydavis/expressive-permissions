# Step 1: Project scaffolding

Set up the repository skeleton — build tooling, TypeScript config, test runner config, and directory layout — with no application logic yet.

## Files to create

- `package.json` — runtime deps (`yaml`, `picomatch`), dev deps (`typescript`, `jest`, `ts-jest`, `@types/jest`), and scripts:
  - `"bundle": "bun build src/hook.ts --outfile plugin/dist/hook.js --target bun"`, `"b": "bun run bundle"`
  - `"compile": "tsc --noEmit"`, `"c": "bun run compile"`
  - `"test": "jest"`, `"t": "bun run test"`
  - `"test:watch": "jest --watch"`, `"tw": "bun run test:watch"`
  - `"smoke": "bun run b && jest src/test/hook.integration.test.ts"`
  - `"dev": "claude --plugin-dir /home/ash/projects/claude-permissions"`, `"d": "bun run dev"`
- `tsconfig.json` — strict TypeScript, `module: "ESNext"`, `moduleResolution: "Bundler"`, targeting modern JS.
- `jest.config.ts` — configures `ts-jest` preset so Jest runs `.ts` files directly; auto-discovers `**/*.test.ts`.
- `.gitignore` — `node_modules/`, `*.log`, `.DS_Store`, `.env*`.
- Empty placeholder directories: `src/`, `src/rules/`, `src/rules/builtin/`, `src/test/`, `src/test/rules/`, `src/test/rules/builtin/`, `plugin/dist/`, `docs/`.

## Verification

Run `bun install` and confirm it succeeds with no errors. Run `bun compile` and confirm TypeScript compiles cleanly.

Run all tests and confirm they pass before marking this step complete.
