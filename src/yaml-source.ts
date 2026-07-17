import { isMap, isPair, isScalar, isSeq, Node, parseDocument } from "yaml";
import { IPermissionsConfig } from "./config";

// lineOfOffset returns the 1-based line number for a character offset in a source string.
export function lineOfOffset(source: string, offset: number): number {

    let line = 1;

    for (let index = 0; index < offset; index++) {
        if (source[index] === "\n") {
            line++;
        }
    }

    return line;
}

// annotateLines walks a YAML AST node and stamps file and line onto each object with a decide field.
export function annotateLines(node: Node | null, jsValue: unknown, source: string, displayFile: string): void {

    if (isMap(node) && jsValue !== null && typeof jsValue === "object" && !Array.isArray(jsValue)) {
        const jsObject = jsValue as Record<string, any>;

        if ("decide" in jsObject && node.range) {
            jsObject["sourceLocation"] = {
                file: displayFile,
                line: lineOfOffset(source, node.range[0]),
            };
        }

        for (const pair of node.items) {
            if (!isPair(pair) || !isScalar(pair.key)) {
                continue;
            }

            const key = String(pair.key.value);

            if (key in jsObject) {
                annotateLines(pair.value as Node, jsObject[key], source, displayFile);
            }
        }
    }
    else if (isSeq(node) && Array.isArray(jsValue)) {
        for (let index = 0; index < node.items.length; index++) {
            annotateLines(node.items[index] as Node, jsValue[index], source, displayFile);
        }
    }
}

// Parse permissions YAML and annotate each rule entry with file and line.
export function parsePermissionsYaml(content: string, displayFile: string): IPermissionsConfig {

    const doc = parseDocument(content);
    if (doc.errors.length > 0) {
        throw doc.errors[0];
    }

    // An empty or comment-only document has no content node; treat it as an empty config.
    if (!doc.contents) {
        return {};
    }

    const config = doc.toJS() as IPermissionsConfig;
    annotateLines(doc.contents, config, content, displayFile);
    return config;
}
