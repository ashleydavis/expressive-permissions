# Issues

Known design and implementation problems. Add one section per issue; list affected examples under each.

---

## Command substitutions use a sidecar field instead of AST nodes

Backtick and `$(...)` substitutions are not represented as proper intermediate nodes (unlike `redirect`). The outer `command` keeps the substitution as literal text in `cmd`, and inner commands are attached on `substitutions[]` on the same leaf.

**Recommended fix:** Add a proper substitution AST node (like `redirect`) and put the inner command tree under it, instead of keeping backticks as literal text in `cmd` with a sidecar `substitutions` array on the same leaf.

**Affected examples:**

- `examples/ast/backtick-substitution/`
- `examples/ast/bash-backtick-substitution/`
- `examples/ast/command-substitution/`
- `examples/ast/bash-command-substitution/`
