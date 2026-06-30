# flag-path-value

Command:

```sh
git -C /some/path status -sb
```

AST:

```mermaid
graph TD
  n0["bash"]
  n1["command<br/>binary: git<br/>cmd: status"]
  n0 --> n1
```
