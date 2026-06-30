# brace-group

Command:

```sh
{ echo a; echo b; }
```

AST:

```mermaid
graph TD
  n0["bash"]
  n1["group<br/>style: brace"]
  n2["binop<br/>op: ;"]
  n3["command<br/>binary: echo<br/>cmd: a"]
  n2 --> n3
  n4["command<br/>binary: echo<br/>cmd: b"]
  n2 --> n4
  n1 -->|body| n2
  n0 --> n1
```

## Duplicates

Same construct as:

- [bash-brace-group](../bash-brace-group/index.md)
