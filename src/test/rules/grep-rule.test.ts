import { parse as parseYaml } from "yaml";
import { GrepRule } from "../../rules/grep-rule";
import { GrepRuleFactory } from "../../rules/grep-rule-factory";
import { GrepAstNode } from "../../ast-nodes/grep-ast-node";
import { FilePathToolAstNode } from "../../ast-nodes/file-path-tool-ast-node";
import { IRule } from "../../rules/rule";

describe("GrepRule", () => {

    test("returns undefined for non-grep nodes", async () => {
        const readNode = new FilePathToolAstNode("read", "/home/user/project/README.md", "read /home/user/project/README.md");
        const rule = new GrepRule("allow", undefined, undefined);
        expect(await rule.evaluate(readNode, { cwd: "/project", env: {} })).toEqual({ context: { cwd: "/project", env: {} } });
    });

    test("returns allow when grep node matches (tool-name-literal-key)", async () => {
        const grepNode = new GrepAstNode("TODO", "/home/user/project", "Grep TODO /home/user/project");
        const rule = new GrepRule("allow", undefined, undefined);
        expect(await rule.evaluate(grepNode, { cwd: "/project", env: {} })).toEqual({
            decision: { action: "allow" },
            context: { cwd: "/project", env: {} },
        });
    });

    test("returns decision with reason when grep node matches", async () => {
        const grepNode = new GrepAstNode("TODO", "/home/user/project", "Grep TODO /home/user/project");
        const rule = new GrepRule("deny", "grep denied", undefined);
        expect(await rule.evaluate(grepNode, { cwd: "/project", env: {} })).toEqual({
            decision: { action: "deny", reason: "grep denied" },
            context: { cwd: "/project", env: {} },
        });
    });

});

describe("GrepRuleFactory.load", () => {

    test("adds one allow rule", async () => {
        const rules: IRule[] = [];
        const factory = new GrepRuleFactory();
        rules.push(...factory.load({ decide: "allow" }));
        expect(rules).toEqual([
            new GrepRule("allow", undefined, undefined),
        ]);
    });

    test("adds rule with reason", async () => {
        const rules: IRule[] = [];
        const factory = new GrepRuleFactory();
        rules.push(...factory.load({ decide: "deny", reason: "grep denied" }));
        expect(rules).toEqual([
            new GrepRule("deny", "grep denied", undefined),
        ]);
    });

    test("throws when section is not an object", async () => {
        const factory = new GrepRuleFactory();
        expect(() => factory.load(parseYaml("invalid"))).toThrow("permissions.yaml: Grep must be an object");
        expect(() => factory.load(parseYaml("null"))).toThrow("permissions.yaml: Grep must be an object");
        expect(() => factory.load(parseYaml("[]"))).toThrow("permissions.yaml: Grep must be an object");
    });

    test("throws when decide is missing", async () => {
        const factory = new GrepRuleFactory();
        expect(() => factory.load(parseYaml("{}"))).toThrow("permissions.yaml: Grep must have a decide field");
    });

    test("throws when reason is not a string", async () => {
        const factory = new GrepRuleFactory();
        expect(() => factory.load(parseYaml("decide: allow\nreason: 42"))).toThrow(
            "permissions.yaml: Grep reason must be a string"
        );
    });

});
