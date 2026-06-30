# redirect-stdout

Command:

```sh
cmd > out.log
```

AST:

```mermaid
graph TD
  n0["bash"]
  n1["redirect<br/>op: &gt;<br/>target: out.log"]
  n2["command<br/>binary: cmd"]
  n1 -->|command| n2
  n0 --> n1
```
