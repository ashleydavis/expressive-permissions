import { ExportRule } from "../../../rules/builtin/export-rule";
import { CommandAstNode } from "../../../ast-nodes/command-ast-node";
import { FilePathToolAstNode } from "../../../ast-nodes/file-path-tool-ast-node";

describe("ExportRule", () => {

    test("returns undefined for non-command node", async () => {
        const rule = new ExportRule();
        const readNode = new FilePathToolAstNode("read", "/etc/hosts", "read /etc/hosts");
        const result = await rule.evaluate(readNode, { cwd: "/project", env: {} });
        expect(result).toEqual({ context: { cwd: "/project", env: {} } });
    });

    test("returns undefined for non-export command", async () => {
        const rule = new ExportRule();
        const commandNode = new CommandAstNode("echo", {}, ["FOO=bar"], {}, "echo FOO=bar");
        const result = await rule.evaluate(commandNode, { cwd: "/project", env: {} });
        expect(result).toEqual({ context: { cwd: "/project", env: {} } });
    });

    test("returns undefined when export has no KEY=VALUE tokens", async () => {
        const rule = new ExportRule();
        const commandNode = new CommandAstNode("export", {}, [], {}, "export");
        const result = await rule.evaluate(commandNode, { cwd: "/project", env: {} });
        expect(result).toEqual({ context: { cwd: "/project", env: {} } });
    });

    test("returns undefined when export has bare name without equals", async () => {
        const rule = new ExportRule();
        const commandNode = new CommandAstNode("export", {}, ["FOO"], {}, "export FOO");
        const result = await rule.evaluate(commandNode, { cwd: "/project", env: {} });
        expect(result).toEqual({ context: { cwd: "/project", env: {} } });
    });

    test("returns allow when export has KEY=VALUE token (export-no-rule-allow)", async () => {
        const rule = new ExportRule();
        const commandNode = new CommandAstNode("export", {}, ["FOO=bar"], {}, "export FOO=bar");
        const result = await rule.evaluate(commandNode, { cwd: "/project", env: {} });
        expect(result).toEqual({
            decision: {
                action: "allow",
                reason: "set environment variable",
            },
            context: {
                cwd: "/project",
                env: { FOO: "bar" },
            },
        });
    });

    test("returns allow when export has multiple KEY=VALUE tokens", async () => {
        const rule = new ExportRule();
        const commandNode = new CommandAstNode("export", {}, ["A=1", "B=2"], {}, "export A=1 B=2");
        const result = await rule.evaluate(commandNode, { cwd: "/project", env: {} });
        expect(result).toEqual({
            decision: {
                action: "allow",
                reason: "set environment variable",
            },
            context: {
                cwd: "/project",
                env: { A: "1", B: "2" },
            },
        });
    });

});
