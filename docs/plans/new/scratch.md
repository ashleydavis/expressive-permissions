
Need to make I can susinctly match

rm -rf 
rm -f --recursive
rm --force -r
rm --force --recursive

I though I had an elegant way to do this but I'm not sure now.

---

How to install globally?


---


Can it log to claude chat output to explain what's is doing?


---


Rolling audit log

---

I'd like to support OR for matching commands likes `v|vi|vim` (for aliases). Please write it into the plan @docs/plans/new/add-pos-field.md and update the documentation to match so I can see how it sounds. 


---

What a validation phase to check that rules are syntaxtically correct.


---

After the plan...

Does the code match the docs?


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

How do I add an allow for any "sandbox" commands?

Or for particular kubectl contexts that I allow any kubectl commands?

In certain situations you want to say something like:

```yaml
decide: allow!
```

The exclamation bumps the precedence level.

Not sure if this the best thing to add, but it's pretty cool.

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

I need an interceptor rule that triggers when `kubectl` is spotted in the AST.

We should run `kubectl config current-context` to determine the current context and then be able to use the `context` field to match against it.

The context field should match current context or `--context` argument.

This kubectl specific logic definitely needs to be a plugin and not a core part of the system.

Is there an aws cli plugin that could help with AWS sepcific stuff like matching on `profile`, `region`, etc?

---

Need to make sure it can match the system env.

Does this even come through properly from claude?


---

Could handling of each tool be delegated to a seperate file/function for each of maintenance?

---


When it want to use npx in a bun project, "tool redirects" would be good.

npx => bpx (or whatever)