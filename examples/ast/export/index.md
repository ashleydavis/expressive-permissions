# export

Command:

```sh
export FOO=bar
```

AST:

```mermaid
graph TD
  n0["bash"]
  n1["command<br/>binary: export<br/>cmd: FOO=bar"]
  n0 --> n1
```
