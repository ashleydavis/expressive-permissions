import { BashAstNode, ICommand, ICommandDescriptor, IForLoop, IRedirect } from "./types";
import { resolveFlagArity } from "./load-commands";

// A single token produced by the lexer
export interface IToken {
    // Whether this is a word or an operator token
    kind: "word" | "op";
    // The resolved token value (quotes and escapes already processed for words)
    value: string;
    // Start offset in the original input string (inclusive)
    start: number;
    // End offset in the original input string (exclusive)
    end: number;
}

// Mutable cursor threaded through the recursive descent parser
interface IParserState {
    // Flat token stream produced by the lexer
    tokens: IToken[];
    // Current read position in the tokens array
    pos: number;
    // Original raw input string, kept for slicing Command.raw
    raw: string;
}

// Operator token strings, longer alternatives listed first to prevent prefix mis-matches
const OPERATORS = ["&&", "||", "2>&", ">>", "&>", "2>", "|", ";", ">", "<"];

// The subset of operators that introduce an I/O redirection (consume the next token as target)
const REDIRECT_OPS = new Set([">>", ">", "<", "2>", "&>", "2>&"]);

// Returns true when a word token value is a shell environment assignment (KEY=...)
function isEnvAssignment(value: string): boolean {
    return /^[A-Za-z_][A-Za-z0-9_]*=/.test(value);
}

// Tokenizes a raw Bash command string into a flat stream of word and operator tokens.
// Handles single/double quotes, backslash escapes, $(...) subshells, and backtick subshells.
// Whitespace between tokens is consumed and discarded.
export function lex(input: string): IToken[] {
    const tokens: IToken[] = [];
    let pos = 0;

    while (pos < input.length) {
        // Discard whitespace between tokens
        if (/\s/.test(input[pos])) {
            pos++;
            continue;
        }

        // Try operator tokens before words; check longer alternatives first
        let opMatched = false;
        for (const op of OPERATORS) {
            if (input.startsWith(op, pos)) {
                const opStart = pos;
                pos += op.length;
                tokens.push({ kind: "op", value: op, start: opStart, end: pos });
                opMatched = true;
                break;
            }
        }
        if (opMatched) {
            continue;
        }

        // Build a word token; quoted sub-sections are joined without the surrounding quotes
        const wordStart = pos;
        let wordValue = "";

        while (pos < input.length) {
            // Whitespace always ends the current word
            if (/\s/.test(input[pos])) {
                break;
            }

            // Any operator start also ends the current word
            let isOpStart = false;
            for (const op of OPERATORS) {
                if (input.startsWith(op, pos)) {
                    isOpStart = true;
                    break;
                }
            }
            if (isOpStart) {
                break;
            }

            // Single-quoted section: no escape processing inside single quotes
            if (input[pos] === "'") {
                pos++;
                while (pos < input.length && input[pos] !== "'") {
                    wordValue += input[pos++];
                }
                if (pos < input.length) {
                    pos++;
                }
                continue;
            }

            // Double-quoted section: only backslash escapes are processed
            if (input[pos] === '"') {
                pos++;
                while (pos < input.length && input[pos] !== '"') {
                    if (input[pos] === '\\' && pos + 1 < input.length) {
                        pos++;
                        wordValue += input[pos++];
                    } else {
                        wordValue += input[pos++];
                    }
                }
                if (pos < input.length) {
                    pos++;
                }
                continue;
            }

            // Backslash escape outside quotes: consume the next character literally
            if (input[pos] === '\\' && pos + 1 < input.length) {
                pos++;
                wordValue += input[pos++];
                continue;
            }

            // $(...) subshell: consume opaquely by tracking parenthesis depth
            if (input[pos] === '$' && pos + 1 < input.length && input[pos + 1] === '(') {
                let depth = 0;
                while (pos < input.length) {
                    if (input[pos] === '(') {
                        depth++;
                    } else if (input[pos] === ')') {
                        depth--;
                        if (depth === 0) {
                            wordValue += input[pos++];
                            break;
                        }
                    }
                    wordValue += input[pos++];
                }
                continue;
            }

            // Backtick subshell: consume opaquely until the closing backtick
            if (input[pos] === '`') {
                wordValue += input[pos++];
                while (pos < input.length && input[pos] !== '`') {
                    wordValue += input[pos++];
                }
                if (pos < input.length) {
                    wordValue += input[pos++];
                }
                continue;
            }

            // Regular character
            wordValue += input[pos++];
        }

        if (wordValue.length > 0) {
            tokens.push({ kind: "word", value: wordValue, start: wordStart, end: pos });
        }
    }

    return tokens;
}

// Result produced by the inline argv parser
interface IArgvResult {
    // Named options: boolean for standalone flags, string for value flags
    options: Record<string, string | boolean>;
    // Positional (non-flag) tokens: string when exactly one, array otherwise
    cmd: string | string[];
}

// An empty command descriptor used as the default when no descriptor is available.
// All flags default to arity 0 (boolean) and no positionals are declared.
const EMPTY_DESCRIPTOR: ICommandDescriptor = {
    description: "",
    positionals: [],
    flags: {},
};

// Converts a flat array of argument token strings into an IArgvResult using the supplied
// command descriptor to resolve flag arity.
// Flags absent from the descriptor default to arity 0 (boolean).
// One positional → cmd is a string; otherwise cmd is a string[].
function parseArgv(argTokens: string[], descriptor: ICommandDescriptor): IArgvResult {
    const options: Record<string, string | boolean> = {};
    const positionals: string[] = [];
    let index = 0;

    while (index < argTokens.length) {
        const token = argTokens[index];
        if (token.startsWith("--")) {
            const rest = token.substring(2);
            const eqIdx = rest.indexOf("=");
            if (eqIdx !== -1) {
                options[rest.substring(0, eqIdx)] = rest.substring(eqIdx + 1);
            }
            else {
                const flagArity = resolveFlagArity(descriptor, rest);
                if (flagArity === 1) {
                    const next = argTokens[index + 1];
                    if (next !== undefined) {
                        options[rest] = next;
                        index++;
                    }
                    else {
                        options[rest] = true;
                    }
                }
                else {
                    options[rest] = true;
                }
            }
        }
        else if (token.startsWith("-") && token.length > 1) {
            const rest = token.substring(1);
            const eqIdx = rest.indexOf("=");
            if (eqIdx !== -1) {
                options[rest.substring(0, eqIdx)] = rest.substring(eqIdx + 1);
            }
            else if (rest.length === 1) {
                const flagArity = resolveFlagArity(descriptor, rest);
                if (flagArity === 1) {
                    const next = argTokens[index + 1];
                    if (next !== undefined) {
                        options[rest] = next;
                        index++;
                    }
                    else {
                        options[rest] = true;
                    }
                }
                else {
                    options[rest] = true;
                }
            }
            else {
                for (const ch of rest) {
                    options[ch] = true;
                }
            }
        }
        else {
            positionals.push(token);
        }
        index++;
    }

    const cmd: string | string[] = positionals.length === 1 ? positionals[0] : positionals;
    return { options, cmd };
}

// Returns the token at the current cursor position without advancing.
function peek(state: IParserState): IToken | null {
    if (state.pos >= state.tokens.length) {
        return null;
    }
    return state.tokens[state.pos];
}

// Returns and advances past the token at the current cursor position.
function consume(state: IParserState): IToken {
    return state.tokens[state.pos++];
}

// Parses a single Command leaf, collecting the env-var prefix, binary, options, and redirects.
// Stops when a non-redirect operator is seen (caller handles that operator).
// descriptors is used to look up flag arity and positional kinds for the parsed binary.
function parseCommand(state: IParserState, descriptors: Map<string, ICommandDescriptor>): ICommand {
    const envPrefix: Record<string, string> = {};
    const redirects: IRedirect[] = [];
    const argTokens: string[] = [];
    let binary = "";
    let firstTokenStart = -1;
    let lastTokenEnd = -1;

    function trackToken(token: IToken): void {
        if (firstTokenStart === -1) {
            firstTokenStart = token.start;
        }
        lastTokenEnd = token.end;
    }

    // Collect leading KEY=VALUE env-var assignments into envPrefix
    while (peek(state)?.kind === "word" && isEnvAssignment(peek(state)!.value)) {
        const token = consume(state);
        trackToken(token);
        const eqIdx = token.value.indexOf("=");
        envPrefix[token.value.substring(0, eqIdx)] = token.value.substring(eqIdx + 1);
    }

    // The next word token is the binary
    if (peek(state)?.kind === "word") {
        const token = consume(state);
        trackToken(token);
        binary = token.value;
    }

    // Collect remaining args and redirects until a non-redirect binary operator
    while (peek(state) !== null) {
        const current = peek(state)!;

        if (current.kind === "op") {
            if (REDIRECT_OPS.has(current.value)) {
                const opToken = consume(state);
                trackToken(opToken);
                if (peek(state)?.kind === "word") {
                    const targetToken = consume(state);
                    trackToken(targetToken);
                    redirects.push({ op: opToken.value, target: targetToken.value });
                }
            } else {
                break;
            }
        } else {
            const argToken = consume(state);
            trackToken(argToken);
            argTokens.push(argToken.value);
        }
    }

    const raw = firstTokenStart !== -1
        ? state.raw.substring(firstTokenStart, lastTokenEnd)
        : "";

    const descriptor = descriptors.get(binary) ?? EMPTY_DESCRIPTOR;
    const argv = parseArgv(argTokens, descriptor);
    return {
        type: "command",
        binary,
        options: argv.options,
        cmd: argv.cmd,
        envPrefix,
        redirects,
        raw,
    };
}

// parseStatement: dispatches between parseForLoop and parseCommand based on the leading word.
// A leading word "for" introduces a for-loop; anything else is a single command leaf.
function parseStatement(state: IParserState, descriptors: Map<string, ICommandDescriptor>): BashAstNode {
    const next = peek(state);
    if (next !== null && next.kind === "word" && next.value === "for") {
        return parseForLoop(state, descriptors);
    }
    return parseCommand(state, descriptors);
}

// parseForLoop: parses `for VAR [in ITEMS] ; do BODY ; done` into a ForLoop node.
// The body is parsed via parseSequenceUntilDone so that nested operators (|, &&, ||, ;)
// inside the body still build a normal sub-tree.
function parseForLoop(state: IParserState, descriptors: Map<string, ICommandDescriptor>): BashAstNode {
    const forToken = consume(state);
    const startPos = forToken.start;

    if (peek(state) === null || peek(state)!.kind !== "word") {
        return {
            type: "for_loop",
            variable: "",
            items: [],
            body: { type: "command", binary: "", options: {}, cmd: [], envPrefix: {}, redirects: [], raw: "" },
            raw: state.raw.substring(startPos, forToken.end),
        };
    }
    const variable = consume(state).value;

    if (peek(state)?.value === "in") {
        consume(state);
    }

    const items: string[] = [];
    while (peek(state) !== null && peek(state)!.kind === "word" && peek(state)!.value !== "do") {
        items.push(consume(state).value);
    }

    if (peek(state)?.value === ";") {
        consume(state);
    }

    if (peek(state)?.value !== "do") {
        return {
            type: "for_loop",
            variable,
            items,
            body: { type: "command", binary: "", options: {}, cmd: [], envPrefix: {}, redirects: [], raw: "" },
            raw: state.raw.substring(startPos, peek(state)?.start ?? state.raw.length),
        };
    }
    consume(state);

    const body = parseSequenceUntilDone(state, descriptors);

    if (peek(state)?.value !== "done") {
        return {
            type: "for_loop",
            variable,
            items,
            body,
            raw: state.raw.substring(startPos, state.raw.length),
        };
    }
    const doneToken = consume(state);

    const forLoop: IForLoop = {
        type: "for_loop",
        variable,
        items,
        body,
        raw: state.raw.substring(startPos, doneToken.end),
    };
    return forLoop;
}

// parseSequenceUntilDone: parses a `;`-separated sequence of statements until the next
// non-`;` token is the literal word "done", which the caller (parseForLoop) consumes.
function parseSequenceUntilDone(state: IParserState, descriptors: Map<string, ICommandDescriptor>): BashAstNode {
    let left: BashAstNode = parseAnd(state, descriptors);
    while (peek(state)?.value === ";") {
        consume(state);
        if (peek(state) === null || peek(state)!.value === "done") {
            break;
        }
        const right = parseAnd(state, descriptors);
        left = { type: "binop", op: ";", left, right };
    }
    return left;
}

// parsePipe: parseStatement ('|' parseStatement)*  — highest operator precedence
function parsePipe(state: IParserState, descriptors: Map<string, ICommandDescriptor>): BashAstNode {
    let left: BashAstNode = parseStatement(state, descriptors);
    while (peek(state)?.value === "|") {
        consume(state);
        const right = parseStatement(state, descriptors);
        left = { type: "binop", op: "|", left, right };
    }
    return left;
}

// parseOr: parsePipe ('||' parsePipe)*
function parseOr(state: IParserState, descriptors: Map<string, ICommandDescriptor>): BashAstNode {
    let left: BashAstNode = parsePipe(state, descriptors);
    while (peek(state)?.value === "||") {
        consume(state);
        const right = parsePipe(state, descriptors);
        left = { type: "binop", op: "||", left, right };
    }
    return left;
}

// parseAnd: parseOr ('&&' parseOr)*
function parseAnd(state: IParserState, descriptors: Map<string, ICommandDescriptor>): BashAstNode {
    let left: BashAstNode = parseOr(state, descriptors);
    while (peek(state)?.value === "&&") {
        consume(state);
        const right = parseOr(state, descriptors);
        left = { type: "binop", op: "&&", left, right };
    }
    return left;
}

// parseSequence: parseAnd (';' parseAnd)*  — lowest operator precedence
function parseSequence(state: IParserState, descriptors: Map<string, ICommandDescriptor>): BashAstNode {
    let left: BashAstNode = parseAnd(state, descriptors);
    while (peek(state)?.value === ";") {
        consume(state);
        // Trailing semicolons produce no extra leaf
        if (state.pos >= state.tokens.length) {
            break;
        }
        const right = parseAnd(state, descriptors);
        left = { type: "binop", op: ";", left, right };
    }
    return left;
}

// parseBash: entry point that converts a raw Bash command string into a BashAstNode.
// descriptors is used to resolve flag arity and positional kinds for each command.
// Empty or whitespace-only input returns a Command with binary: "" and all collections empty.
export function parseBash(raw: string, descriptors: Map<string, ICommandDescriptor>): BashAstNode {
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
        return { type: "command", binary: "", options: {}, cmd: [], envPrefix: {}, redirects: [], raw: "" };
    }

    const tokens = lex(raw);
    const state: IParserState = { tokens, pos: 0, raw };
    return parseSequence(state, descriptors);
}
