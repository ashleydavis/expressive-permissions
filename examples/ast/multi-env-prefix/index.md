# multi-env-prefix

Command:

```sh
A=1 B=2 cmd
```

AST:

```mermaid
graph TD
  n0["bash"]
  n1["command<br/>binary: cmd"]
  n0 --> n1
```
