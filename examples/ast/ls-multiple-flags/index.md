# ls-multiple-flags

Command:

```sh
ls -l -a
```

AST:

```mermaid
graph TD
  n0["bash"]
  n1["command<br/>binary: ls<br/>options: l, a"]
  n0 --> n1
```
