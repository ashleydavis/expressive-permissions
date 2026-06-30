# flag-short-separate

Command:

```sh
rm -r -f /tmp
```

AST:

```mermaid
graph TD
  n0["bash"]
  n1["command<br/>binary: rm<br/>cmd: /tmp"]
  n0 --> n1
```
