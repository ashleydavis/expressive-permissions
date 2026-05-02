# Step 3: Bash parser

Implement the syntactic Bash parser. Pure function: no env threading, no semantics — just tokenization and AST construction. Implemented as a hand-written recursive descent parser with no external tokenizer dependency.

## Files to create

- `src/parse-bash.ts` — exports `parseBash(raw: string): BashAstNode`.
  - Hand-written lexer that produces a flat token stream: single-quoted strings, double-quoted strings (with `\`-escape handling), operators (`|`, `&&`, `||`, `;`, `>`, `>>`, `<`, `2>`, `&>`), and bare words.
  - Recursive descent grammar (each function calls the next):
    - `parseSequence` → `parseAnd (';' parseAnd)*`
    - `parseAnd` → `parseOr ('&&' parseOr)*`
    - `parseOr` → `parsePipe ('||' parsePipe)*`
    - `parsePipe` → `parseCommand ('|' parseCommand)*`
    - `parseCommand` → `(KEY=VALUE)* WORD arg* redirect*`
  - Operators fold left: `a && b && c` builds `{ kind:"and", left: { kind:"and", left:a, right:b }, right:c }`.
  - For each `Command` leaf: leading `KEY=VALUE` tokens go into `envPrefix`; next token is `binary`; redirect operator/target pairs go into `redirects`; remaining tokens are run through the inline argv parser (~20 lines, in this same file) producing `args` (named flags/values) and `pos` (positionals).
  - Empty/whitespace-only input returns `Command` with `binary: ""`, empty `args`/`envPrefix`/`redirects`, `raw: ""`.

- `src/test/parse-bash.test.ts` — covers all cases documented in the plan's Testing strategy > Parser tests section:
  - Single-command shapes (bare binary, positionals + flags, long flags, quoted positionals, escaped chars, empty input, binary with hyphens/dots/path).
  - Operators in isolation (pipe, and, or, seq, chained, mixed).
  - Env-var prefixes (single, multiple, quoted value, env-only segment).
  - Redirects (stdout, append, stdin, stderr, merged).
  - Robustness (leading/trailing whitespace, trailing `;`, `$VAR`/`*` as literals, `$(...)` / backticks as opaque tokens).

## Verification

Run `bun run test` and confirm all parser tests pass.

Run all tests and confirm they pass before marking this step complete.
