# if-statement

Command:

```sh
if test -f f; then echo yes; else echo no; fi
```

AST:

```mermaid
graph TD
  n0["bash"]
  n1["if_statement"]
  n2["command<br/>binary: test<br/>cmd: f"]
  n1 -->|cond| n2
  n3["command<br/>binary: echo<br/>cmd: yes"]
  n1 -->|then| n3
  n4["command<br/>binary: echo<br/>cmd: no"]
  n1 -->|else| n4
  n0 --> n1
```
