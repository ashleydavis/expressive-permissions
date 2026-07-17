# descriptor-flag-arity-one

Command:

```sh
qux -n hello
```

AST:

```mermaid
graph TD
  n0["bash"]
  n1["command<br/>binary: qux<br/>options: n=hello"]
  n0 --> n1
```
