# bash-until-loop

Command:

```sh
until ping -c1 host; do sleep 1; done
```

AST:

```mermaid
graph TD
  n0["bash"]
  n1["until_loop"]
  n2["command<br/>binary: ping<br/>cmd: host"]
  n1 -->|cond| n2
  n3["command<br/>binary: sleep<br/>cmd: 1"]
  n1 -->|body| n3
  n0 --> n1
```
