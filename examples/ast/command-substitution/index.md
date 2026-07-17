# command-substitution

Command:

```sh
echo $(whoami)
```

AST:

```mermaid
graph TD
  n0["bash"]
  n1["command<br/>binary: echo"]
  n2["substitution<br/>source: $(whoami)"]
  n3["command<br/>binary: whoami"]
  n0 --> n1
  n1 -->|substitution| n2
  n2 -->|command| n3
```
