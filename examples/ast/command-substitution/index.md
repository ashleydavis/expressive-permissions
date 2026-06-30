# command-substitution

Command:

```sh
echo $(whoami)
```

AST:

```mermaid
graph TD
  n0["bash"]
  n1["command<br/>binary: echo<br/>cmd: $(whoami)"]
  n2["command<br/>binary: whoami"]
  n1 -->|subst| n2
  n0 --> n1
```
