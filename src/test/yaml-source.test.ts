import { parseDocument } from "yaml";
import { annotateLines, lineOfOffset, parsePermissionsYaml } from "../yaml-source";

describe("lineOfOffset", () => {

    test("returns 1 for offset 0", () => {
        expect(lineOfOffset("hello\nworld", 0)).toBe(1);
    });

    test("returns 1 for offset within first line", () => {
        expect(lineOfOffset("hello\nworld", 4)).toBe(1);
    });

    test("returns 2 for offset on second line", () => {
        expect(lineOfOffset("hello\nworld", 6)).toBe(2);
    });
});

describe("annotateLines", () => {

    test("stamps sourceLocation on entry with decide key", () => {
        const source = "bash:\n  git:\n    decide: allow\n";
        const doc = parseDocument(source);
        const config = doc.toJS() as Record<string, Record<string, Record<string, Record<string, string | number>>>>;
        annotateLines(doc.contents, config, source, ".claude/permissions.yaml");
        expect(config["bash"]!["git"]!.sourceLocation!.file).toBe(".claude/permissions.yaml");
        expect(config["bash"]!["git"]!.sourceLocation!.line).toBe(3);
    });
});

describe("parsePermissionsYaml", () => {

    test("returns annotated config", () => {
        const content = "bash:\n  ls:\n    decide: allow\n";
        const config = parsePermissionsYaml(content, "/tmp/permissions.yaml");
        const lsEntry = config.bash!["ls"] as Record<string, Record<string, string | number>>;
        expect(lsEntry.sourceLocation!.line).toBe(3);
        expect(lsEntry.sourceLocation!.file).toBe("/tmp/permissions.yaml");
    });

    test("returns empty config for a comment-only document", () => {
        const config = parsePermissionsYaml("# only comments\n", "/tmp/permissions.yaml");
        expect(config).toEqual({});
    });
});
