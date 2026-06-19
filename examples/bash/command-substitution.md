# command-substitution

Command:

```sh
echo $(whoami)
```

AST:

```mermaid
graph TD
  n0["command<br/>binary: echo<br/>cmd: $(whoami)"]
  n1["command<br/>binary: whoami"]
  n0 -->|subst| n1
```
