import { readFileSync } from "fs";
import { parse as parseYaml } from "yaml";
import { buildAst } from "../src/build-ast";
import { BashAstNode, IBash, ICommandDescriptor, IFlagDescriptor, IPositionalDescriptor, IToolCall } from "../src/types";

// Contents of a single bash example YAML file. Unlike the examples/ast format, these focus on a
// single Bash command string and assert only the parsed Bash sub-AST (the `ast` field of the
// `bash` tool root), keeping the fixtures compact and construct-focused.
interface IExample {
    // The raw Bash command string to parse
    command: string;
    // Optional inline command descriptors keyed by command name
    descriptors?: Record<string, IYamlDescriptor>;
    // The expected Bash sub-AST as a plain object parsed from YAML
    ast: IYamlAstNode;
}

// A command descriptor as it appears in an example YAML file
interface IYamlDescriptor {
    // Optional human-readable summary of the command
    description?: string;
    // Positional slot definitions in order
    positionals?: IYamlPositional[];
    // Flag definitions keyed by pipe-separated alias group
    flags?: Record<string, IYamlFlag>;
}

// A flag descriptor as it appears in an example YAML file
interface IYamlFlag {
    // 0 = boolean, 1 = consumes next token
    arity: 0 | 1;
    // Whether the consumed value is a path or opaque string
    kind?: "path" | "string";
    // Optional human-readable summary of the flag
    description?: string;
}

// A positional descriptor as it appears in an example YAML file
interface IYamlPositional {
    // Whether the value is a path or opaque string
    kind: "path" | "string";
    // Optional human-readable summary of the positional
    description?: string;
    // Whether this slot captures all remaining positional tokens
    variadic?: boolean;
}

// A YAML-parsed AST node (loosely typed to match all BashAstNode shapes)
interface IYamlAstNode {
    // Node type discriminator
    type: string;
    // All other fields vary by node type
    [key: string]: IYamlFieldValue;
}

// Union of all value types that can appear in a YAML-parsed AST node
type IYamlFieldValue =
    | string
    | boolean
    | number
    | IYamlAstNode
    | IYamlAstNode[]
    | string[]
    | number[]
    | Record<string, string | boolean | number>;

// Serializes a value to JSON with all object keys sorted recursively, normalising key-insertion
// order differences between the YAML parser and TypeScript.
function stableJson(value: BashAstNode | IYamlAstNode): string {
    return JSON.stringify(value, (_key, nodeValue) => {
        if (nodeValue !== null && typeof nodeValue === "object" && !Array.isArray(nodeValue)) {
            return Object.fromEntries(
                Object.entries(nodeValue as Record<string, IYamlFieldValue>)
                    .sort(([keyA], [keyB]) => keyA.localeCompare(keyB))
            );
        }
        return nodeValue;
    });
}

// Converts the optional inline YAML descriptors block into a Map<string, ICommandDescriptor>.
function buildDescriptorMap(yamlDescriptors: Record<string, IYamlDescriptor> | undefined): Map<string, ICommandDescriptor> {
    if (yamlDescriptors === undefined) {
        return new Map();
    }

    const result = new Map<string, ICommandDescriptor>();

    for (const [commandName, yamlDescriptor] of Object.entries(yamlDescriptors)) {
        const positionals: IPositionalDescriptor[] = (yamlDescriptor.positionals ?? []).map(
            (yamlPositional) => ({
                kind: yamlPositional.kind,
                description: yamlPositional.description ?? "",
                variadic: yamlPositional.variadic ?? false,
            })
        );

        const flags: { [aliasGroup: string]: IFlagDescriptor } = {};
        for (const [aliasGroup, yamlFlag] of Object.entries(yamlDescriptor.flags ?? {})) {
            flags[aliasGroup] = {
                arity: yamlFlag.arity,
                kind: yamlFlag.kind ?? "string",
                description: yamlFlag.description ?? "",
            };
        }

        result.set(commandName, {
            description: yamlDescriptor.description ?? "",
            positionals,
            flags,
        });
    }

    return result;
}

const filePath = process.argv[2];
if (!filePath) {
    process.stderr.write("Usage: bun scripts/check-bash-example.ts <file.yaml>\n");
    process.exit(2);
}

const content = readFileSync(filePath, "utf-8");
const example = parseYaml(content) as IExample;

const descriptors = buildDescriptorMap(example.descriptors);
const toolCall: IToolCall = { tool_name: "Bash", tool_input: { command: example.command }, cwd: "/work" };
const root = buildAst(toolCall, descriptors) as IBash;
const actual = root.ast;
const actualJson = stableJson(actual);
const expectedJson = stableJson(example.ast);

if (actualJson !== expectedJson) {
    process.stderr.write(`  expected: ${JSON.stringify(example.ast, null, 2)}\n`);
    process.stderr.write(`  actual:   ${JSON.stringify(actual, null, 2)}\n`);
    process.exit(1);
}
