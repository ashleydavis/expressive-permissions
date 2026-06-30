import { IToolCall, ToolRoot, IEditEntry, IRead, IEdit, AstNode, IBinOp, ICommand, ICommandDescriptor, BashAstNode, IXargsNode, IIfStatement } from "./types";
import { parseBash, lex, IToken } from "./parse-bash";

// Single-character xargs flags that consume the next token as their value.
const XARGS_VALUE_FLAGS: Set<string> = new Set(["n", "P", "I", "i", "L", "l", "s", "a", "d", "E", "e"]);

// Long xargs option names (without --) that consume the next token as their value.
const XARGS_VALUE_LONG_FLAGS: Set<string> = new Set([
    "max-args", "max-procs", "replace", "max-lines", "max-chars", "arg-file", "delimiter", "eof",
]);

// Result of parseXargsCommand: the xargs-specific options and the parsed subcommand child.
interface IXargsParseResult {
    // Options consumed by xargs itself
    options: Record<string, string | boolean>;
    // The parsed subcommand AST (may include redirect wrappers)
    child: BashAstNode;
}

// Parses the raw xargs command string, splitting xargs-own options from the subcommand.
// descriptors is passed through to parseBash for the subcommand.
// Returns the xargs options map and the parsed subcommand AST.
export function parseXargsCommand(raw: string, descriptors: Map<string, ICommandDescriptor>): IXargsParseResult {
    const tokens: IToken[] = lex(raw);
    const options: Record<string, string | boolean> = {};
    const emptyCommand: ICommand = {
        type: "command",
        binary: "",
        options: {},
        cmd: [],
        envPrefix: {},
        raw: "",
    };

    // Skip index 0 (the xargs binary word token)
    let index = 1;

    // Walk tokens while they are word tokens (xargs options)
    while (index < tokens.length && tokens[index].kind === "word") {
        const token = tokens[index];

        if (token.value === "--") {
            index++;
            break;
        }

        if (!token.value.startsWith("-")) {
            break;
        }

        if (token.value.startsWith("--")) {
            const longPart = token.value.substring(2);
            const eqIdx = longPart.indexOf("=");
            if (eqIdx !== -1) {
                options[longPart.substring(0, eqIdx)] = longPart.substring(eqIdx + 1);
                index++;
            }
            else if (XARGS_VALUE_LONG_FLAGS.has(longPart)) {
                const nextValue = index + 1 < tokens.length ? tokens[index + 1].value : "";
                options[longPart] = nextValue;
                index += 2;
            }
            else {
                options[longPart] = true;
                index++;
            }
        }
        else {
            const rest = token.value.substring(1);
            if (XARGS_VALUE_FLAGS.has(rest[0])) {
                if (rest.length > 1) {
                    options[rest[0]] = rest.substring(1);
                    index++;
                }
                else {
                    const nextValue = index + 1 < tokens.length ? tokens[index + 1].value : "";
                    options[rest] = nextValue;
                    index += 2;
                }
            }
            else {
                for (const ch of rest) {
                    options[ch] = true;
                }
                index++;
            }
        }
    }

    // Skip any op-kind tokens (redirections before the subcommand)
    while (index < tokens.length && tokens[index].kind === "op") {
        index++;
        if (index < tokens.length && tokens[index].kind === "word") {
            index++;
        }
    }

    if (index >= tokens.length) {
        return { options, child: emptyCommand };
    }

    const subcmdStart = tokens[index].start;
    const subcmdRaw = raw.substring(subcmdStart);
    const child = parseBash(subcmdRaw, descriptors);

    return { options, child };
}

// Recursively transforms Command nodes with binary "xargs" into IXargsNode intermediate nodes.
// Intermediate nodes (binop, loops, if, group, case) are walked to transform their children;
// embedded command substitutions are walked too. Other nodes are returned unchanged.
export function transformXargsNodes(node: BashAstNode, descriptors: Map<string, ICommandDescriptor>): BashAstNode {
    if (node.type === "command") {
        if (node.binary === "xargs") {
            const { options, child } = parseXargsCommand(node.raw, descriptors);
            const xargsNode: IXargsNode = {
                type: "xargs",
                options,
                child,
                raw: node.raw,
            };
            return xargsNode;
        }
        if (node.substitutions !== undefined && node.substitutions.length > 0) {
            const transformed: ICommand = {
                ...node,
                substitutions: node.substitutions.map((substitution) => transformXargsNodes(substitution, descriptors)),
            };
            return transformed;
        }
        return node;
    }

    if (node.type === "redirect") {
        return {
            ...node,
            command: transformXargsNodes(node.command, descriptors),
        };
    }

    if (node.type === "binop") {
        return {
            ...node,
            left: transformXargsNodes(node.left, descriptors),
            right: transformXargsNodes(node.right, descriptors),
        };
    }

    if (node.type === "for_loop") {
        return {
            ...node,
            body: transformXargsNodes(node.body, descriptors),
        };
    }

    if (node.type === "while_loop") {
        return {
            ...node,
            condition: transformXargsNodes(node.condition, descriptors),
            body: transformXargsNodes(node.body, descriptors),
        };
    }

    if (node.type === "group") {
        return {
            ...node,
            body: transformXargsNodes(node.body, descriptors),
        };
    }

    if (node.type === "case_statement") {
        return {
            ...node,
            clauses: node.clauses.map((clause) => ({
                ...clause,
                body: transformXargsNodes(clause.body, descriptors),
            })),
        };
    }

    if (node.type === "if_statement") {
        const transformed: IIfStatement = {
            ...node,
            condition: transformXargsNodes(node.condition, descriptors),
            thenBranch: transformXargsNodes(node.thenBranch, descriptors),
        };
        if (node.elseBranch !== undefined) {
            transformed.elseBranch = transformXargsNodes(node.elseBranch, descriptors);
        }
        return transformed;
    }

    return node;
}

// expandToken substitutes $VAR and ${VAR} references in a single string using the
// provided vars dict. Unknown variable references are left as-is.
export function expandToken(token: string, vars: Record<string, string>): string {
    return token.replace(
        /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
        (match: string, braced: string, unbraced: string) => {
            const varName = braced || unbraced;
            return vars[varName] !== undefined ? vars[varName] : match;
        }
    );
}

// expandCommandOptions clones a Command node with binary, flag values, and positionals expanded
// against the provided vars dict. The raw field is preserved unchanged.
export function expandCommandOptions(node: ICommand, vars: Record<string, string>): ICommand {
    const expandedOptions: Record<string, string | boolean> = {};
    for (const [key, value] of Object.entries(node.options)) {
        expandedOptions[key] = typeof value === "string" ? expandToken(value, vars) : value;
    }

    let expandedCmd: string | string[];
    if (typeof node.cmd === "string") {
        expandedCmd = expandToken(node.cmd, vars);
    }
    else {
        expandedCmd = node.cmd.map((positional: string) => expandToken(positional, vars));
    }

    return {
        ...node,
        binary: expandToken(node.binary, vars),
        options: expandedOptions,
        cmd: expandedCmd,
    };
}

// describeNode returns a human-readable string representation of an AST node for log output.
// For command nodes it returns the raw command string. For tool-root leaf nodes it returns
// the relevant file path or tool name. For intermediate nodes it recursively rebuilds
// the expression from its children.
export function describeNode(node: AstNode): string {
    switch (node.type) {
        case "command":
            return node.raw;
        case "xargs":
            return node.raw;
        case "redirect":
            return describeNode(node.command);
        case "binop":
            return `${describeNode((node as IBinOp).left)} ${(node as IBinOp).op} ${describeNode((node as IBinOp).right)}`;
        case "for_loop":
            return node.raw;
        case "while_loop":
            return node.raw;
        case "group":
            return node.raw;
        case "case_statement":
            return node.raw;
        case "if_statement":
            return node.raw;
        case "bash":
            return node.raw;
        case "read":
            return node.file_path;
        case "write":
            return node.file_path;
        case "edit":
            return node.file_path;
        case "multiedit":
            return node.file_path;
        case "other":
            return node.tool_name;
    }
}

// buildAst converts a raw IToolCall into the typed ToolRoot that the interpreter and rules see.
// descriptors is used to resolve flag arity and positional kinds for Bash command parsing.
// Switches on tool_name and maps the tool_input fields to a strongly-typed node.
// Unknown tools fall through to an OtherTool node that preserves the raw input.
export function buildAst(call: IToolCall, descriptors: Map<string, ICommandDescriptor>): ToolRoot {
    switch (call.tool_name) {
        case "Bash":
        case "Shell": {
            const command = call.tool_input.command as string;
            return {
                type: "bash",
                raw: command,
                ast: transformXargsNodes(parseBash(command, descriptors), descriptors),
            };
        }
        case "Read": {
            const node: IRead = {
                type: "read",
                file_path: call.tool_input.file_path as string,
            };
            if (call.tool_input.offset !== undefined) {
                node.offset = call.tool_input.offset as number;
            }
            if (call.tool_input.limit !== undefined) {
                node.limit = call.tool_input.limit as number;
            }
            return node;
        }
        case "Write": {
            return {
                type: "write",
                file_path: call.tool_input.file_path as string,
                content: call.tool_input.content as string,
            };
        }
        case "Edit": {
            const node: IEdit = {
                type: "edit",
                file_path: call.tool_input.file_path as string,
                old_string: call.tool_input.old_string as string,
                new_string: call.tool_input.new_string as string,
            };
            if (call.tool_input.replace_all !== undefined) {
                node.replace_all = call.tool_input.replace_all as boolean;
            }
            return node;
        }
        case "MultiEdit": {
            return {
                type: "multiedit",
                file_path: call.tool_input.file_path as string,
                edits: call.tool_input.edits as IEditEntry[],
            };
        }
        default: {
            return {
                type: "other",
                tool_name: call.tool_name,
                tool_input: call.tool_input,
            };
        }
    }
}
