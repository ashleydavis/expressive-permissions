# subshell

Command:

```sh
(cd src && make)
```

AST:

```mermaid
graph TD
  n0["bash"]
  n1["subshell"]
  n2["binop<br/>op: &amp;&amp;"]
  n3["command<br/>binary: cd<br/>cmd: src"]
  n2 --> n3
  n4["command<br/>binary: make"]
  n2 --> n4
  n1 -->|body| n2
  n0 --> n1
```
