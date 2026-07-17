# ls-one-positional

Command:

```sh
ls /tmp
```

AST:

```mermaid
graph TD
  n0["bash"]
  n1["command<br/>binary: ls<br/>cmd: /tmp"]
  n0 --> n1
```
