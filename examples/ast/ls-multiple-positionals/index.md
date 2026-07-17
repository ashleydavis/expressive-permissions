# ls-multiple-positionals

Command:

```sh
ls /tmp /var
```

AST:

```mermaid
graph TD
  n0["bash"]
  n1["command<br/>binary: ls<br/>cmd: /tmp, /var"]
  n0 --> n1
```
