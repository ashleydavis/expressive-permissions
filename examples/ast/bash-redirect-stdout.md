# bash-redirect-stdout

Command:

```sh
cmd > out.log
```

AST:

```mermaid
graph TD
  n0["bash"]
  n1["command<br/>binary: cmd"]
  n0 --> n1
```
