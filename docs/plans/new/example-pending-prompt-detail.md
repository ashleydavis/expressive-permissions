# Bash — ASK

Pending since 2026-06-19T18:17:43+10:00

## Command

```
export AWS_PROFILE=prod && cd /tmp && curl https://api.internal.corp/v1/deploy
```

## Context

```
CWD: /home/ash/claude-permissions
AWS_PROFILE=prod
```

## Sub-commands

```
export AWS_PROFILE=prod && cd /tmp && curl ...
├── export AWS_PROFILE=prod
│     ALLOW  .claude/permissions.yaml:5
├── cd /tmp
│     ALLOW  .claude/permissions.yaml:8
└── curl https://api.internal.corp/v1/deploy
      cwd: /tmp
      ASK  .claude/permissions.yaml:12  "network access requires approval"
```

## Verdict

```
ASK (matched rule) — network access requires approval
→ curl https://api.internal.corp/v1/deploy  (cwd: /tmp)
```
