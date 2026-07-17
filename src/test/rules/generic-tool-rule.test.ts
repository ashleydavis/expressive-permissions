import { parse as parseYaml } from "yaml";
import { GenericToolRule } from "../../rules/generic-tool-rule";
import { GenericToolRuleFactory } from "../../rules/generic-tool-rule-factory";
import { GrepAstNode } from "../../ast-nodes/grep-ast-node";
import { ToolAstNode } from "../../ast-nodes/tool-ast-node";
import { WebFetchAstNode } from "../../ast-nodes/webfetch-ast-node";
import { IRule } from "../../rules/rule";

describe("GenericToolRule", () => {

    test("returns undefined for non-tool-call nodes", async () => {
        const grepNode = new GrepAstNode("TODO", "/home/user/project", "Grep TODO /home/user/project");
        const rule = new GenericToolRule("mcp__my_server__*", "allow", undefined, undefined, undefined);
        expect(await rule.evaluate(grepNode, { cwd: "/project", env: {} })).toEqual({ context: { cwd: "/project", env: {} } });
    });

    test("returns allow when literal WebFetch pattern matches a webfetch node", async () => {
        const webfetchNode = new WebFetchAstNode("https://example.com/data", "WebFetch https://example.com/data");
        const rule = new GenericToolRule("WebFetch", "allow", "Allow fetching any URL", undefined, undefined);
        expect(await rule.evaluate(webfetchNode, { cwd: "/project", env: {} })).toEqual({
            decision: { action: "allow", reason: "Allow fetching any URL" },
            context: { cwd: "/project", env: {} },
        });
    });

    test("returns undefined when tool_name does not match glob", async () => {
        const toolNode = new ToolAstNode("mcp__other__search", {}, "mcp__other__search");
        const rule = new GenericToolRule("mcp__my_server__*", "allow", undefined, undefined, undefined);
        expect(await rule.evaluate(toolNode, { cwd: "/project", env: {} })).toEqual({ context: { cwd: "/project", env: {} } });
    });

    test("returns allow when tool_name matches glob (tool-name-glob-allow)", async () => {
        const toolNode = new ToolAstNode("mcp__my_server__search", { query: "foo" }, "mcp__my_server__search");
        const rule = new GenericToolRule("mcp__my_server__*", "allow", undefined, undefined, undefined);
        expect(await rule.evaluate(toolNode, { cwd: "/project", env: {} })).toEqual({
            decision: { action: "allow" },
            context: { cwd: "/project", env: {} },
        });
    });

    test("returns decision with reason when tool_name matches", async () => {
        const toolNode = new ToolAstNode("mcp__my_server__fetch", {}, "mcp__my_server__fetch");
        const rule = new GenericToolRule("mcp__my_server__*", "deny", "server tools denied", undefined, undefined);
        expect(await rule.evaluate(toolNode, { cwd: "/project", env: {} })).toEqual({
            decision: { action: "deny", reason: "server tools denied" },
            context: { cwd: "/project", env: {} },
        });
    });

    test("returns allow when tool_name matches any tool-in entry (tool-name-tool-in-allow)", async () => {
        const toolNode = new ToolAstNode("mcp__my_server__search", { query: "foo" }, "mcp__my_server__search");
        const rule = new GenericToolRule(
            undefined,
            "allow",
            undefined,
            ["mcp__my_server__search", "mcp__my_server__fetch"]
        , undefined);
        expect(await rule.evaluate(toolNode, { cwd: "/project", env: {} })).toEqual({
            decision: { action: "allow" },
            context: { cwd: "/project", env: {} },
        });
    });

    test("returns undefined when tool_name matches no tool-in entry", async () => {
        const toolNode = new ToolAstNode("mcp__my_server__other", {}, "mcp__my_server__other");
        const rule = new GenericToolRule(
            undefined,
            "allow",
            undefined,
            ["mcp__my_server__search", "mcp__my_server__fetch"]
        , undefined);
        expect(await rule.evaluate(toolNode, { cwd: "/project", env: {} })).toEqual({ context: { cwd: "/project", env: {} } });
    });

    test("throws when neither pattern nor toolIn is provided", async () => {
        expect(() => new GenericToolRule(undefined, "allow", undefined, undefined, undefined)).toThrow(
            "GenericToolRule must have either pattern or toolIn"
        );
    });

});

describe("GenericToolRuleFactory.load", () => {

    test("uses config key as implicit glob pattern", async () => {
        const rules: IRule[] = [];
        const factory = new GenericToolRuleFactory("mcp__my_server__*");
        rules.push(...factory.load({ decide: "allow" }));
        expect(rules).toEqual([
            new GenericToolRule("mcp__my_server__*", "allow", undefined, undefined, undefined),
        ]);
    });

    test("uses explicit tool field when present", async () => {
        const rules: IRule[] = [];
        const factory = new GenericToolRuleFactory("my-label");
        rules.push(...factory.load({ tool: "mcp__my_server__*", decide: "allow" }));
        expect(rules).toEqual([
            new GenericToolRule("mcp__my_server__*", "allow", undefined, undefined, undefined),
        ]);
    });

    test("adds rule with reason", async () => {
        const rules: IRule[] = [];
        const factory = new GenericToolRuleFactory("mcp__my_server__*");
        rules.push(...factory.load({ decide: "deny", reason: "server tools denied" }));
        expect(rules).toEqual([
            new GenericToolRule("mcp__my_server__*", "deny", "server tools denied", undefined, undefined),
        ]);
    });

    test("loads tool-in OR list (tool-name-tool-in-allow)", async () => {
        const rules: IRule[] = [];
        const factory = new GenericToolRuleFactory("my-server-allow");
        rules.push(...factory.load({
            "tool-in": ["mcp__my_server__search", "mcp__my_server__fetch"],
            decide: "allow",
        }));
        expect(rules).toEqual([
            new GenericToolRule(
                undefined,
                "allow",
                undefined,
                ["mcp__my_server__search", "mcp__my_server__fetch"]
            , undefined),
        ]);
    });

    test("throws when tool-in is not an array", async () => {
        const factory = new GenericToolRuleFactory("my-server-allow");
        expect(() => factory.load(parseYaml("tool-in: invalid\ndecide: allow"))).toThrow(
            "permissions.yaml: my-server-allow tool-in must be an array"
        );
    });

    test("throws when tool-in entry is not a string", async () => {
        const factory = new GenericToolRuleFactory("my-server-allow");
        expect(() => factory.load(parseYaml("tool-in:\n  - 42\ndecide: allow"))).toThrow(
            "permissions.yaml: my-server-allow tool-in entries must be strings"
        );
    });

    test("throws when section is not an object", async () => {
        const factory = new GenericToolRuleFactory("mcp__my_server__*");
        expect(() => factory.load(parseYaml("invalid"))).toThrow("permissions.yaml: mcp__my_server__* must be an object");
        expect(() => factory.load(parseYaml("null"))).toThrow("permissions.yaml: mcp__my_server__* must be an object");
        expect(() => factory.load(parseYaml("[]"))).toThrow("permissions.yaml: mcp__my_server__* must be an object");
    });

    test("throws when decide is missing", async () => {
        const factory = new GenericToolRuleFactory("mcp__my_server__*");
        expect(() => factory.load(parseYaml("{}"))).toThrow("permissions.yaml: mcp__my_server__* must have a decide field");
    });

    test("throws when reason is not a string", async () => {
        const factory = new GenericToolRuleFactory("mcp__my_server__*");
        expect(() => factory.load(parseYaml("decide: allow\nreason: 42"))).toThrow(
            "permissions.yaml: mcp__my_server__* reason must be a string"
        );
    });

    test("throws when tool is not a string", async () => {
        const factory = new GenericToolRuleFactory("my-label");
        expect(() => factory.load(parseYaml("tool: 42\ndecide: allow"))).toThrow(
            "permissions.yaml: my-label tool must be a string"
        );
    });

});
