import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { analyzePermission } from "./analyze";
import { IAuditLogEntry, formatTextEntry } from "./audit-log";
import { homedir } from "os";

// homeDir is resolved once at module load time.
const homeDir = homedir();

// IAnalyzePermissionArgs describes the arguments accepted by the analyze_permission MCP tool.
export interface IAnalyzePermissionArgs {
    // The input string to analyze (bare command = Bash, or prefixed for other tools).
    command: string;
    // Optional working directory; defaults to CLAUDE_PROJECT_DIR or process.cwd().
    cwd?: string;
    // Optional config root; defaults to CLAUDE_PROJECT_DIR or process.cwd().
    project_dir?: string;
}

// formatTraceForClaude produces a compact multi-line string from trace entries, suitable
// for inclusion in MCP tool response text. config_load and tool_request entries are
// suppressed as they add noise on every invocation.
export function formatTraceForClaude(trace: IAuditLogEntry[]): string {
    const lines: string[] = [];
    for (const entry of trace) {
        if (entry.type === "config_load" || entry.type === "tool_request") {
            continue;
        }
        const typePadded = entry.type.padEnd(14);
        lines.push(`${typePadded}  ${formatTextEntry(entry)}`);
    }
    return lines.join("\n");
}

// runMcpServer creates and connects the permissions-analyzer MCP server.
export async function runMcpServer(): Promise<void> {
    const server = new Server(
        { name: "permissions-analyzer", version: "1.0.0" },
        { capabilities: { tools: {} } }
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => {
        return {
            tools: [
                {
                    name: "analyze_permission",
                    description: "Analyze why a bash command, file operation, or tool call would be allowed, denied, or asked by the claude-permissions system. Returns the final decision, optional reason, and a trace of which rules matched. Call this when the user asks why a command is being blocked, approved, or prompted, or wants to understand the permissions behavior for a specific command. Prefix the command with 'Read ', 'Write ', 'Edit ', 'WebFetch ', or 'Tool ' to analyze non-bash tool calls.",
                    inputSchema: {
                        type: "object",
                        properties: {
                            command: {
                                type: "string",
                                description: "The command or tool input to analyze.",
                            },
                            cwd: {
                                type: "string",
                                description: "Working directory for the analysis.",
                            },
                            project_dir: {
                                type: "string",
                                description: "Config root directory for loading permissions.yaml.",
                            },
                        },
                        required: ["command"],
                    },
                },
            ],
        };
    });

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        if (request.params.name !== "analyze_permission") {
            return {
                content: [{ type: "text", text: `Unknown tool: ${request.params.name}` }],
                isError: true,
            };
        }

        const rawArgs: unknown = request.params.arguments;
        const args = rawArgs as IAnalyzePermissionArgs;
        const defaultDir = process.env["CLAUDE_PROJECT_DIR"] ?? process.cwd();
        const cwd = args.cwd ?? defaultDir;
        const projectDir = args.project_dir ?? defaultDir;

        try {
            const result = await analyzePermission(args.command, cwd, projectDir, homeDir);
            const reasonLine = result.reason !== undefined ? result.reason : "none";
            const traceText = formatTraceForClaude(result.trace);
            const responseText = `Decision: ${result.decision}\nReason: ${reasonLine}\n\nTrace:\n${traceText}`;

            return {
                content: [{ type: "text", text: responseText }],
            };
        }
        catch (error) {
            return {
                content: [{ type: "text", text: String(error) }],
                isError: true,
            };
        }
    });

    const transport = new StdioServerTransport();
    await server.connect(transport);
}

// Guard prevents auto-invocation when imported by tests.
if (process.env["NODE_ENV"] !== "test") {
    runMcpServer();
}
