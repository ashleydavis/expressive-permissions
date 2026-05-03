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
    reason: Creating resources may incur unexpected costs or alter infrastructure state.
  - cmd: "* update-*"
    decide: deny
    reason: Updating resources can cause configuration drift or service disruptions.
  - cmd: "* modify-*"
    decide: deny
    reason: Modifying resources can cause configuration drift or service disruptions.
  - cmd: "* delete-*"
    decide: deny
    reason: Deleting resources is irreversible and can cause data loss or service outages.
  - cmd: "* terminate-*"
    decide: deny
    reason: Terminating instances is irreversible and causes immediate downtime.
  - cmd: "* remove-*"
    decide: deny
    reason: Removing resources may be irreversible and can cause service disruptions.
  - cmd: "* replace-*"
    decide: deny
    reason: Replacing resources causes downtime and bypasses change control.
  - cmd: "* reset-*"
    decide: deny
    reason: Resetting resources can cause data loss or service interruptions.

  # Lifecycle
  - cmd: "* start-*"
    decide: deny
    reason: Starting resources may incur unexpected costs or alter cluster state.
  - cmd: "* stop-*"
    decide: deny
    reason: Stopping resources causes downtime.
  - cmd: "* reboot-*"
    decide: deny
    reason: Rebooting resources causes downtime and should be coordinated.
  - cmd: "* run-*"
    decide: deny
    reason: Running new instances may incur unexpected costs.

  # Configuration
  - cmd: "* put-*"
    decide: deny
    reason: Overwriting configuration can break dependent services.
  - cmd: "* set-*"
    decide: deny
    reason: Changing settings can break dependent services.
  - cmd: "* add-*"
    decide: deny
    reason: Adding resources or permissions may violate least-privilege principles.
  - cmd: "* enable-*"
    decide: deny
    reason: Enabling features may expose infrastructure or incur unexpected costs.
  - cmd: "* disable-*"
    decide: deny
    reason: Disabling features can cause service degradation.
  - cmd: "* tag-*"
    decide: deny
    reason: Changing tags can affect cost allocation or tag-based access policies.
  - cmd: "* untag-*"
    decide: deny
    reason: Removing tags can affect cost allocation or tag-based access policies.

  # Attachment and association
  - cmd: "* attach-*"
    decide: deny
    reason: Attaching resources can change network topology or security boundaries.
  - cmd: "* detach-*"
    decide: deny
    reason: Detaching resources can cause connectivity loss or service interruptions.
  - cmd: "* associate-*"
    decide: deny
    reason: Associating resources can change routing or security group boundaries.
  - cmd: "* disassociate-*"
    decide: deny
    reason: Disassociating resources can cause connectivity loss.
  - cmd: "* register-*"
    decide: deny
    reason: Registering targets changes load balancer or service discovery routing.
  - cmd: "* deregister-*"
    decide: deny
    reason: Deregistering targets removes them from load balancers and causes traffic loss.

  # Access control
  - cmd: "* authorize-*"
    decide: deny
    reason: Granting access can expand the attack surface.
  - cmd: "* revoke-*"
    decide: deny
    reason: Revoking access can break dependent services.

  # Data operations
  - cmd: "* import-*"
    decide: deny
    reason: Importing data can overwrite existing resources.
  - cmd: "* restore-*"
    decide: deny
    reason: Restoring from backup overwrites current data and may be irreversible.
  - cmd: "* copy-*"
    decide: deny
    reason: Copying resources may incur costs or duplicate sensitive data.

  # aws s3 high-level commands
  - cmd: "s3 cp"
    decide: deny
    reason: Copying S3 objects may overwrite existing data or duplicate sensitive content.
  - cmd: "s3 mv"
    decide: deny
    reason: Moving S3 objects is irreversible and can break services that depend on object paths.
  - cmd: "s3 rm"
    decide: deny
    reason: Deleting S3 objects is irreversible and can cause permanent data loss.
  - cmd: "s3 sync"
    decide: deny
    reason: S3 sync can overwrite or delete production data in bulk.

  # Safety flag
  - options-in:
      - force
    decide: deny
    reason: The --force flag bypasses safety checks and confirmation prompts.
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
    reason: RDS data is irreplaceable -- contact the DBA team to approve deletions.
  - cmd: "cloudformation delete-stack"
    decide: deny
    reason: Stack deletion removes all managed resources and is irreversible.
  - cmd: "cloudformation deploy"
    decide: ask
    reason: Confirm CloudFormation deployment
```

IAM is denied entirely, any change to roles, policies, or users is high-risk enough that no automated action should be allowed.

---

## kubectl

kubectl subcommands map cleanly to read vs. write.

### Read-only access with a catch-all

Allow known safe read-only subcommands explicitly and let the catch-all `ask` surface anything else for manual review.

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

Add these alongside the read-only rules above to block write and exec access while still permitting reads.

```yaml
kubectl:
  - delete:
      decide: deny
      reason: Deleted resources may not be recoverable -- use your deployment pipeline.
  - apply:
      decide: deny
      reason: Direct applies bypass the deployment pipeline and change tracking.
  - patch:
      decide: deny
      reason: Direct patches bypass change tracking and code review.
  - scale:
      decide: deny
      reason: Manual scaling bypasses capacity planning -- use your deployment pipeline.
  - exec:
      decide: deny
      reason: Direct pod shell access bypasses audit logging and security controls.
  - drain:
      decide: deny
      reason: Draining nodes evicts running workloads and must be coordinated with the ops team.
  - cordon:
      decide: deny
      reason: Cordoning prevents scheduling on a node and must be coordinated with the ops team.
  - rollout:
      restart:
        decide: deny
        reason: Rolling restarts cause temporary service disruption and should go through the deployment pipeline.
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
    reason: Destructive deletes on non-sandbox profiles risk permanent data loss.
  - env:
      AWS_PROFILE: /^(?!sandbox$)/
    cmd: "* terminate-*"
    decide: deny
    reason: Terminating instances on non-sandbox profiles causes irreversible downtime.
  - env:
      AWS_PROFILE: /^(?!sandbox$)/
    cmd: "* create-*"
    decide: deny
    reason: Creating resources on non-sandbox profiles may incur unexpected costs.
  - env:
      AWS_PROFILE: /^(?!sandbox$)/
    cmd: "* modify-*"
    decide: deny
    reason: Modifying resources on non-sandbox profiles risks service disruptions.
  - env:
      AWS_PROFILE: /^(?!sandbox$)/
    cmd: "iam *"
    decide: deny
    reason: IAM changes on non-sandbox profiles can compromise the entire account's security.

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
    reason: Deleted resources outside sandbox may not be recoverable -- use your deployment pipeline.
  - options:
      context: /^(?!sandbox)/
    cmd: apply
    decide: deny
    reason: Direct applies outside sandbox bypass the deployment pipeline and change tracking.
  - options:
      context: /^(?!sandbox)/
    cmd: exec
    decide: deny
    reason: Pod shell access outside sandbox bypasses audit logging and security controls.
  - options:
      context: /^(?!sandbox)/
    cmd: scale
    decide: deny
    reason: Manual scaling outside sandbox bypasses capacity planning -- use your deployment pipeline.

  # Non-sandbox catch-all: ask for anything not explicitly denied above
  - options:
      context: /^(?!sandbox)/
    decide: ask
    reason: Confirm kubectl operation outside sandbox
```

This matches when `--context` is passed explicitly, which is common in scripts and pipelines. If the active context was set with `kubectl config use-context` and commands run without the flag, these rules will not match -- for that case, a custom TypeScript rule can call `kubectl config current-context` to detect the active context automatically.

