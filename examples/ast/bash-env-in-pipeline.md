# bash-env-in-pipeline

Command:

```sh
cd /restricted && SECRET=1 some-tool --flag
```

AST:

```mermaid
graph TD
  n0["bash"]
  n1["binop<br/>op: &amp;&amp;"]
  n2["command<br/>binary: cd<br/>cmd: /restricted"]
  n1 --> n2
  n3["command<br/>binary: some-tool"]
  n1 --> n3
  n0 --> n1
```
