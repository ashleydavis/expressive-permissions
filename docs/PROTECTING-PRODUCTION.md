# Protecting Production Infrastructure

Recipes for controlling what Claude can do with cloud and cluster tooling. The goal is to let read-only operations through automatically, block irreversible ones unconditionally, and pause on everything in between.

These are starting points. Take what is useful and extend it with the specific services, namespaces, and risk thresholds that make sense for your environment.

---

## AWS CLI

The AWS CLI follows the pattern `aws <service> <operation>`. Most read-only operations consistently use `describe-*`, `list-*`, or `get-*` prefixes, which makes broad rules practical.

`cmd` matches positional arguments -- the words of the command in order, excluding flags. A space-separated string like `"* delete-*"` matches any service followed by any operation starting with `delete-`; a single word like `"delete-*"` matches only the first positional argument. An array like `["*", "delete-*"]` is equivalent to the space-separated string form.

### Allow read-only operations

```yaml
aws:
  - cmd: "* describe-*"
    decide: allow
    reason: Read-only describe operation
  - cmd: "* list-*"
    decide: allow
    reason: Read-only list operation
  - cmd: "* get-*"
    decide: allow
    reason: Read-only get operation

  # aws s3 high-level commands use short names rather than the verb-* convention
  - cmd: "s3 ls"
    decide: allow
    reason: S3 list
  - cmd: "s3 presign"
    decide: allow
    reason: S3 presign is read-only
```

### Block all write operations

```yaml
aws:
  # CRUD and state mutation
  - cmd: "* create-*"
    decide: deny
    reason: Creation blocked
  - cmd: "* update-*"
    decide: deny
    reason: Updates blocked
  - cmd: "* modify-*"
    decide: deny
    reason: Modifications blocked
  - cmd: "* delete-*"
    decide: deny
    reason: Deletion blocked
  - cmd: "* terminate-*"
    decide: deny
    reason: Termination blocked
  - cmd: "* remove-*"
    decide: deny
    reason: Remove blocked
  - cmd: "* replace-*"
    decide: deny
    reason: Replace blocked
  - cmd: "* reset-*"
    decide: deny
    reason: Reset blocked

  # Lifecycle
  - cmd: "* start-*"
    decide: deny
    reason: Start blocked
  - cmd: "* stop-*"
    decide: deny
    reason: Stop blocked
  - cmd: "* reboot-*"
    decide: deny
    reason: Reboot blocked
  - cmd: "* run-*"
    decide: deny
    reason: Run blocked

  # Configuration
  - cmd: "* put-*"
    decide: deny
    reason: Put blocked
  - cmd: "* set-*"
    decide: deny
    reason: Set blocked
  - cmd: "* add-*"
    decide: deny
    reason: Add blocked
  - cmd: "* enable-*"
    decide: deny
    reason: Enable blocked
  - cmd: "* disable-*"
    decide: deny
    reason: Disable blocked
  - cmd: "* tag-*"
    decide: deny
    reason: Tagging blocked
  - cmd: "* untag-*"
    decide: deny
    reason: Untagging blocked

  # Attachment and association
  - cmd: "* attach-*"
    decide: deny
    reason: Attach blocked
  - cmd: "* detach-*"
    decide: deny
    reason: Detach blocked
  - cmd: "* associate-*"
    decide: deny
    reason: Associate blocked
  - cmd: "* disassociate-*"
    decide: deny
    reason: Disassociate blocked
  - cmd: "* register-*"
    decide: deny
    reason: Register blocked
  - cmd: "* deregister-*"
    decide: deny
    reason: Deregister blocked

  # Access control
  - cmd: "* authorize-*"
    decide: deny
    reason: Authorize blocked
  - cmd: "* revoke-*"
    decide: deny
    reason: Revoke blocked

  # Data operations
  - cmd: "* import-*"
    decide: deny
    reason: Import blocked
  - cmd: "* restore-*"
    decide: deny
    reason: Restore blocked
  - cmd: "* copy-*"
    decide: deny
    reason: Copy blocked

  # aws s3 high-level commands
  - cmd: "s3 cp"
    decide: deny
    reason: S3 copy blocked
  - cmd: "s3 mv"
    decide: deny
    reason: S3 move blocked
  - cmd: "s3 rm"
    decide: deny
    reason: S3 remove blocked
  - cmd: "s3 sync"
    decide: deny
    reason: S3 sync blocked

  # Safety flag
  - options-in:
      - force
    decide: deny
    reason: --force flag blocked
```

When combined with the allow rules above, reads resolve to `allow` (no deny rule matches), writes resolve to `deny`, and any operation not covered by either section falls through to the system default.

### Lock down specific high-risk services

Add targeted `deny` rules for services where the blast radius is highest. These combine with the cross-service rules above -- `deny` always wins.

```yaml
aws:
  - cmd: "iam *"
    decide: deny
    reason: All IAM changes require manual approval
  - cmd: "rds delete-*"
    decide: deny
    reason: RDS deletion blocked -- contact the DBA team
  - cmd: "cloudformation delete-stack"
    decide: deny
    reason: CloudFormation stack deletion blocked
  - cmd: "cloudformation deploy"
    decide: ask
    reason: Confirm CloudFormation deployment
```

IAM is denied entirely -- any change to roles, policies, or users is high-risk enough that no automated action should be allowed.

---

## kubectl

kubectl subcommands map cleanly to read vs. write. Use subcommand nesting for precise control, and a catch-all to surface anything not covered.

### Read-only access with a catch-all

```yaml
kubectl:
  - get:
      decide: allow
  - describe:
      decide: allow
  - logs:
      decide: allow
  - top:
      decide: allow
  - version:
      decide: allow
  - cluster-info:
      decide: allow
  - decide: ask
    reason: Confirm kubectl operation
```

### Block write and exec operations

These rules can stand alone or be merged into the combined example below.

```yaml
kubectl:
  - delete:
      decide: deny
      reason: kubectl delete is blocked -- use your deployment pipeline
  - apply:
      decide: deny
      reason: Applying manifests directly is blocked
  - patch:
      decide: deny
      reason: Direct patching is blocked
  - scale:
      decide: deny
      reason: Scaling is blocked -- use your deployment pipeline
  - exec:
      decide: deny
      reason: Shell access into pods is blocked
  - drain:
      decide: deny
      reason: Node draining is blocked
  - cordon:
      decide: deny
      reason: Node cordoning is blocked
  - rollout:
      restart:
        decide: deny
        reason: Rolling restarts are blocked
```

---

## Scoping rules to production contexts

The recipes above apply globally. Use `env` to match the active AWS profile, or `options` to match the kubectl `--context` flag, leaving the sandbox environment unrestricted.

### AWS: matching on the active profile

Apply different policies per profile by adding an `env` condition to every rule in the set. Rules without an `env` condition apply to all profiles, so keeping the conditions consistent avoids unintended cross-profile matches.

```yaml
aws:
  # Sandbox: allow everything without prompting
  - env:
      AWS_PROFILE: sandbox
    decide: allow

  # Any non-sandbox profile: deny known-destructive operations
  - env:
      AWS_PROFILE: /^(?!sandbox$)/
    cmd: "* delete-*"
    decide: deny
    reason: Destructive deletes blocked on this profile
  - env:
      AWS_PROFILE: /^(?!sandbox$)/
    cmd: "* terminate-*"
    decide: deny
    reason: Termination blocked on this profile
  - env:
      AWS_PROFILE: /^(?!sandbox$)/
    cmd: "* create-*"
    decide: deny
    reason: Resource creation blocked on this profile
  - env:
      AWS_PROFILE: /^(?!sandbox$)/
    cmd: "* modify-*"
    decide: deny
    reason: Modifications blocked on this profile
  - env:
      AWS_PROFILE: /^(?!sandbox$)/
    cmd: "iam *"
    decide: deny
    reason: All IAM operations blocked on this profile

  # Non-sandbox catch-all: ask for anything not explicitly denied above
  - env:
      AWS_PROFILE: /^(?!sandbox$)/
    decide: ask
    reason: Confirm AWS operation on non-sandbox profile
```

`/^(?!sandbox$)/` matches any profile name except `sandbox` exactly. The `deny` rules and the catch-all `ask` both match destructive operations on non-sandbox profiles -- deny wins because it is stricter. The `ask` only takes effect when no `deny` rule matches, which covers operations like `describe-*` and `list-*`.

> **Note on `allow` vs `ask`:** Because `ask` beats `allow` in the strictest-wins ordering, adding explicit `allow` rules for reads (e.g. `cmd: ["*", "describe-*"], decide: allow`) would have no effect -- the catch-all `ask` would still win. If you want reads to pass through silently on production, remove the catch-all `ask` and enumerate only the operations you want to deny. Anything not covered by an explicit rule falls through to the default behavior.

### Kubectl: matching on the active context

Match on the `--context` flag to scope rules to specific clusters:

```yaml
kubectl:
  # Sandbox: allow everything without prompting
  - options:
      context: sandbox-*
    decide: allow

  # Any non-sandbox context: allow read-only operations
  - options:
      context: /^(?!sandbox)/
    cmd: get
    decide: allow
  - options:
      context: /^(?!sandbox)/
    cmd: describe
    decide: allow
  - options:
      context: /^(?!sandbox)/
    cmd: logs
    decide: allow
  - options:
      context: /^(?!sandbox)/
    cmd: top
    decide: allow
  - options:
      context: /^(?!sandbox)/
    cmd: version
    decide: allow
  - options:
      context: /^(?!sandbox)/
    cmd: cluster-info
    decide: allow

  # Any non-sandbox context: deny known-destructive operations
  - options:
      context: /^(?!sandbox)/
    cmd: delete
    decide: deny
    reason: kubectl delete blocked outside sandbox
  - options:
      context: /^(?!sandbox)/
    cmd: apply
    decide: deny
    reason: Applying manifests blocked outside sandbox
  - options:
      context: /^(?!sandbox)/
    cmd: exec
    decide: deny
    reason: Pod shell access blocked outside sandbox
  - options:
      context: /^(?!sandbox)/
    cmd: scale
    decide: deny
    reason: Scaling blocked outside sandbox

  # Non-sandbox catch-all: ask for anything not explicitly denied above
  - options:
      context: /^(?!sandbox)/
    decide: ask
    reason: Confirm kubectl operation outside sandbox
```

This matches when `--context` is passed explicitly, which is common in scripts and pipelines. If the active context was set with `kubectl config use-context` and commands run without the flag, these rules will not match -- for that case, a custom TypeScript rule can call `kubectl config current-context` to detect the active context automatically.

