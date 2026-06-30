# redirect-stdout

Command:

```sh
cmd > out.log
```

AST:

```mermaid
graph TD
  n0["redirect<br/>op: &gt;<br/>target: out.log"]
  n1["command<br/>binary: cmd"]
  n0 -->|command| n1
```
