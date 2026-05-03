import { readFileSync } from "fs";
import { parse as parseYaml } from "yaml";
import { buildAst } from "../src/build-ast";
import { ToolCall, ToolRoot } from "../src/types";

// Contents of a single AST example YAML file
interface IExample {
    // The tool call input to pass to buildAst
    tool_call: ToolCall;
    // The expected ToolRoot output as a plain object parsed from YAML
    ast: IYamlAstNode;
}

// A YAML-parsed AST node (loosely typed to match all ToolRoot shapes)
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

// Serializes a value to JSON with all object keys sorted recursively.
// This normalises key-insertion order differences between the YAML parser and TypeScript.
function stableJson(value: ToolRoot | IYamlAstNode): string {
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

const filePath = process.argv[2];
if (!filePath) {
    process.stderr.write("Usage: bun scripts/check-ast-example.ts <file.yaml>\n");
    process.exit(2);
}

const content = readFileSync(filePath, "utf-8");
const example = parseYaml(content) as IExample;

const actual = buildAst(example.tool_call);
const actualJson = stableJson(actual);
const expectedJson = stableJson(example.ast as unknown as IYamlAstNode);

if (actualJson !== expectedJson) {
    process.stderr.write(`  expected: ${JSON.stringify(example.ast, null, 2)}\n`);
    process.stderr.write(`  actual:   ${JSON.stringify(actual, null, 2)}\n`);
    process.exit(1);
}
