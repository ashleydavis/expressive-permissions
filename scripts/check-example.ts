import { readFile } from "fs/promises";
import { join } from "path";
import { parse as parseYaml } from "yaml";
import { parse } from "../src/parse";
import { ICommandDescriptor } from "../src/types";

const PARSER_SET_GUARD_FILES = [
    join(import.meta.dir, "..", "src", "parse.ts"),
    join(import.meta.dir, "..", "src", "tokenizer.ts"),
];

// checkNoNewSetsInParser exits non-zero if parse.ts or tokenizer.ts contain new Set.
async function checkNoNewSetsInParser(): Promise<void> {

    for (const filePath of PARSER_SET_GUARD_FILES) {
        const content = await readFile(filePath, "utf-8");
        const lines = content.split("\n");

        for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
            if (lines[lineIndex].includes("new Set")) {
                process.stderr.write(`FAIL: new Set is not allowed in ${filePath} without approval (line ${lineIndex + 1})\n`);
                process.exit(1);
            }
        }
    }
}

await checkNoNewSetsInParser();

const exampleName = process.argv[2];

if (!exampleName) {
    process.stderr.write("Usage: bun scripts/check-example.ts <example-name>\n");
    process.exit(2);
}

interface IRawFixtureFlag {
    arity: 0 | 1;
}

interface IRawFixtureDescriptor {
    flags?: Record<string, IRawFixtureFlag>;
}

interface IFixture {
    tool_call: { tool_name: string; tool_input: Record<string, string> };
    ast: Record<string, unknown>;
    descriptors?: Record<string, IRawFixtureDescriptor>;
}

// registryFromFixture builds a command registry from a fixture descriptors block.
function registryFromFixture(fixtureDescriptors: Record<string, IRawFixtureDescriptor>): Map<string, ICommandDescriptor> {

    const registry: Map<string, ICommandDescriptor> = new Map();

    for (const [commandName, rawDescriptor] of Object.entries(fixtureDescriptors)) {
        const flags: Record<string, { arity: 0 | 1; kind: "string"; description: string }> = {};

        if (rawDescriptor.flags !== undefined) {
            for (const [flagName, rawFlag] of Object.entries(rawDescriptor.flags)) {
                flags[flagName] = { arity: rawFlag.arity, kind: "string", description: "" };
            }
        }

        registry.set(commandName, {
            description: commandName,
            positionals: [],
            flags: flags,
        });
    }

    return registry;
}

// Recursively sort object keys so structural comparison ignores key ordering while preserving array order.
function sortKeysDeep(value: any): any {

    if (Array.isArray(value)) {
        return value.map(element => sortKeysDeep(element));
    }

    if (value && typeof value === "object") {
        const sortedObject: Record<string, any> = {};

        for (const key of Object.keys(value).sort()) {
            sortedObject[key] = sortKeysDeep(value[key]);
        }

        return sortedObject;
    }

    return value;
}

const fixturePath = join(import.meta.dir, "..", "examples", "ast", exampleName, "index.yaml");
const fixtureContent = await readFile(fixturePath, "utf-8");
const fixture = parseYaml(fixtureContent) as IFixture;

const registry = fixture.descriptors !== undefined
    ? registryFromFixture(fixture.descriptors)
    : new Map();

const actual = parse({
    tool_name: fixture.tool_call.tool_name,
    tool_input: fixture.tool_call.tool_input,
    cwd: "/project",
}, registry);

if (JSON.stringify(sortKeysDeep(actual)) !== JSON.stringify(sortKeysDeep(fixture.ast))) {
    process.stderr.write(`FAIL  ${exampleName}\n`);
    process.stderr.write(`  expected: ${JSON.stringify(fixture.ast, null, 2)}\n`);
    process.stderr.write(`  actual:   ${JSON.stringify(actual, null, 2)}\n`);
    process.exit(1);
}

process.stdout.write(`PASS  ${exampleName}\n`);
