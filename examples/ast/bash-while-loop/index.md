# bash-while-loop

Command:

```sh
while read line; do echo $line; done
```

AST:

```mermaid
graph TD
  n0["bash"]
  n1["while_loop"]
  n2["command<br/>binary: read<br/>cmd: line"]
  n1 -->|cond| n2
  n3["command<br/>binary: echo<br/>cmd: $line"]
  n1 -->|body| n3
  n0 --> n1
```
