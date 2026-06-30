# redirect-stdin

Command:

```sh
cat < in.txt
```

AST:

```mermaid
graph TD
  n0["redirect<br/>op: &lt;<br/>target: in.txt"]
  n1["command<br/>binary: cat"]
  n0 -->|command| n1
```
