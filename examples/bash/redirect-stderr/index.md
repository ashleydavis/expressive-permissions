# redirect-stderr

Command:

```sh
cmd 2> err.log
```

AST:

```mermaid
graph TD
  n0["redirect<br/>op: 2&gt;<br/>target: err.log"]
  n1["command<br/>binary: cmd"]
  n0 -->|command| n1
```
