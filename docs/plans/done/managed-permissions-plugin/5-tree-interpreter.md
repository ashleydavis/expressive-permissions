# Step 5: Tree interpreter and decision engine

Implement `interpret.ts` — the combined walk-and-decide module. It builds the root AST, walks it recursively, threads `Environment` through operator semantics, runs all rules at each node (with `$VAR` expansion, deny-short-circuit, and strictest-wins), bubbles `Annotation`s up, and exports `decide()` as the public entry point called by `hook.ts`.

The walk and the rule-running are a single pass. The environment only exists during traversal and is never attached to the AST.

## Files to create

- `src/interpret.ts` — exports:
  - `InterpretResult` interface: `{ annotation: Annotation; envOut: Environment }` — multi-line with field comments.
  - `decide(call: ToolCall): Decision` — the public entry point: builds AST, creates `env0`, calls internal `interpret`, formats the explanation.
  - Internal `interpret(node, env, call): InterpretResult` — the recursive walker.
  - Internal `IRunRulesResult` interface: `{ annotation: Annotation; envUpdate: (environment: Environment) => Environment }` — replaces the anonymous return type of `runRules`.
  - Internal `runRules(node, env, call): IRunRulesResult` — iterates `rules` in registry order at a single node, expanding Command args against `runningEnv.env` before each rule, threading `runningEnv` via `env`/`scopedEnv` updates, applying deny-short-circuit and strictest-wins.
  - Internal `expandToken(token, vars)` — substitutes `$VAR`/`${VAR}` using vars dict; leaves unknown vars as-is.
  - Internal `expandCommandArgs(node, vars)` — clones a `Command` with binary, flag values, and positionals expanded; preserves `raw`.
  - Internal `walkChildren`, `aggregateChildren`, `combine`, `rank`, `isLeaf`, `ASK` constant — all require `//` comment blocks above them.
  - Operator env semantics per the plan's table: `seq`/`and` thread env left→right→up; `or`/`pipe` discard subtree env.
  - Leaf default: all rules abstain → `ask`.
  - Intermediate aggregation: any child deny → deny; all children allow → allow; else → ask. Own rule result layers on top.

All exported and internal symbols require a `//` comment block above them. No anonymous inline return types.

- `src/test/interpret.test.ts` — covers all cases documented in the plan's Testing strategy > Interpreter tests section using spy rules and real built-in rules:
  - Leaf default (all abstain → ask; allow rule → allow; ask rule → ask; deny rule → deny).
  - Intermediate aggregation (any deny wins; all allow + abstain own → allow; all allow + ask own → ask; mixed + abstain → ask; mixed + allow → allow).
  - Deny short-circuit propagation upward.
  - Env threading: `seq`/`and` propagate env left→right; `or`/`pipe` discard subtree env.
  - Rule iteration: strictest-wins (allow then ask → ask); deny short-circuits remaining rules; same-rank ties go to latest rule.
  - Persistent env composition: env update applied even if a later rule denies.
  - Scoped env visibility: `scopedEnv` update visible to subsequent rules at the same node but not to siblings.
  - `$VAR` expansion: `FOO=bar; git add $FOO` — rules at the `git add` leaf see `pos === "bar"`.
  - cwd propagation through operators (via real `cdRule`): `cd /etc && rm x`, `cd /etc | echo`, `cd /etc || cd /tmp; ls`.
  - EnvPrefix transience (via real `envPrefixRule`): `FOO=bar npm test && echo $FOO`.
  - Status aggregation end-to-end: `cd /etc && rm -rf /` → deny; `git status` → allow; `git status | wc -l` → ask.
  - Allow override: parent bash-root rule allows, overrides mixed-status children ask.
  - Ask overrides allow: ask at a node blocks a later allow.
  - Non-Bash leaf decisions: `Edit` of `.env` denies; `Read` of normal file falls through to ask.

## Verification

Run `bun test` and confirm all interpreter tests pass.

Run all tests and confirm they pass before marking this step complete.
