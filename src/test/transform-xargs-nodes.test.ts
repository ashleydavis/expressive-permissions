import { transformXargsNodes } from "../build-ast";
import { BashAstNode, ICommand, IBinOp, IForLoop, IXargsNode } from "../types";

// makeCommand builds a minimal ICommand node.
function makeCommand(binary: string): ICommand {
    return { type: "command", binary, options: {}, cmd: [], envPrefix: {}, redirects: [], raw: binary };
}

// makeXargsCommand builds a minimal ICommand node with binary "xargs" and a raw string.
function makeXargsCommand(raw: string): ICommand {
    return { type: "command", binary: "xargs", options: {}, cmd: [], envPrefix: {}, redirects: [], raw };
}

// ---------------------------------------------------------------------------
// Non-xargs Command nodes are returned unchanged
// ---------------------------------------------------------------------------

test("non-xargs command is returned unchanged", () => {
    const node = makeCommand("ls");
    const result = transformXargsNodes(node);
    expect(result).toBe(node);
});

test("grep command is returned unchanged", () => {
    const node = makeCommand("grep");
    const result = transformXargsNodes(node);
    expect(result.type).toBe("command");
    if (result.type === "command") {
        expect(result.binary).toBe("grep");
    }
});

// ---------------------------------------------------------------------------
// xargs Command nodes are transformed to IXargsNode
// ---------------------------------------------------------------------------

test("xargs command becomes IXargsNode", () => {
    const node = makeXargsCommand("xargs grep");
    const result = transformXargsNodes(node);
    expect(result.type).toBe("xargs");
});

test("transformed IXargsNode preserves raw from original command", () => {
    const node = makeXargsCommand("xargs grep -l pattern");
    const result = transformXargsNodes(node) as IXargsNode;
    expect(result.raw).toBe("xargs grep -l pattern");
});

test("transformed IXargsNode child has correct binary", () => {
    const node = makeXargsCommand("xargs rm -f");
    const result = transformXargsNodes(node) as IXargsNode;
    expect(result.child.binary).toBe("rm");
});

test("bare xargs command produces IXargsNode with empty child binary", () => {
    const node = makeXargsCommand("xargs");
    const result = transformXargsNodes(node) as IXargsNode;
    expect(result.type).toBe("xargs");
    expect(result.child.binary).toBe("");
});

// ---------------------------------------------------------------------------
// BinOp children are recursively transformed
// ---------------------------------------------------------------------------

test("BinOp with xargs right child: right becomes IXargsNode", () => {
    const binop: IBinOp = {
        type: "binop",
        op: "|",
        left: makeCommand("find"),
        right: makeXargsCommand("xargs rm"),
    };
    const result = transformXargsNodes(binop) as IBinOp;
    expect(result.type).toBe("binop");
    expect(result.right.type).toBe("xargs");
    expect(result.left.type).toBe("command");
});

test("BinOp with non-xargs children: returned with same structure", () => {
    const binop: IBinOp = {
        type: "binop",
        op: "&&",
        left: makeCommand("ls"),
        right: makeCommand("echo"),
    };
    const result = transformXargsNodes(binop) as IBinOp;
    expect(result.type).toBe("binop");
    expect(result.left.type).toBe("command");
    expect(result.right.type).toBe("command");
});

test("BinOp with xargs on both sides: both become IXargsNode", () => {
    const binop: IBinOp = {
        type: "binop",
        op: ";",
        left: makeXargsCommand("xargs grep"),
        right: makeXargsCommand("xargs rm"),
    };
    const result = transformXargsNodes(binop) as IBinOp;
    expect(result.left.type).toBe("xargs");
    expect(result.right.type).toBe("xargs");
});

// ---------------------------------------------------------------------------
// ForLoop body is recursively transformed
// ---------------------------------------------------------------------------

test("ForLoop with xargs body: body becomes IXargsNode", () => {
    const forLoop: IForLoop = {
        type: "for_loop",
        variable: "f",
        items: ["a", "b"],
        body: makeXargsCommand("xargs rm"),
        raw: "for f in a b ; do xargs rm ; done",
    };
    const result = transformXargsNodes(forLoop) as IForLoop;
    expect(result.type).toBe("for_loop");
    expect(result.body.type).toBe("xargs");
});

test("ForLoop with non-xargs body: body unchanged", () => {
    const forLoop: IForLoop = {
        type: "for_loop",
        variable: "f",
        items: ["a"],
        body: makeCommand("echo"),
        raw: "for f in a ; do echo ; done",
    };
    const result = transformXargsNodes(forLoop) as IForLoop;
    expect(result.body.type).toBe("command");
    if (result.body.type === "command") {
        expect(result.body.binary).toBe("echo");
    }
});

// ---------------------------------------------------------------------------
// Already-transformed IXargsNode is returned unchanged
// ---------------------------------------------------------------------------

test("IXargsNode passed in is returned unchanged", () => {
    const xargsNode: IXargsNode = {
        type: "xargs",
        options: {},
        child: makeCommand("grep"),
        raw: "xargs grep",
    };
    const result = transformXargsNodes(xargsNode);
    expect(result).toBe(xargsNode);
});
