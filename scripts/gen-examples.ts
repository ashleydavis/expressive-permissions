import { mkdir, readdir, readFile, writeFile } from "fs/promises";
import { join } from "path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { buildAst } from "../src/build-ast";
import { IToolCall } from "../src/types";

// One bash example: a name and the raw command it parses. The expected AST is generated from the
// live parser, so these fixtures double as regression snapshots.
interface IBashSpec {
    // Base file name (without extension) under examples/bash
    name: string;
    // The raw Bash command string
    command: string;
}

// The manifest of bash construct examples. One entry per distinct Bash construct so the directory
// represents the full grammar the parser understands.
const BASH_SPECS: IBashSpec[] = [
    { name: "and-operator", command: "cd /tmp && rm -rf *" },
    { name: "or-operator", command: "make || echo failed" },
    { name: "pipe", command: "git status | grep modified" },
    { name: "sequence", command: "echo a; echo b" },
    { name: "redirect-stdout", command: "cmd > out.log" },
    { name: "redirect-stderr", command: "cmd 2> err.log" },
    { name: "env-prefix", command: "FOO=bar cmd" },
    { name: "multi-env-prefix", command: "A=1 B=2 cmd" },
    { name: "env-assignment", command: "FOO=bar" },
    { name: "export", command: "export FOO=bar" },
    { name: "quoted-arg", command: "echo \"hello world\"" },
    { name: "ls-flags", command: "ls -la /tmp" },
    { name: "empty", command: "" },
    { name: "for-loop", command: "for f in a b c; do echo $f; done" },
    { name: "if-statement", command: "if test -f f; then echo yes; else echo no; fi" },
    { name: "while-loop", command: "while read line; do echo $line; done" },
    { name: "until-loop", command: "until test -f /tmp/ready; do sleep 1; done" },
    { name: "subshell", command: "(cd src && make)" },
    { name: "brace-group", command: "{ echo a; echo b; }" },
    { name: "case", command: "case $1 in start) run;; stop|halt) halt;; *) usage;; esac" },
    { name: "command-substitution", command: "echo $(whoami)" },
    { name: "backtick-substitution", command: "rm `cat list`" },
    { name: "newline-separator", command: "echo a\necho b" },
    { name: "background", command: "server & client" },
    { name: "xargs", command: "find . | xargs rm" },
    { name: "comment-trailing", command: "ls -la # list the directory" },
    { name: "comment-line", command: "echo a # note\necho b" },
];

// A minimal node shape covering every AST node field the diagram renderer reads.
interface IDiagramNode {
    type: string;
    [key: string]: unknown;
}

// A child reference produced while walking a node: the child node and an optional edge label.
interface IChildRef {
    node: IDiagramNode;
    label?: string;
}

// escapeLabel makes a string safe to embed inside a quoted Mermaid node label.
function escapeLabel(value: unknown): string {
    return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/\|/g, "&#124;")
        .replace(/\n/g, " ");
}

// escapeEdge sanitises an edge label (no quotes available there), collapsing pipes to commas.
function escapeEdge(value: string): string {
    return value.replace(/\|/g, ",").replace(/"/g, "").replace(/\n/g, " ");
}

// formatCmd renders the positional cmd field (string or string[]) for a node label.
function formatCmd(cmd: unknown): string {
    if (Array.isArray(cmd)) {
        return cmd.join(" ");
    }
    return String(cmd);
}

// nodeLabel builds the multi-line label text shown inside a node box.
function nodeLabel(node: IDiagramNode): string {
    switch (node.type) {
        case "command": {
            let label = `command<br/>binary: ${escapeLabel(node.binary)}`;
            const cmd = formatCmd(node.cmd);
            if (cmd.length > 0) {
                label += `<br/>cmd: ${escapeLabel(cmd)}`;
            }
            return label;
        }
        case "binop":
            return `binop<br/>op: ${escapeLabel(node.op)}`;
        case "for_loop":
            return `for_loop<br/>var: ${escapeLabel(node.variable)}<br/>in: ${escapeLabel((node.items as string[]).join(" "))}`;
        case "while_loop":
            return `${node.until ? "until" : "while"}_loop`;
        case "if_statement":
            return "if_statement";
        case "group":
            return `group<br/>style: ${escapeLabel(node.style)}`;
        case "case_statement":
            return `case<br/>word: ${escapeLabel(node.word)}`;
        case "xargs":
            return "xargs";
        case "bash":
            return "bash";
        case "read":
            return `read<br/>${escapeLabel(node.file_path)}`;
        case "write":
            return `write<br/>${escapeLabel(node.file_path)}`;
        case "edit":
            return `edit<br/>${escapeLabel(node.file_path)}`;
        case "multiedit":
            return `multiedit<br/>${escapeLabel(node.file_path)}`;
        case "other":
            return `other<br/>${escapeLabel(node.tool_name)}`;
        default:
            return escapeLabel(node.type);
    }
}

// childRefs returns the child nodes of a given node along with edge labels.
function childRefs(node: IDiagramNode): IChildRef[] {
    switch (node.type) {
        case "command": {
            const substitutions = (node.substitutions as IDiagramNode[] | undefined) ?? [];
            return substitutions.map((substitution) => ({ node: substitution, label: "subst" }));
        }
        case "binop":
            return [{ node: node.left as IDiagramNode }, { node: node.right as IDiagramNode }];
        case "for_loop":
            return [{ node: node.body as IDiagramNode, label: "body" }];
        case "while_loop":
            return [
                { node: node.condition as IDiagramNode, label: "cond" },
                { node: node.body as IDiagramNode, label: "body" },
            ];
        case "if_statement": {
            const refs: IChildRef[] = [
                { node: node.condition as IDiagramNode, label: "cond" },
                { node: node.thenBranch as IDiagramNode, label: "then" },
            ];
            if (node.elseBranch !== undefined) {
                refs.push({ node: node.elseBranch as IDiagramNode, label: "else" });
            }
            return refs;
        }
        case "group":
            return [{ node: node.body as IDiagramNode, label: "body" }];
        case "case_statement": {
            const clauses = (node.clauses as Array<{ patterns: string[]; body: IDiagramNode }>) ?? [];
            return clauses.map((clause) => ({ node: clause.body, label: escapeEdge(clause.patterns.join("|")) }));
        }
        case "xargs":
            return [{ node: node.child as IDiagramNode, label: "child" }];
        case "bash":
            return [{ node: node.ast as IDiagramNode }];
        default:
            return [];
    }
}

// renderMermaid produces a Mermaid `graph TD` description of an AST node and its descendants.
function renderMermaid(rootNode: IDiagramNode): string {
    const lines: string[] = ["graph TD"];
    let counter = 0;

    function walk(node: IDiagramNode): string {
        const id = `n${counter++}`;
        lines.push(`  ${id}["${nodeLabel(node)}"]`);
        for (const child of childRefs(node)) {
            const childId = walk(child.node);
            const edge = child.label !== undefined && child.label.length > 0 ? `|${child.label}|` : "";
            lines.push(`  ${id} -->${edge} ${childId}`);
        }
        return id;
    }

    walk(rootNode);
    return lines.join("\n");
}

// A parsed example document. examples/ast files carry a tool_call + ToolRoot ast; examples/bash
// files carry a raw command + bare BashAstNode ast. Both expose an `ast` object.
interface IExampleDoc {
    command?: string;
    tool_call?: { tool_input?: { command?: string } };
    ast: IDiagramNode;
}

// writeDiagram renders the Mermaid markdown file (index.md) inside a single example directory.
async function writeDiagram(parentDirectory: string, exampleName: string): Promise<void> {
    const exampleDirectory = join(parentDirectory, exampleName);
    const content = await readFile(join(exampleDirectory, "index.yaml"), "utf-8");
    const doc = parseYaml(content) as IExampleDoc;
    const command = doc.tool_call?.tool_input?.command ?? doc.command ?? "";
    const diagram = renderMermaid(doc.ast);

    const markdown = `# ${exampleName}\n\nCommand:\n\n\`\`\`sh\n${command}\n\`\`\`\n\nAST:\n\n\`\`\`mermaid\n${diagram}\n\`\`\`\n`;
    await writeFile(join(exampleDirectory, "index.md"), markdown);
}

// generateBashExamples writes one fixture per entry in BASH_SPECS to its own subdirectory
// (examples/bash/<name>/index.yaml), with the expected AST produced by the live parser.
async function generateBashExamples(): Promise<void> {
    for (const spec of BASH_SPECS) {
        const toolCall: IToolCall = { tool_name: "Bash", tool_input: { command: spec.command }, cwd: "/work" };
        const root = buildAst(toolCall, new Map());
        const doc = { command: spec.command, ast: root.type === "bash" ? root.ast : root };
        const yaml = stringifyYaml(doc, { lineWidth: 0 });
        const exampleDirectory = join("examples/bash", spec.name);
        await mkdir(exampleDirectory, { recursive: true });
        await writeFile(join(exampleDirectory, "index.yaml"), yaml);
        process.stdout.write(`wrote examples/bash/${spec.name}/index.yaml\n`);
    }
}

// generateDiagrams writes an index.md Mermaid diagram inside every example subdirectory in both
// example trees. Each example lives in its own subdirectory holding index.yaml and index.md.
async function generateDiagrams(): Promise<void> {
    for (const directory of ["examples/ast", "examples/bash"]) {
        const entries = await readdir(directory, { withFileTypes: true });
        for (const entry of entries) {
            if (entry.isDirectory()) {
                await writeDiagram(directory, entry.name);
                process.stdout.write(`wrote ${directory}/${entry.name}/index.md\n`);
            }
        }
    }
}

await generateBashExamples();
await generateDiagrams();
