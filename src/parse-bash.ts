import { BashAstNode, Command, IRedirect } from "./types";

// A single token produced by the lexer
interface IToken {
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
const OPERATORS = ["&&", "||", ">>", "2>", "&>", "|", ";", ">", "<"];

// The subset of operators that introduce an I/O redirection (consume the next token as target)
const REDIRECT_OPS = new Set([">>", ">", "<", "2>", "&>"]);

// Returns true when a word token value is a shell environment assignment (KEY=...)
function isEnvAssignment(value: string): boolean {
    return /^[A-Za-z_][A-Za-z0-9_]*=/.test(value);
}

// Tokenizes a raw Bash command string into a flat stream of word and operator tokens.
// Handles single/double quotes, backslash escapes, $(...) subshells, and backtick subshells.
// Whitespace between tokens is consumed and discarded.
function lex(input: string): IToken[] {
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
    // Named arguments: boolean for standalone flags, string for value flags
    args: Record<string, string | boolean>;
    // Positional (non-flag) tokens: string when exactly one, array otherwise
    pos: string | string[];
}

// Converts a flat array of argument token strings into an IArgvResult.
// Rules: --flag → boolean, --flag=val → string, -abc → three booleans,
// -f=val → string, anything else → positional. One positional → string; otherwise → string[].
function parseArgv(argTokens: string[]): IArgvResult {
    const args: Record<string, string | boolean> = {};
    const positionals: string[] = [];

    for (const token of argTokens) {
        if (token.startsWith("--")) {
            const rest = token.substring(2);
            const eqIdx = rest.indexOf("=");
            if (eqIdx !== -1) {
                args[rest.substring(0, eqIdx)] = rest.substring(eqIdx + 1);
            } else {
                args[rest] = true;
            }
        } else if (token.startsWith("-") && token.length > 1) {
            const rest = token.substring(1);
            const eqIdx = rest.indexOf("=");
            if (eqIdx !== -1) {
                args[rest.substring(0, eqIdx)] = rest.substring(eqIdx + 1);
            } else {
                for (const ch of rest) {
                    args[ch] = true;
                }
            }
        } else {
            positionals.push(token);
        }
    }

    const pos: string | string[] = positionals.length === 1 ? positionals[0] : positionals;
    return { args, pos };
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

// Parses a single Command leaf, collecting the env-var prefix, binary, args, and redirects.
// Stops when a non-redirect operator is seen (caller handles that operator).
function parseCommand(state: IParserState): Command {
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

    const argv = parseArgv(argTokens);
    return {
        type: "command",
        binary,
        args: argv.args,

        pos: argv.pos,
        envPrefix,
        redirects,
        raw,
    };
}

// parsePipe: parseCommand ('|' parseCommand)*  — highest operator precedence
function parsePipe(state: IParserState): BashAstNode {
    let left: BashAstNode = parseCommand(state);
    while (peek(state)?.value === "|") {
        consume(state);
        const right = parseCommand(state);
        left = { type: "binop", op: "|", left, right };
    }
    return left;
}

// parseOr: parsePipe ('||' parsePipe)*
function parseOr(state: IParserState): BashAstNode {
    let left: BashAstNode = parsePipe(state);
    while (peek(state)?.value === "||") {
        consume(state);
        const right = parsePipe(state);
        left = { type: "binop", op: "||", left, right };
    }
    return left;
}

// parseAnd: parseOr ('&&' parseOr)*
function parseAnd(state: IParserState): BashAstNode {
    let left: BashAstNode = parseOr(state);
    while (peek(state)?.value === "&&") {
        consume(state);
        const right = parseOr(state);
        left = { type: "binop", op: "&&", left, right };
    }
    return left;
}

// parseSequence: parseAnd (';' parseAnd)*  — lowest operator precedence
function parseSequence(state: IParserState): BashAstNode {
    let left: BashAstNode = parseAnd(state);
    while (peek(state)?.value === ";") {
        consume(state);
        // Trailing semicolons produce no extra leaf
        if (state.pos >= state.tokens.length) {
            break;
        }
        const right = parseAnd(state);
        left = { type: "binop", op: ";", left, right };
    }
    return left;
}

// parseBash: entry point that converts a raw Bash command string into a BashAstNode.
// Empty or whitespace-only input returns a Command with binary: "" and all collections empty.
export function parseBash(raw: string): BashAstNode {
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
        return { type: "command", binary: "", args: {}, pos: [], envPrefix: {}, redirects: [], raw: "" };
    }

    const tokens = lex(raw);
    const state: IParserState = { tokens, pos: 0, raw };
    return parseSequence(state);
}
