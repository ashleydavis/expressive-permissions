# bash-or

Command:

```sh
test -f foo.txt || echo missing
```

AST:

```mermaid
graph TD
  n0["bash"]
  n1["binop<br/>op: &#124;&#124;"]
  n2["command<br/>binary: test<br/>cmd: foo.txt"]
  n1 --> n2
  n3["command<br/>binary: echo<br/>cmd: missing"]
  n1 --> n3
  n0 --> n1
```

## Duplicates

Same construct as:

- [or-operator](../or-operator/index.md)
