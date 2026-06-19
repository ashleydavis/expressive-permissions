# background

Command:

```sh
server & client
```

AST:

```mermaid
graph TD
  n0["binop<br/>op: ;"]
  n1["command<br/>binary: server"]
  n0 --> n1
  n2["command<br/>binary: client"]
  n0 --> n2
```
