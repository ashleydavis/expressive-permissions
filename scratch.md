
---

I need a way to nest rules so the production part of this isn't repeated:

```yaml
aws:
  # Sandbox: allow everything without prompting
  - env:
      AWS_PROFILE: sandbox
    decide: allow

  # Production: deny known-destructive operations
  - env:
      AWS_PROFILE: production
    pos: ["*", delete-*]
    decide: deny
    reason: Destructive deletes blocked on the production profile
  - env:
      AWS_PROFILE: production
    pos: ["*", terminate-*]
    decide: deny
    reason: Termination blocked on the production profile
  - env:
      AWS_PROFILE: production
    pos: ["*", create-*]
    decide: deny
    reason: Resource creation blocked on the production profile
  - env:
      AWS_PROFILE: production
    pos: ["*", modify-*]
    decide: deny
    reason: Modifications blocked on the production profile
  - env:
      AWS_PROFILE: production
    pos: [iam, "*"]
    decide: deny
    reason: All IAM operations blocked on the production profile

  # Production catch-all: ask for anything not explicitly denied above
  - env:
      AWS_PROFILE: production
    decide: ask
    reason: Confirm AWS oPlease peration on production
```

I'd like `switch` or `if` statement that says, "if sandbox, do this, otherwise do that".

Be good to have an else block.

---

Test idea. Set AWS_PROFILE . run Claude . Have it print the env. Have my plugin print the env

ALL GOOD

`cwd` returns the current project dir as well.


```yaml
env:
    AWS_PROFILE: sandbox
```

```yaml
env:
    AWS_PROFILE: 
        not:
            sandbox
```

```yaml
cwd: ./ # Current project    
```


```yaml
cwd: 
    not: ./ # Not the current project    
```

```yaml
file:
    ~/.kube/config: true # File is present
```

```yaml
file:
    ~/.kube/config: "foobar" # <-- Exact file match.
```

```yaml
file:
    ~/.kube/config:
        contains: "current-context: sandbox"
```

```yaml
file:
    ~/.kube/config:
        not:
            contains: "current-context: sandbox"
```


```yaml
program:
    cwd: ./ # Current project
```


```yaml
program:
    "kubectl config get-context": sandbox
```


```yaml
program:
    "kubectl config get-context": 
        not: sandbox
```

---

Why so many `buildXXXScopedRule` functions?

Duplicate code.

---

Make sure all functions are exported and unit tested.