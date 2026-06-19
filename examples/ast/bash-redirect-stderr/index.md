# bash-redirect-stderr

Command:

```sh
cmd 2> err.txt
```

AST:

```mermaid
graph TD
  n0["bash"]
  n1["command<br/>binary: cmd"]
  n0 --> n1
```
