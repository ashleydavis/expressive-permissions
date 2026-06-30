# redirect-and-binop

Command:

```sh
cd /tmp && echo hi > out.txt
```

AST:

```mermaid
graph TD
  n0["bash"]
  n1["binop<br/>op: &amp;&amp;"]
  n2["command<br/>binary: cd<br/>cmd: /tmp"]
  n1 --> n2
  n3["redirect<br/>op: &gt;<br/>target: out.txt"]
  n4["command<br/>binary: echo<br/>cmd: hi"]
  n3 -->|command| n4
  n1 --> n3
  n0 --> n1
```
