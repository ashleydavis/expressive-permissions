# until-loop

Command:

```sh
until test -f /tmp/ready; do sleep 1; done
```

AST:

```mermaid
graph TD
  n0["until_loop"]
  n1["command<br/>binary: test<br/>cmd: /tmp/ready"]
  n0 -->|cond| n1
  n2["command<br/>binary: sleep<br/>cmd: 1"]
  n0 -->|body| n2
```
