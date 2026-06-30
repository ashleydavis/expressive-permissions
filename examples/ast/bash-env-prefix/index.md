# bash-env-prefix

Command:

```sh
FOO=bar node index.js
```

AST:

```mermaid
graph TD
  n0["bash"]
  n1["command<br/>binary: node<br/>cmd: index.js"]
  n0 --> n1
```

## Duplicates

Same construct as:

- [env-prefix](../env-prefix/index.md)
