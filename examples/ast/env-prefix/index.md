# env-prefix

Command:

```sh
FOO=bar cmd
```

AST:

```mermaid
graph TD
  n0["bash"]
  n1["command<br/>binary: cmd"]
  n0 --> n1
```

## Duplicates

Same construct as:

- [bash-env-prefix](../bash-env-prefix/index.md)
