import { CdRule } from "../../../rules/builtin/cd-rule";
import { CommandAstNode } from "../../../ast-nodes/command-ast-node";
import { FilePathToolAstNode } from "../../../ast-nodes/file-path-tool-ast-node";

describe("CdRule", () => {

    test("returns unchanged context for non-command node", async () => {
        const rule = new CdRule();
        const readNode = new FilePathToolAstNode("read", "/etc/hosts", "read /etc/hosts");
        const result = await rule.evaluate(readNode, { cwd: "/project", env: {} });
        expect(result).toEqual({ context: { cwd: "/project", env: {} } });
    });

    test("returns unchanged context for non-cd command", async () => {
        const rule = new CdRule();
        const commandNode = new CommandAstNode("ls", {}, ["/tmp"], {}, "ls /tmp");
        const result = await rule.evaluate(commandNode, { cwd: "/project", env: {} });
        expect(result).toEqual({ context: { cwd: "/project", env: {} } });
    });

    test("returns unchanged context when cd has no target", async () => {
        const rule = new CdRule();
        const commandNode = new CommandAstNode("cd", {}, [], {}, "cd");
        const result = await rule.evaluate(commandNode, { cwd: "/project", env: {} });
        expect(result).toEqual({ context: { cwd: "/project", env: {} } });
    });

    test("updates cwd from relative cd target", async () => {
        const rule = new CdRule();
        const commandNode = new CommandAstNode("cd", {}, ["subdir"], {}, "cd subdir");
        const result = await rule.evaluate(commandNode, { cwd: "/project", env: {} });
        expect(result).toEqual({
            context: {
                cwd: "/project/subdir",
                env: {},
            },
        });
    });

    test("sets cwdResolved false for unexpanded variable target (bash-cwd-when-unresolved-ask)", async () => {
        const rule = new CdRule();
        const commandNode = new CommandAstNode("cd", {}, ["$UNKNOWN"], {}, "cd $UNKNOWN");
        const result = await rule.evaluate(commandNode, { cwd: "/home/user/project", env: {} });
        expect(result).toEqual({
            context: {
                cwd: "/home/user/project",
                cwdResolved: false,
                env: {},
            },
        });
    });

    test("updates cwd from absolute cd target (cd-cwd-update)", async () => {
        const rule = new CdRule();
        const commandNode = new CommandAstNode("cd", {}, ["/tmp"], {}, "cd /tmp");
        const result = await rule.evaluate(commandNode, { cwd: "/home/user/project", env: {} });
        expect(result).toEqual({
            context: {
                cwd: "/tmp",
                env: {},
            },
        });
    });

});
