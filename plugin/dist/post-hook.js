// src/audit-log.ts
import { appendFileSync, existsSync, mkdirSync, readdirSync, rmSync } from "fs";
import { access, mkdir, writeFile } from "fs/promises";
import { join } from "path";
function toLocalISOString(date) {
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absOffset = Math.abs(offsetMinutes);
  const offsetHours = String(Math.floor(absOffset / 60)).padStart(2, "0");
  const offsetMins = String(absOffset % 60).padStart(2, "0");
  const year = date.getFullYear().toString();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");
  const ms = String(date.getMilliseconds()).padStart(3, "0");
  return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}.${ms}${sign}${offsetHours}:${offsetMins}`;
}
function resolveLogBaseDir(projectDir) {
  return join(projectDir, ".claude", "permissions-log");
}
var logDirGitignoreContents = `*
!.gitignore
`;
async function ensureLogDirIgnored(logBaseDir) {
  const gitignorePath = join(logBaseDir, ".gitignore");
  try {
    await access(gitignorePath);
    return;
  } catch {}
  await mkdir(logBaseDir, { recursive: true });
  await writeFile(gitignorePath, logDirGitignoreContents);
}
function resolveJsonLogPath(baseDir, now) {
  const year = now.getFullYear().toString();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  const hour = String(now.getHours()).padStart(2, "0");
  return join(baseDir, `${year}-${month}`, day, `${hour}.json`);
}
function resolveTextLogPath(baseDir, now) {
  const year = now.getFullYear().toString();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  const hour = String(now.getHours()).padStart(2, "0");
  return join(baseDir, `${year}-${month}`, day, `${hour}.log`);
}
function formatTextEntry(entry) {
  const time = entry.timestamp.slice(11, 19);
  switch (entry.type) {
    case "tool_request": {
      let inputSummary;
      if (typeof entry.input["command"] === "string") {
        inputSummary = entry.input["command"];
      } else if (typeof entry.input["file_path"] === "string") {
        inputSummary = entry.input["file_path"];
      } else {
        inputSummary = JSON.stringify(entry.input);
      }
      return `${time}  ${"TOOL".padEnd(9)}${entry.tool.padEnd(10)}"${inputSummary}"`;
    }
    case "rule_match": {
      const reasonPart = entry.reason ? ` "${entry.reason}"` : "";
      let content;
      if (entry.cmd !== undefined && entry.ruleFile) {
        const linePart = entry.ruleLine !== undefined ? `:${entry.ruleLine}` : "";
        content = `"${entry.cmd}" → ${entry.ruleFile}${linePart} → ${entry.decision}${reasonPart}`;
      } else if (entry.cmd !== undefined) {
        content = `"${entry.cmd}" → ${entry.decision}${reasonPart}`;
      } else if (entry.ruleFile) {
        const linePart = entry.ruleLine !== undefined ? `:${entry.ruleLine}` : "";
        content = `${entry.ruleFile}${linePart} → ${entry.decision}${reasonPart}`;
      } else {
        content = `→ ${entry.decision}${reasonPart}`;
      }
      return `${time}  ${"RULE".padEnd(9)}${"".padEnd(10)}${content}`;
    }
    case "no_rule_match": {
      return `${time}  ${"NOMATCH".padEnd(9)}${entry.nodeType.padEnd(10)}"${entry.cmd}"`;
    }
    case "aggregation": {
      const reasonPart = entry.reason ? ` "${entry.reason}"` : "";
      return `${time}  ${"NODE".padEnd(9)}${"".padEnd(10)}"${entry.cmd}" → ${entry.decision}${reasonPart}`;
    }
    case "final_decision": {
      const cmdPart = entry.cmd !== undefined ? `"${entry.cmd}" → ` : "→ ";
      const reasonPart = entry.reason ? ` "${entry.reason}"` : "";
      return `${time}  ${"RESULT".padEnd(9)}${entry.tool.padEnd(10)}${cmdPart}${entry.decision.toUpperCase()}${reasonPart}`;
    }
    case "config_load": {
      const ruleWord = entry.ruleCount === 1 ? "rule" : "rules";
      return `${time}  ${"CONFIG".padEnd(9)}${"".padEnd(10)}LOADED ${entry.filePath} (${entry.ruleCount} ${ruleWord})`;
    }
    case "tool_execution": {
      let executeSummary;
      if (typeof entry.input["command"] === "string") {
        executeSummary = entry.input["command"];
      } else if (typeof entry.input["file_path"] === "string") {
        executeSummary = entry.input["file_path"];
      } else {
        executeSummary = JSON.stringify(entry.input);
      }
      const errorPart = entry.isError ? " [ERROR]" : "";
      return `${time}  ${"EXECUTE".padEnd(9)}${entry.tool.padEnd(10)}"${executeSummary}"${errorPart}`;
    }
  }
}
function cleanupOldMonths(baseDir, now) {
  if (!existsSync(baseDir)) {
    return;
  }
  const currentMonthKey = now.getFullYear() * 12 + now.getMonth();
  for (const entry of readdirSync(baseDir)) {
    const match = entry.match(/^(\d{4})-(\d{2})$/);
    if (!match) {
      continue;
    }
    const entryYear = parseInt(match[1], 10);
    const entryMonth = parseInt(match[2], 10) - 1;
    const entryMonthKey = entryYear * 12 + entryMonth;
    if (entryMonthKey < currentMonthKey - 2) {
      rmSync(join(baseDir, entry), { recursive: true, force: true });
    }
  }
}
class FileAuditLogger {
  baseDir;
  now;
  constructor(baseDir, now) {
    this.baseDir = baseDir;
    this.now = now;
  }
  log(entry) {
    const jsonPath = resolveJsonLogPath(this.baseDir, this.now);
    mkdirSync(join(jsonPath, ".."), { recursive: true });
    appendFileSync(jsonPath, JSON.stringify(entry) + `
`);
    const textPath = resolveTextLogPath(this.baseDir, this.now);
    appendFileSync(textPath, formatTextEntry(entry) + `
`);
  }
}
function createFileAuditLogger(logBaseDir, now) {
  return new FileAuditLogger(logBaseDir, now);
}
function createLogger(projectDir, now) {
  const logBaseDir = resolveLogBaseDir(projectDir);
  cleanupOldMonths(logBaseDir, now);
  return createFileAuditLogger(logBaseDir, now);
}

// src/post-hook.ts
async function readPostStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf-8");
}
async function runPostHook() {
  try {
    const call = JSON.parse(await readPostStdin());
    const projectDir = process.env["CLAUDE_PROJECT_DIR"];
    if (!projectDir) {
      throw new Error("CLAUDE_PROJECT_DIR is not set");
    }
    const logger = createLogger(projectDir, new Date);
    await ensureLogDirIgnored(resolveLogBaseDir(projectDir));
    const isError = typeof call.tool_response["isError"] === "boolean" ? call.tool_response["isError"] : false;
    logger.log({
      type: "tool_execution",
      timestamp: toLocalISOString(new Date),
      tool: call.tool_name,
      input: call.tool_input,
      cwd: call.cwd,
      response: call.tool_response,
      isError
    });
    process.exit(0);
  } catch (hookError) {
    process.stderr.write(String(hookError) + `
`);
    process.exit(1);
  }
}
if (process.env["NODE_ENV"] !== "test") {
  runPostHook();
}
export {
  runPostHook,
  readPostStdin
};
