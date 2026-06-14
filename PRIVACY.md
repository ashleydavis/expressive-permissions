# Privacy Policy

_Last updated: 2026-06-14_

expressive-permissions is a Claude Code plugin that runs entirely on your own machine. It is a local tool with no backend service.

## What data is collected

None. The plugin does not collect, store, or transmit any personal data.

## What the plugin processes

To make permission decisions, the plugin reads the details of each tool call that Claude Code is about to run (for example, the Bash command, file path, or URL) and evaluates them against your rules. This processing happens locally and in memory.

### Files the plugin reads

The plugin reads only:

- your permission configuration: `permissions.yaml` and `permissions.d/` rule files;
- command-descriptor files, which define how each command's flags and arguments are parsed; and
- any other file only if you have explicitly instructed it to, by writing a file-content match (`contains:`) rule that names that file, so it can check whether the file contains a given substring.

It reads no other files on your machine. It only ever reads a file beyond your permission configuration when one of your own rules explicitly tells it to.

### Files the plugin writes

The plugin only writes inside the `.claude/permissions-log/` directory in your project: the audit log files and a `.gitignore` for that directory. It creates and prunes files there as part of logging. It never creates or modifies any file outside that log directory. These log files stay on your machine and are never uploaded anywhere.

## What is transmitted

Nothing. The plugin makes no network requests. It contains no telemetry, analytics, tracking, or "phone home" behaviour of any kind.

## Third parties

The plugin shares no data with any third party, because it sends no data anywhere.

## Contact

Questions about this policy: ashley@codecapers.com.au
