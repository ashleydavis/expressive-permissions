# redirect-fd-merge

Command:

```sh
cmd > out.log 2>&1
```

AST:

```mermaid
graph TD
  n0["redirect<br/>op: 2&gt;&amp;<br/>target: 1"]
  n1["redirect<br/>op: &gt;<br/>target: out.log"]
  n2["command<br/>binary: cmd"]
  n1 -->|command| n2
  n0 -->|command| n1
```
