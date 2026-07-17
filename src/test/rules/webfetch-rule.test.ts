import { WebFetchRule } from "../../rules/webfetch-rule";
import { CommandAstNode } from "../../ast-nodes/command-ast-node";
import { WebFetchAstNode } from "../../ast-nodes/webfetch-ast-node";

describe("WebFetchRule", () => {

    test("returns undefined for non-webfetch nodes", async () => {
        const commandNode = new CommandAstNode("curl", {}, ["https://api.example.com"], {}, "curl https://api.example.com");
        const rule = new WebFetchRule(["api.example.com"], "allow", undefined, undefined);
        expect(await rule.evaluate(commandNode, { cwd: "/project", env: {} })).toEqual({ context: { cwd: "/project", env: {} } });
    });

    test("returns undefined when hostname does not match", async () => {
        const webfetchNode = new WebFetchAstNode("https://other.example.com/data", "WebFetch https://other.example.com/data");
        const rule = new WebFetchRule(["api.example.com"], "allow", undefined, undefined);
        expect(await rule.evaluate(webfetchNode, { cwd: "/project", env: {} })).toEqual({ context: { cwd: "/project", env: {} } });
    });

    test("returns allow when exact hostname matches (webfetch-host-allow)", async () => {
        const webfetchNode = new WebFetchAstNode("https://api.example.com/data", "WebFetch https://api.example.com/data");
        const rule = new WebFetchRule(["api.example.com"], "allow", undefined, undefined);
        expect(await rule.evaluate(webfetchNode, { cwd: "/project", env: {} })).toEqual({
            decision: { action: "allow" },
            context: { cwd: "/project", env: {} },
        });
    });

    test("returns deny with reason when exact hostname matches (webfetch-host-deny)", async () => {
        const webfetchNode = new WebFetchAstNode("https://malicious.com/data", "WebFetch https://malicious.com/data");
        const rule = new WebFetchRule(["malicious.com"], "deny", "blocked site", undefined);
        expect(await rule.evaluate(webfetchNode, { cwd: "/project", env: {} })).toEqual({
            decision: { action: "deny", reason: "blocked site" },
            context: { cwd: "/project", env: {} },
        });
    });

    test("returns allow when hostname matches any host-in entry (webfetch-host-in)", async () => {
        const webfetchNode = new WebFetchAstNode("https://cdn.example.com/file.js", "WebFetch https://cdn.example.com/file.js");
        const rule = new WebFetchRule(["api.example.com", "cdn.example.com"], "allow", undefined, undefined);
        expect(await rule.evaluate(webfetchNode, { cwd: "/project", env: {} })).toEqual({
            decision: { action: "allow" },
            context: { cwd: "/project", env: {} },
        });
    });

    test("returns undefined when hostname matches no host-in entry", async () => {
        const webfetchNode = new WebFetchAstNode("https://other.example.com/data", "WebFetch https://other.example.com/data");
        const rule = new WebFetchRule(["api.example.com", "cdn.example.com"], "allow", undefined, undefined);
        expect(await rule.evaluate(webfetchNode, { cwd: "/project", env: {} })).toEqual({ context: { cwd: "/project", env: {} } });
    });

    test("returns allow for any host when host list is empty (webfetch-tool-name-literal-allow)", async () => {
        const webfetchNode = new WebFetchAstNode("https://example.com/data", "WebFetch https://example.com/data");
        const rule = new WebFetchRule([], "allow", "Allow fetching any URL", undefined);
        expect(await rule.evaluate(webfetchNode, { cwd: "/project", env: {} })).toEqual({
            decision: { action: "allow", reason: "Allow fetching any URL" },
            context: { cwd: "/project", env: {} },
        });
    });

});
