
Need to make I can susinctly match

rm -rf 
rm -f --recursive
rm --force -r
rm --force --recursive

I though I had an elegant way to do this but I'm not sure now.

Would this even work?

`cmd`: `rm -r|recursive&f|force`


--- 

We need to incorporate all env vars that claude knows about.

Need to be able to block AWS edit commands when the env var is set to PRODUCTION!

--- 

Simplification?

Old:

```yaml
aws:
  - pos: ["*", describe-*]
    decide: allow
```

New:

```yaml
aws:
  - pos: "* describe-*"
    decide: allow
```


---

I really hate `pos`, but `args` is already taken.

Any solution to this?


Could just paper over it by having `cmd` that is a string that is parsed:

```yaml
aws:
  - cmd: "* describe-*"
    decide: allow
```


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

---

How to implement nested rules? Sub rules that match when an env var, cwd, file precences, file content or command rules is matched?

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

cmd to a string... parse out position arguments.

not "first positional"