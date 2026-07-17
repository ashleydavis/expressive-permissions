import { EmptyCommandRule } from "../../../rules/builtin/empty-command-rule";
import { CommandAstNode } from "../../../ast-nodes/command-ast-node";
import { FilePathToolAstNode } from "../../../ast-nodes/file-path-tool-ast-node";

describe("EmptyCommandRule", () => {

    test("returns undefined for non-command node", async () => {
        const rule = new EmptyCommandRule();
        const readNode = new FilePathToolAstNode("read", "/etc/hosts", "read /etc/hosts");
        const result = await rule.evaluate(readNode, { cwd: "/project", env: {} });
        expect(result).toEqual({ context: { cwd: "/project", env: {} } });
    });

    test("returns undefined for command with non-empty commandName", async () => {
        const rule = new EmptyCommandRule();
        const commandNode = new CommandAstNode("echo", {}, [], { FOO: "bar" }, "FOO=bar echo");
        const result = await rule.evaluate(commandNode, { cwd: "/project", env: {} });
        expect(result).toEqual({ context: { cwd: "/project", env: {} } });
    });

    test("returns undefined when commandName is empty and envPrefix is empty", async () => {
        const rule = new EmptyCommandRule();
        const commandNode = new CommandAstNode("", {}, [], {}, "");
        const result = await rule.evaluate(commandNode, { cwd: "/project", env: {} });
        expect(result).toEqual({ context: { cwd: "/project", env: {} } });
    });

    test("returns allow when commandName is empty with envPrefix (env-set-no-rule-allow)", async () => {
        const rule = new EmptyCommandRule();
        const commandNode = new CommandAstNode("", {}, [], { FOO: "bar" }, "FOO=bar");
        const result = await rule.evaluate(commandNode, { cwd: "/project", env: {} });
        expect(result).toEqual({
            decision: { action: "allow" },
            context: {
                cwd: "/project",
                env: { FOO: "bar" },
            },
        });
    });

    test("returns allow when commandName is empty with multiple envPrefix entries", async () => {
        const rule = new EmptyCommandRule();
        const commandNode = new CommandAstNode("", {}, [], { A: "1", B: "2" }, "A=1 B=2");
        const result = await rule.evaluate(commandNode, { cwd: "/project", env: { EXISTING: "keep" } });
        expect(result).toEqual({
            decision: { action: "allow" },
            context: {
                cwd: "/project",
                env: { EXISTING: "keep", A: "1", B: "2" },
            },
        });
    });

});
