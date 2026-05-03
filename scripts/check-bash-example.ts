import { readFileSync } from "fs";
import { parse as parseYaml } from "yaml";
import { parseBash } from "../src/parse-bash";
import { BashAstNode } from "../src/types";

// Contents of a single example YAML file
interface IExample {
    // The raw bash command to parse
    command: string;
    // The expected AST as a plain object parsed from YAML
    ast: IYamlAstNode;
}

// A YAML-parsed AST node (loosely typed to match both Command and BinOp shapes)
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
    | IYamlAstNode
    | IYamlAstNode[]
    | string[]
    | Record<string, string | boolean>;

// Serializes a value to JSON with all object keys sorted recursively.
// This normalises key-insertion order differences between the YAML parser and TypeScript.
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

const filePath = process.argv[2];
if (!filePath) {
    process.stderr.write("Usage: bun scripts/check-bash-example.ts <file.yaml>\n");
    process.exit(2);
}

const content = readFileSync(filePath, "utf-8");
const example = parseYaml(content) as IExample;

const actual = parseBash(example.command);
const actualJson = stableJson(actual);
const expectedJson = stableJson(example.ast);

if (actualJson !== expectedJson) {
    process.stderr.write(`  expected: ${JSON.stringify(example.ast, null, 2)}\n`);
    process.stderr.write(`  actual:   ${JSON.stringify(actual, null, 2)}\n`);
    process.exit(1);
}
