# multiple-cmd

Command:

```sh
mv src/main.ts dist/main.ts
```

AST:

```mermaid
graph TD
  n0["bash"]
  n1["command<br/>binary: mv<br/>cmd: src/main.ts dist/main.ts"]
  n0 --> n1
```
