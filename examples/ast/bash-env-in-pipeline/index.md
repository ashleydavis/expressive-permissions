# bash-env-in-pipeline

Command:

```sh
SECRET=1 some-tool --flag
```

AST:

```mermaid
graph TD
  n0["bash"]
  n1["command<br/>binary: some-tool"]
  n0 --> n1
```
