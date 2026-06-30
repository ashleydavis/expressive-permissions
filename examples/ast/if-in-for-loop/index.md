# if-in-for-loop

Command:

```sh
cd /work/tf-config && for f in behavior_locals.tf behavior_variables.tf versions.tf; do if diff -q variant-1a/$f variant-2/$f >/dev/null 2>&1; then echo "SAME (1a==2): $f"; else echo "DIFFERS (1a vs 2): $f"; fi; done
```

AST:

```mermaid
graph TD
  n0["bash"]
  n1["binop<br/>op: &amp;&amp;"]
  n2["command<br/>binary: cd<br/>cmd: /work/tf-config"]
  n1 --> n2
  n3["for_loop<br/>var: f<br/>in: behavior_locals.tf behavior_variables.tf versions.tf"]
  n4["if_statement"]
  n5["redirect<br/>op: 2&gt;&amp;<br/>target: 1"]
  n6["redirect<br/>op: &gt;<br/>target: /dev/null"]
  n7["command<br/>binary: diff<br/>cmd: variant-1a/$f variant-2/$f"]
  n6 -->|command| n7
  n5 -->|command| n6
  n4 -->|cond| n5
  n8["command<br/>binary: echo<br/>cmd: SAME (1a==2): $f"]
  n4 -->|then| n8
  n9["command<br/>binary: echo<br/>cmd: DIFFERS (1a vs 2): $f"]
  n4 -->|else| n9
  n3 -->|body| n4
  n1 --> n3
  n0 --> n1
```
