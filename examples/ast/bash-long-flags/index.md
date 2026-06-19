# bash-long-flags

Command:

```sh
rm --recursive --force /tmp
```

AST:

```mermaid
graph TD
  n0["bash"]
  n1["command<br/>binary: rm<br/>cmd: /tmp"]
  n0 --> n1
```
