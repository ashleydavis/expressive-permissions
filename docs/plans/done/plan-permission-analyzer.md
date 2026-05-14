# Permission Analyzer: REPL and MCP Server

## Overview

Add two complementary tools for understanding why the permissions engine allows, denies, or asks about a command. The first is a standalone interactive REPL (`src/repl.ts`) that developers can run to test commands against their `permissions.yaml` in real time. The second is an MCP server (`src/mcp-server.ts`) that Claude Code registers as a local MCP tool, allowing the user to ask Claude in natural language — "why is this command being denied?" — and get back a structured trace that Claude explains. Both tools share a new analysis module (`src/analyze.ts`) built on top of the existing `decide()` engine.

## Issues

## Steps

### 1. Install `@modelcontextprotocol/sdk`

Run `bun add @modelcontextprotocol/sdk`. This is the only new runtime dependency; it is required by `src/mcp-server.ts`.

### 2. Add `CapturingAuditLogger` to `src/audit-log.ts`

Add a new exported class `CapturingAuditLogger` that implements `IAuditLogger`. It stores every `IAuditLogEntry` passed to `log()` in a private array. Expose two methods:
- `getEntries(): IAuditLogEntry[]` — returns a copy of the collected entries
- `reset(): void` — clears the array

This follows the same file pattern as the existing `NullAuditLogger`.

### 3. Create `src/analyze.ts` — shared analysis core

Define and export the following:

**`IAnalysisResult` interface:**
- `decision: string` — `"allow"`, `"deny"`, or `"ask"`
- `reason?: string` — the reason attached to the decision, if any
- `trace: IAuditLogEntry[]` — all audit entries captured during evaluation (includes `config_load`, `rule_match`, `no_rule_match`, `aggregation`, `final_decision`)

**`parseToolCallInput(input: string, cwd: string): ToolCall`**

Parses a user-supplied string into a `ToolCall`. Prefix rules (case-insensitive, checked with `toLowerCase()`):
- `read <path>` → `{tool_name: "Read", tool_input: {file_path: <path>}}`
- `write <path>` → `{tool_name: "Write", tool_input: {file_path: <path>, content: ""}}`
- `edit <path>` → `{tool_name: "Edit", tool_input: {file_path: <path>, old_string: "", new_string: ""}}`
- `webfetch <url>` → `{tool_name: "WebFetch", tool_input: {url: <url>}}`
- `tool <name>` → `{tool_name: <name>, tool_input: {}}`
- Anything else → `{tool_name: "Bash", tool_input: {command: <full input>}}`

All results include `cwd` from the parameter.

**`buildAnalysisRegistry(projectDir: string, logger: IAuditLogger): RuleRegistry`**

Constructs a `RuleRegistry` with three layers: `RuleLayer(builtinRules)`, `FileLayer(loadHomeConfigRules, ...)`, `FileLayer(loadProjectConfigRules, ...)`. Sets `CLAUDE_PROJECT_DIR` in `process.env` to `projectDir` before calling loaders, then restores the original value. Returns the registry.

**`analyzePermission(input: string, cwd: string, projectDir: string): IAnalysisResult`**

Instantiates a `CapturingAuditLogger`, calls `buildAnalysisRegistry`, calls `decide(toolCall, logger, registry)`, then returns `{decision, reason, trace: logger.getEntries()}`.

### 4. Create `src/repl.ts` — interactive REPL

**`ANSI` constants object** — hold color/reset escape codes for `green`, `red`, `yellow`, `dim`, `bold`, `reset`. Named constants, not magic strings.

**`colorForDecision(decision: string): string`**

Returns the ANSI color constant for a decision string: green for `allow`, red for `deny`, yellow for `ask`, dim for anything else.

**`formatTrace(entries: IAuditLogEntry[]): string`**

Formats audit entries for terminal display. Skip `config_load` and `tool_request` entries (too noisy for the REPL). Format each remaining entry on its own line using `formatTextEntry()` from `audit-log.ts`, prefixed with a dim two-space indent. Returns the joined string.

**`formatVerdict(result: IAnalysisResult): string`**

Produces the final verdict line: `<color><decision.toUpperCase()><reset>` optionally followed by `— <reason>` in dim. Bold the decision word.

**`runOnce(input: string, cwd: string, projectDir: string): void`**

Calls `analyzePermission`, prints the trace via `formatTrace`, then prints the verdict via `formatVerdict`. Used by both interactive mode and one-shot mode.

**`runRepl(projectDir: string, initialCwd: string): Promise<void>`**

Creates a `readline.Interface` on `process.stdin`/`process.stdout`. Prints a startup banner showing the `projectDir` and `initialCwd`. Prompt is `permissions> `.

On each line:
- Blank lines: re-prompt.
- `:quit` or `:q`: close the interface and return.
- `:cwd <path>`: update the current cwd variable, print confirmation.
- Anything else: call `runOnce(line, currentCwd, projectDir)`, re-prompt.

On `close` (Ctrl+D): print a newline and return.

**Main guard:** if `process.env["NODE_ENV"] !== "test"`, check `process.argv[2]`. If present, call `runOnce(process.argv[2], process.cwd(), projectDir)` and exit (one-shot mode). Otherwise call `runRepl(projectDir, process.cwd())`.

Resolve `projectDir` from `process.env["CLAUDE_PROJECT_DIR"] ?? process.cwd()`.

### 5. Create `src/mcp-server.ts` — MCP server

Import `Server` from `@modelcontextprotocol/sdk/server/index.js`, `StdioServerTransport` from `@modelcontextprotocol/sdk/server/stdio.js`, and the relevant schema types from `@modelcontextprotocol/sdk/types.js`.

**`IAnalyzePermissionArgs` interface:**
- `command: string` — the input string (same format as REPL: bare command = Bash, or prefixed)
- `cwd?: string` — working directory; defaults to `process.env["CLAUDE_PROJECT_DIR"] ?? process.cwd()`
- `project_dir?: string` — config root; defaults to `process.env["CLAUDE_PROJECT_DIR"] ?? process.cwd()`

**`formatTraceForClaude(trace: IAuditLogEntry[]): string`**

Produces a compact multi-line string from the trace entries (skipping `config_load` and `tool_request`), suitable for including in the MCP tool response text that Claude will read and interpret for the user. Each line: `<type padded>  <formatted entry content>`.

**`runMcpServer(): Promise<void>`**

Creates a `Server` instance named `permissions-analyzer` version `1.0.0`. Registers two handlers:

`ListToolsRequestSchema`: returns one tool:
- `name`: `analyze_permission`
- `description`: `"Analyze why a bash command, file operation, or tool call would be allowed, denied, or asked by the claude-permissions system. Returns the final decision, optional reason, and a trace of which rules matched. Call this when the user asks why a command is being blocked, approved, or prompted, or wants to understand the permissions behavior for a specific command. Prefix the command with 'Read ', 'Write ', 'Edit ', 'WebFetch ', or 'Tool ' to analyze non-bash tool calls."`
- `inputSchema`: JSON Schema object with `command` (string, required), `cwd` (string, optional), `project_dir` (string, optional)

`CallToolRequestSchema`: handles `analyze_permission` by:
1. Extracting args as `IAnalyzePermissionArgs`
2. Calling `analyzePermission(args.command, cwd, projectDir)`
3. Returning a text content block: `"Decision: <decision>\nReason: <reason or none>\n\nTrace:\n<formatTraceForClaude(trace)>"`
4. Wrapping errors in a text content block with `isError: true`

Connects the server to a new `StdioServerTransport` and calls `server.connect(transport)`.

**Main guard:** if `process.env["NODE_ENV"] !== "test"`, call `runMcpServer()`.

### 6. Update `package.json`

Add scripts:
- `"repl": "bun run src/repl.ts"` — interactive REPL
- `"r": "bun run repl"` — shorthand
- `"bundle:mcp": "bun build src/mcp-server.ts --outfile plugin/dist/mcp-server.js --target bun"` — bundle MCP server
- Update `"bundle"` to `"bun run bundle:pre && bun run bundle:post && bun run bundle:mcp"`

### 7. Update `.claude/settings.json`

Add a `mcpServers` top-level key:

```json
"mcpServers": {
    "permissions-analyzer": {
        "command": "bun",
        "args": ["run", "src/mcp-server.ts"],
        "type": "stdio"
    }
}
```

The server runs from the project directory so `CLAUDE_PROJECT_DIR` in the hook env is not available — the MCP server resolves `projectDir` from `process.cwd()`, which will be the repo root when launched by Claude Code.

### 8. Write unit tests in `src/test/analyze.test.ts`

Write tests for every public export of `src/analyze.ts`:

- `parseToolCallInput`: one test per prefix variant (bare bash, Read, Write, Edit, WebFetch, Tool) plus a case-insensitive prefix test
- `analyzePermission` with a `RuleLayer` allowing `git` — verify result has `decision: "allow"` and trace contains a `rule_match` entry
- `analyzePermission` with no rules — verify result has `decision: "ask"` and trace contains a `no_rule_match` entry
- `analyzePermission` with a deny rule — verify result has `decision: "deny"` and the `reason` is forwarded

Write tests for `CapturingAuditLogger` in `src/test/audit-log.test.ts` (extend the existing file):
- `log` accumulates entries; `getEntries()` returns them in order
- `reset()` clears accumulated entries
- `getEntries()` returns a copy (mutating the return value does not affect internal state)

### 9. Write smoke tests in `scripts/repl-smoke-tests.sh`

Shell script. Each test case:
1. Creates a temp project dir with a `.claude/permissions.yaml` (inline heredoc)
2. Runs `CLAUDE_PROJECT_DIR=<tmpdir> bun run src/repl.ts "<command>"` (one-shot mode)
3. Greps stdout for the expected decision word (`ALLOW`, `DENY`, or `ASK`)
4. Reports PASS or FAIL; increments counters
5. Cleans up the temp dir

Test cases to include:
- Bash `git status` with a git:status:allow rule → `ALLOW`
- Bash `rm -rf /` with a rm deny rule → `DENY`
- Bash `ls /tmp` with no matching rule → `ASK`
- `Read /etc/passwd` with a read allow rule → `ALLOW`
- `Write /etc/passwd` with a write deny rule → `DENY`
- `WebFetch https://api.example.com` with a webfetch host:allow rule → `ALLOW`

Print `Results: N/M passed` and exit 1 if any failed.

Add `"smoke:repl": "bash scripts/repl-smoke-tests.sh"` to `package.json` scripts. Update `"test:all"` to include it.

### 10. Create `docs/MCP-SERVER.md`

New document covering:
- What the MCP server does and why it exists
- How Claude uses it (auto-invoked when user asks "why is X denied?")
- Installation: the `settings.json` `mcpServers` entry (exact JSON to paste)
- The `analyze_permission` tool: parameters (`command`, `cwd`, `project_dir`), the prefix syntax for non-bash tools, example prompts to ask Claude
- How `project_dir` is resolved (env var → process.cwd fallback)
- How to rebuild the bundle: `bun run bundle:mcp`

### 11. Update `docs/CONFIGURATION.md`

Add a new top-level section **"Debugging and testing rules"** at the end of the table of contents and as a section at the bottom of the document. The section should explain:
- The REPL: how to run it (`bun run repl`), the input prefix syntax, the `:cwd` command, and one-shot mode (`bun run repl "command"`)
- A cross-reference to `docs/MCP-SERVER.md` for the Claude-integrated version

### 12. Update `README.md`

Add a **"Debugging rules"** section after the Configuration section. Briefly describe:
- The REPL and how to invoke it
- The MCP server integration and a pointer to `docs/MCP-SERVER.md`
- A one-line example showing a REPL session

### 13. Update `plugin/README.md`

Add a **"Permission Analyzer (MCP)"** section describing the MCP server, how to enable it, and example Claude prompts. Mirror the relevant content from `docs/MCP-SERVER.md` but keep it shorter (users of the plugin don't need full development context).

## Unit Tests

- `src/test/analyze.test.ts` — full coverage of `parseToolCallInput` (7 cases) and `analyzePermission` (3 cases: allow, deny, no-match)
- `src/test/audit-log.test.ts` — extend with 3 tests for `CapturingAuditLogger` (`log`/`getEntries`, `reset`, copy semantics)
- `src/test/mcp-server.test.ts` — unit test `formatTraceForClaude` with a synthetic trace array; verify config_load and tool_request entries are excluded and rule_match entries appear

## Smoke Tests

- `scripts/repl-smoke-tests.sh` — 6 one-shot REPL invocations (see Step 9)

## Verify

1. `bun run compile` — TypeScript must compile with no errors
2. `bun run test` — all unit tests must pass
3. `bun run smoke` — existing e2e smoke tests must still pass
4. `bun run smoke:repl` — all 6 REPL smoke test cases must pass
5. `bun run bundle` — all three bundles (`pre-hook.js`, `post-hook.js`, `mcp-server.js`) must be produced in `plugin/dist/`
6. Run `bun run repl "git status"` with `CLAUDE_PROJECT_DIR` pointing to a dir that has no `.claude/permissions.yaml` — verify the output shows `ASK` (no match)
7. Verify `plugin/dist/mcp-server.js` exists after bundle

## Human Verification

1. In a terminal at the project root, run:
   ```
   CLAUDE_PROJECT_DIR=. bun run repl
   ```
   At the prompt type `git status`. Confirm the output shows a decision (allow/deny/ask depending on your local permissions.yaml) with a rule trace.

2. Type `:cwd /tmp` at the prompt. Confirm the working directory changes. Type a command that has a cwd-sensitive rule and confirm the decision reflects the new cwd.

3. Type `:quit`. Confirm the REPL exits cleanly.

4. Run `bun run repl "rm -rf /"` in one-shot mode. Confirm it prints a trace and decision, then exits.

5. In Claude Code, reload plugins with `/reload-plugins`. Then ask Claude: *"Why would the command `git push` be denied?"* Confirm Claude calls the `analyze_permission` MCP tool and explains the decision in natural language.

6. Ask Claude: *"Analyze the permission for `Read /etc/passwd`"* and confirm Claude uses the prefix syntax and returns a coherent explanation.

## Notes

- `CapturingAuditLogger` is placed in `src/audit-log.ts` (not `src/analyze.ts`) because it is a logger implementation and will likely be useful in future unit tests for other modules.
- The REPL rebuilds the `RuleRegistry` on every input. This is intentional: it keeps the YAML fresh without needing a `:reload` command and is fast enough for interactive use.
- `config_load` and `tool_request` entries are suppressed from REPL and MCP output — they appear on every invocation and add noise without helping the user understand why a specific rule matched.
- The MCP server resolves `projectDir` from `process.cwd()` because Claude Code does not inject `CLAUDE_PROJECT_DIR` into MCP server processes. When Claude Code launches the server from the project root, `process.cwd()` is the project root, which is the correct value.
- The one-shot REPL mode (`process.argv[2]` present) exists purely to make smoke testing tractable; shell scripts can capture stdout without driving an interactive readline session.
- `@modelcontextprotocol/sdk` is added as a runtime dependency (not devDependency) because `mcp-server.ts` is bundled for distribution via `plugin/dist/`.
- The `bundle` script update means `bun run bundle` (and `bun run b`) now produces all three artifacts; no changes to the individual `bundle:pre` / `bundle:post` scripts are needed.
