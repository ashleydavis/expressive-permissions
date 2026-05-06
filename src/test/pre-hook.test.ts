import { readStdin, runHook } from "../pre-hook";

// An async iterable that yields a single Buffer chunk, used to mock process.stdin.
interface IMockStdin {
    // Returns an async iterator that emits the mock content.
    [Symbol.asyncIterator](): AsyncGenerator<Buffer>;
}

// createMockStdin builds a mock stdin that yields the given string as a single UTF-8 Buffer.
function createMockStdin(content: string): IMockStdin {
    const buffer = Buffer.from(content, "utf-8");
    return {
        async *[Symbol.asyncIterator]() {
            if (buffer.length > 0) {
                yield buffer;
            }
        },
    };
}

// setStdin replaces process.stdin with the given mock async iterable.
function setStdin(mock: IMockStdin): void {
    Object.defineProperty(process, "stdin", {
        value: mock,
        writable: true,
        configurable: true,
    });
}

describe("readStdin", () => {
    test("returns content as a UTF-8 string", async () => {
        setStdin(createMockStdin("hello world"));
        const result = await readStdin();
        expect(result).toBe("hello world");
    });

    test("returns empty string when stdin has no content", async () => {
        setStdin(createMockStdin(""));
        const result = await readStdin();
        expect(result).toBe("");
    });

    test("concatenates multiple chunks into a single UTF-8 string", async () => {
        const mock: IMockStdin = {
            async *[Symbol.asyncIterator]() {
                yield Buffer.from("hello ", "utf-8");
                yield Buffer.from("world", "utf-8");
            },
        };
        setStdin(mock);
        const result = await readStdin();
        expect(result).toBe("hello world");
    });
});

describe("runHook", () => {
    let exitSpy: jest.SpyInstance;
    let stderrSpy: jest.SpyInstance;
    let stdoutSpy: jest.SpyInstance;
    let originalProjectDir: string | undefined;

    beforeEach(() => {
        exitSpy = jest.spyOn(process, "exit").mockImplementation(jest.fn() as any);
        stderrSpy = jest.spyOn(process.stderr, "write").mockImplementation(() => true);
        stdoutSpy = jest.spyOn(process.stdout, "write").mockImplementation(() => true);
        originalProjectDir = process.env["CLAUDE_PROJECT_DIR"];
        process.env["CLAUDE_PROJECT_DIR"] = require("os").tmpdir();
    });

    afterEach(() => {
        exitSpy.mockRestore();
        stderrSpy.mockRestore();
        stdoutSpy.mockRestore();
        if (originalProjectDir === undefined) {
            delete process.env["CLAUDE_PROJECT_DIR"];
        }
        else {
            process.env["CLAUDE_PROJECT_DIR"] = originalProjectDir;
        }
    });

    test("malformed JSON writes to stderr and exits with code 1", async () => {
        setStdin(createMockStdin("not valid json"));
        await runHook();
        expect(stderrSpy).toHaveBeenCalled();
        expect(exitSpy).toHaveBeenCalledWith(1);
    });

    test("empty input writes to stderr and exits with code 1", async () => {
        setStdin(createMockStdin(""));
        await runHook();
        expect(stderrSpy).toHaveBeenCalled();
        expect(exitSpy).toHaveBeenCalledWith(1);
    });

    test("valid ToolCall writes hookSpecificOutput to stdout and exits with code 0", async () => {
        const toolCall = JSON.stringify({
            tool_name: "Read",
            tool_input: { file_path: "/test.txt" },
            cwd: "/home/user",
        });
        setStdin(createMockStdin(toolCall));
        await runHook();
        expect(stdoutSpy).toHaveBeenCalled();
        const written = stdoutSpy.mock.calls[0][0] as string;
        const parsed = JSON.parse(written) as { hookSpecificOutput: { hookEventName: string; permissionDecision: string } };
        expect(parsed.hookSpecificOutput.hookEventName).toBe("PreToolUse");
        expect(["allow", "deny", "ask"]).toContain(parsed.hookSpecificOutput.permissionDecision);
        expect(exitSpy).toHaveBeenCalledWith(0);
    });
});
