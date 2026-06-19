# backtick-substitution

Command:

```sh
rm `cat list`
```

AST:

```mermaid
graph TD
  n0["command<br/>binary: rm<br/>cmd: `cat list`"]
  n1["command<br/>binary: cat<br/>cmd: list"]
  n0 -->|subst| n1
```
