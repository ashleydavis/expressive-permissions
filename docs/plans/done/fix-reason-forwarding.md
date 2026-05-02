# Plan: Fix reason forwarding in YAML rules

## Problem

The `reason` field in `IYamlEntry` is defined and parsed from YAML but never forwarded to
the `Decision` object that the hook returns to Claude. This means `permissionDecisionReason`
is always `undefined` for every user-defined YAML rule, regardless of what `reason:` the
user wrote. Claude receives a blank denial or ask with no explanation.

Root cause: `mapDecision` ignores reason, and all four build functions pass only `entry.decide`:

```typescript
// Current — reason silently dropped
const decision = mapDecision(entry.decide as DecideValue);
```

## Fix

### 1. Update `mapDecision` signature

Add an optional `reason` parameter and thread it into `IDenyDecision` and `IAskDecision`.
`IAllowDecision` and `IAbstainDecision` have no `reason` field so they are unchanged.

```typescript
function mapDecision(decide: DecideValue, reason?: string): Decision {
    if (decide === "allow") {
        return { action: "allow" };
    }
    if (decide === "deny") {
        return { action: "deny", reason };
    }
    if (decide === "abstain") {
        return { action: "abstain" };
    }
    return { action: "ask", reason };
}
```

### 2. Update all four call sites

In `buildBashRule`, `buildFileRule`, `buildWebFetchRule`, and `buildMcpRule`, change:

```typescript
const decision = mapDecision(entry.decide as DecideValue);
```

to:

```typescript
const decision = mapDecision(entry.decide as DecideValue, entry.reason);
```

## Critical files

- `src/load-config.ts` — `mapDecision` function and four build-function call sites
- `src/test/load-config.test.ts` — add tests verifying `decision.reason` is set correctly

## Tests to add

Add one test per tool section verifying that `reason` flows through to the decision:

- `bash rule with reason: value → decision.reason equals value`
- `read rule with reason → decision.reason equals value`
- `write rule with reason → decision.reason equals value`
- `edit rule with reason → decision.reason equals value`
- `multi_edit rule with reason → decision.reason equals value`
- `webfetch rule with reason → decision.reason equals value`
- `mcp rule with reason → decision.reason equals value`
- `rule with no reason → decision.reason is undefined`

## Scope

Four-line change to `src/load-config.ts` plus unit tests. No interface changes required —
`IDenyDecision.reason` and `IAskDecision.reason` are already optional strings.
