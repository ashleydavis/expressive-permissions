import { buildAst } from "../build-ast";
import { IBash, IBinOp, IXargsNode, IToolCall, findInnerCommand, IRedirectNode } from "../types";

// makeBashCall builds a minimal IToolCall for a Bash command string.
function makeBashCall(command: string): IToolCall {
    return { tool_name: "Bash", tool_input: { command }, cwd: "/start" };
}

// getAst is a helper that builds the AST for a Bash tool call and returns the IBash node's ast.
function getAst(command: string): IBash["ast"] {
    const root = buildAst(makeBashCall(command), new Map()) as IBash;
    return root.ast;
}

// ---------------------------------------------------------------------------
// Basic xargs transformation
// ---------------------------------------------------------------------------

test('xargs grep -l "pattern": top-level node is IXargsNode with child.binary grep', () => {
    const ast = getAst('xargs grep -l "pattern"');
    expect(ast.type).toBe("xargs");
    const xargsNode = ast as IXargsNode;
    expect(findInnerCommand(xargsNode.child).binary).toBe("grep");
});

test('xargs -n 1 rm: IXargsNode with child.binary rm and options.n === "1"', () => {
    const ast = getAst("xargs -n 1 rm");
    expect(ast.type).toBe("xargs");
    const xargsNode = ast as IXargsNode;
    expect(findInnerCommand(xargsNode.child).binary).toBe("rm");
    expect(xargsNode.options["n"]).toBe("1");
});

test('xargs -I{} cp {} /dest: IXargsNode with child.binary cp and options.I === "{}"', () => {
    const ast = getAst("xargs -I{} cp {} /dest");
    expect(ast.type).toBe("xargs");
    const xargsNode = ast as IXargsNode;
    expect(findInnerCommand(xargsNode.child).binary).toBe("cp");
    expect(xargsNode.options["I"]).toBe("{}");
});

test("xargs (no subcommand): IXargsNode with child.binary empty string", () => {
    const ast = getAst("xargs");
    expect(ast.type).toBe("xargs");
    const xargsNode = ast as IXargsNode;
    expect(findInnerCommand(xargsNode.child).binary).toBe("");
});

// ---------------------------------------------------------------------------
// Pipe combinations
// ---------------------------------------------------------------------------

test('find . | xargs rm: BinOp with right being IXargsNode with child.binary rm', () => {
    const ast = getAst("find . | xargs rm");
    expect(ast.type).toBe("binop");
    const binop = ast as IBinOp;
    expect(binop.op).toBe("|");
    expect(binop.right.type).toBe("xargs");
    const rightXargs = binop.right as IXargsNode;
    expect(findInnerCommand(rightXargs.child).binary).toBe("rm");
});

test('ls && xargs rm: BinOp with right being IXargsNode', () => {
    const ast = getAst("ls && xargs rm");
    expect(ast.type).toBe("binop");
    const binop = ast as IBinOp;
    expect(binop.op).toBe("&&");
    expect(binop.right.type).toBe("xargs");
    const rightXargs = binop.right as IXargsNode;
    expect(findInnerCommand(rightXargs.child).binary).toBe("rm");
});

// ---------------------------------------------------------------------------
// Complex pattern with redirect
// ---------------------------------------------------------------------------

test('xargs grep -l "pattern..." 2>/dev/null: redirect wraps xargs, grep is inner child', () => {
    const ast = getAst('xargs grep -l "loadDesktopConfig\\|saveDesktopConfig\\|desktopConfig" 2>/dev/null');
    expect(ast.type).toBe("redirect");
    const outerRedirect = ast as IRedirectNode;
    expect(outerRedirect.op).toBe("2>");
    expect(outerRedirect.target).toBe("/dev/null");
    expect(outerRedirect.command.type).toBe("xargs");
    const xargsNode = outerRedirect.command as IXargsNode;
    const innerCmd = findInnerCommand(xargsNode.child);
    expect(innerCmd.binary).toBe("grep");
    expect(innerCmd.options["l"]).toBeDefined();
});

// ---------------------------------------------------------------------------
// Non-xargs commands are unchanged
// ---------------------------------------------------------------------------

test("ls -la: Command node with binary ls, not transformed", () => {
    const ast = getAst("ls -la");
    expect(ast.type).toBe("command");
    if (ast.type === "command") {
        expect(ast.binary).toBe("ls");
    }
});

// ---------------------------------------------------------------------------
// raw field preservation
// ---------------------------------------------------------------------------

test("IXargsNode.raw equals the full original xargs command string", () => {
    const command = "xargs -n 1 grep -l pattern";
    const ast = getAst(command);
    expect(ast.type).toBe("xargs");
    const xargsNode = ast as IXargsNode;
    expect(xargsNode.raw).toBe(command);
});

test("find . | xargs grep: left Command binary is find", () => {
    const ast = getAst("find . | xargs grep");
    expect(ast.type).toBe("binop");
    const binop = ast as IBinOp;
    expect(binop.left.type).toBe("command");
    if (binop.left.type === "command") {
        expect(binop.left.binary).toBe("find");
    }
});
