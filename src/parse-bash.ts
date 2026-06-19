import { BashAstNode, ICaseClause, ICaseStatement, ICommand, ICommandDescriptor, IForLoop, IGroup, IIfStatement, IRedirect, IWhileLoop } from "./types";
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

// Operator token strings, longer alternatives listed first to prevent prefix mis-matches.
// "(" / ")" delimit subshell groups, ";;" terminates a case clause, and bare "&" is a statement
// separator (normalised to ";" by the lexer, see below).
const OPERATORS = ["&&", "||", "2>&", ";;", ">>", "&>", "2>", "|", ";", ">", "<", "(", ")", "&"];

// The subset of operators that introduce an I/O redirection (consume the next token as target)
const REDIRECT_OPS = new Set([">>", ">", "<", "2>", "&>", "2>&"]);

// Block keyword that terminates a for-loop body sequence (`do ... done`)
const DONE_TERMINATOR = new Set(["done"]);

// Block keyword that terminates an if/elif condition sequence (`if COND ; then ...`)
const THEN_TERMINATOR = new Set(["then"]);

// Block keywords that terminate an if/elif then-branch sequence (continuation or close)
const IF_BODY_TERMINATORS = new Set(["elif", "else", "fi"]);

// Block keyword that terminates an else-branch sequence (`else ... fi`)
const FI_TERMINATOR = new Set(["fi"]);

// Block keyword that terminates a while/until condition sequence (`while COND ; do ...`)
const DO_TERMINATOR = new Set(["do"]);

// Token that terminates a subshell group body (`( ... )`)
const CLOSE_PAREN_TERMINATOR = new Set([")"]);

// Token that terminates a brace group body (`{ ...; }`)
const CLOSE_BRACE_TERMINATOR = new Set(["}"]);

// Tokens that terminate a case clause body (`;;` between clauses, `esac` to close the statement)
const CASE_CLAUSE_TERMINATORS = new Set([";;", "esac"]);

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
        // A newline acts as a statement separator, normalised to ";" so the parser treats it
        // identically to an explicit semicolon. Runs of separators are collapsed later.
        if (input[pos] === "\n" || input[pos] === "\r") {
            const sepStart = pos;
            pos++;
            tokens.push({ kind: "op", value: ";", start: sepStart, end: pos });
            continue;
        }

        // Discard other whitespace between tokens
        if (/\s/.test(input[pos])) {
            pos++;
            continue;
        }

        // A "#" at the start of a token begins a comment that runs to the end of the line.
        // Bash only treats "#" as a comment opener at a word boundary, and we are exactly at
        // such a boundary here (a newline, whitespace, or operator was just consumed), so the
        // rest of the line is discarded and never reaches the token stream or the AST. The
        // terminating newline is left in place so it still becomes a ";" separator next iteration.
        // A "#" in the middle of a word (e.g. "foo#bar") is handled by the word loop below and
        // is kept literally, matching Bash.
        if (input[pos] === "#") {
            while (pos < input.length && input[pos] !== "\n" && input[pos] !== "\r") {
                pos++;
            }
            continue;
        }

        // Try operator tokens before words; check longer alternatives first. A bare "&"
        // backgrounds the preceding command but, for permission analysis, behaves like a
        // statement separator, so it is normalised to ";".
        let opMatched = false;
        for (const op of OPERATORS) {
            if (input.startsWith(op, pos)) {
                const opStart = pos;
                pos += op.length;
                const value = op === "&" ? ";" : op;
                tokens.push({ kind: "op", value, start: opStart, end: pos });
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

// Scans argTokens to find the first positional argument (the sub-command candidate).
// Uses descriptor to correctly skip over value-consuming flags so they are not mistaken
// for positionals. Returns null if no positional token is found.
function findSubCommandName(argTokens: string[], descriptor: ICommandDescriptor): string | null {
    let index = 0;
    while (index < argTokens.length) {
        const token = argTokens[index];
        if (token.startsWith("--")) {
            const rest = token.substring(2);
            const eqIdx = rest.indexOf("=");
            if (eqIdx !== -1) {
                index++;
                continue;
            }
            const flagArity = resolveFlagArity(descriptor, rest);
            if (flagArity === 1) {
                index += 2;
            }
            else {
                index++;
            }
        }
        else if (token.startsWith("-") && token.length > 1) {
            const rest = token.substring(1);
            const eqIdx = rest.indexOf("=");
            if (eqIdx !== -1) {
                index++;
                continue;
            }
            if (rest.length === 1) {
                const flagArity = resolveFlagArity(descriptor, rest);
                if (flagArity === 1) {
                    index += 2;
                }
                else {
                    index++;
                }
            }
            else {
                index++;
            }
        }
        else {
            return token;
        }
    }
    return null;
}

// Returns a merged ICommandDescriptor combining top-level flags with the matching sub-command's
// flags. Sub-command flags take precedence over top-level flags on alias-group conflicts.
// Returns descriptor unchanged when cmds is absent or subCommandName is not found.
function mergeSubCommandDescriptor(descriptor: ICommandDescriptor, subCommandName: string): ICommandDescriptor {
    if (descriptor.cmds === undefined) {
        return descriptor;
    }
    const subDescriptor = descriptor.cmds[subCommandName];
    if (subDescriptor === undefined) {
        return descriptor;
    }
    return {
        ...descriptor,
        flags: { ...descriptor.flags, ...subDescriptor.flags },
    };
}

// Converts a flat array of argument token strings into an IArgvResult using the supplied
// command descriptor to resolve flag arity.
// When the descriptor has sub-commands (cmds), the first positional is used to look up the
// matching sub-command and its flags are merged with the top-level flags before parsing.
// Flags absent from the effective descriptor default to arity 0 (boolean).
// One positional → cmd is a string; otherwise cmd is a string[].
function parseArgv(argTokens: string[], descriptor: ICommandDescriptor): IArgvResult {
    const subCommandName = findSubCommandName(argTokens, descriptor);
    const effectiveDescriptor = subCommandName !== null
        ? mergeSubCommandDescriptor(descriptor, subCommandName)
        : descriptor;
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
                const flagArity = resolveFlagArity(effectiveDescriptor, rest);
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
                const flagArity = resolveFlagArity(effectiveDescriptor, rest);
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

    // Collect any embedded command substitutions from every textual piece of the command, so the
    // inner commands are evaluated for permissions rather than treated as opaque text.
    const substitutionSources = [binary, ...argTokens, ...redirects.map((redirect) => redirect.target), ...Object.values(envPrefix)];
    const substitutions: BashAstNode[] = [];
    for (const source of substitutionSources) {
        for (const inner of extractSubstitutions(source)) {
            substitutions.push(parseBash(inner, descriptors));
        }
    }

    const command: ICommand = {
        type: "command",
        binary,
        options: argv.options,
        cmd: argv.cmd,
        envPrefix,
        redirects,
        raw,
    };
    if (substitutions.length > 0) {
        command.substitutions = substitutions;
    }
    return command;
}

// extractSubstitutions scans a single text fragment and returns the inner command string of each
// command substitution it contains: `$(...)` (paren-balanced) and backtick `` `...` ``. Arithmetic
// expansions `$(( ... ))` are skipped, as they contain an expression rather than a command.
function extractSubstitutions(text: string): string[] {
    const results: string[] = [];
    let pos = 0;

    while (pos < text.length) {
        if (text[pos] === "$" && text[pos + 1] === "(") {
            // Skip arithmetic expansion $(( ... )), which is not a command
            if (text[pos + 2] === "(") {
                let depth = 0;
                let scan = pos + 1;
                while (scan < text.length) {
                    if (text[scan] === "(") {
                        depth++;
                    }
                    else if (text[scan] === ")") {
                        depth--;
                        if (depth === 0) {
                            break;
                        }
                    }
                    scan++;
                }
                pos = scan + 1;
                continue;
            }

            let depth = 0;
            let scan = pos + 1;
            while (scan < text.length) {
                if (text[scan] === "(") {
                    depth++;
                }
                else if (text[scan] === ")") {
                    depth--;
                    if (depth === 0) {
                        break;
                    }
                }
                scan++;
            }
            results.push(text.substring(pos + 2, scan));
            pos = scan + 1;
            continue;
        }

        if (text[pos] === "`") {
            let scan = pos + 1;
            while (scan < text.length && text[scan] !== "`") {
                scan++;
            }
            results.push(text.substring(pos + 1, scan));
            pos = scan + 1;
            continue;
        }

        pos++;
    }

    return results;
}

// parseStatement: dispatches between block constructs and a single command based on the leading
// token. Leading words introduce loops (`for`, `while`, `until`), an if-statement (`if`), or a
// case statement (`case`); a leading `(` opens a subshell group and a leading `{` a brace group;
// anything else is a single command leaf.
function parseStatement(state: IParserState, descriptors: Map<string, ICommandDescriptor>): BashAstNode {
    const next = peek(state);
    if (next !== null && next.kind === "word" && next.value === "for") {
        return parseForLoop(state, descriptors);
    }
    if (next !== null && next.kind === "word" && (next.value === "while" || next.value === "until")) {
        return parseWhileLoop(state, descriptors);
    }
    if (next !== null && next.kind === "word" && next.value === "if") {
        return parseIfStatement(state, descriptors);
    }
    if (next !== null && next.kind === "word" && next.value === "case") {
        return parseCaseStatement(state, descriptors);
    }
    if (next !== null && next.kind === "op" && next.value === "(") {
        return parseSubshellGroup(state, descriptors);
    }
    if (next !== null && next.kind === "word" && next.value === "{") {
        return parseBraceGroup(state, descriptors);
    }
    return parseCommand(state, descriptors);
}

// parseWhileLoop: parses `while|until COND ; do BODY ; done` into a WhileLoop node. The condition
// and body are full sub-sequences, so operators and nested blocks inside them build normal trees.
function parseWhileLoop(state: IParserState, descriptors: Map<string, ICommandDescriptor>): BashAstNode {
    const keywordToken = consume(state);
    const startPos = keywordToken.start;
    const until = keywordToken.value === "until";

    const condition = parseSequenceUntil(state, descriptors, DO_TERMINATOR);

    if (peek(state)?.value !== "do") {
        return {
            type: "while_loop",
            until,
            condition,
            body: { type: "command", binary: "", options: {}, cmd: [], envPrefix: {}, redirects: [], raw: "" },
            raw: state.raw.substring(startPos, peek(state)?.start ?? state.raw.length),
        };
    }
    consume(state);

    const body = parseSequenceUntilDone(state, descriptors);

    let endPos = state.raw.length;
    if (peek(state)?.value === "done") {
        endPos = consume(state).end;
    }

    const whileLoop: IWhileLoop = {
        type: "while_loop",
        until,
        condition,
        body,
        raw: state.raw.substring(startPos, endPos),
    };
    return whileLoop;
}

// parseSubshellGroup: parses `( LIST )` into a subshell Group node. The inner list is a full
// sub-sequence; the closing `)` is consumed here.
function parseSubshellGroup(state: IParserState, descriptors: Map<string, ICommandDescriptor>): BashAstNode {
    const openToken = consume(state);
    const startPos = openToken.start;

    const body = parseSequenceUntil(state, descriptors, CLOSE_PAREN_TERMINATOR);

    let endPos = state.raw.length;
    if (peek(state)?.value === ")") {
        endPos = consume(state).end;
    }

    const group: IGroup = {
        type: "group",
        style: "subshell",
        body,
        raw: state.raw.substring(startPos, endPos),
    };
    return group;
}

// parseBraceGroup: parses `{ LIST ; }` into a brace Group node. The opening `{` and closing `}`
// are standalone word tokens (Bash requires surrounding whitespace); the closing `}` is consumed
// here.
function parseBraceGroup(state: IParserState, descriptors: Map<string, ICommandDescriptor>): BashAstNode {
    const openToken = consume(state);
    const startPos = openToken.start;

    const body = parseSequenceUntil(state, descriptors, CLOSE_BRACE_TERMINATOR);

    let endPos = state.raw.length;
    if (peek(state)?.value === "}") {
        endPos = consume(state).end;
    }

    const group: IGroup = {
        type: "group",
        style: "brace",
        body,
        raw: state.raw.substring(startPos, endPos),
    };
    return group;
}

// parseCaseStatement: parses `case WORD in [PATTERN[|PATTERN]* ) LIST ;;]* esac` into a
// CaseStatement node. The matched word is opaque; each clause body is a full sub-sequence.
function parseCaseStatement(state: IParserState, descriptors: Map<string, ICommandDescriptor>): BashAstNode {
    const caseToken = consume(state);
    const startPos = caseToken.start;

    let word = "";
    if (peek(state)?.kind === "word" && peek(state)!.value !== "in") {
        word = consume(state).value;
    }

    if (peek(state)?.value === "in") {
        consume(state);
    }
    skipSeparators(state);

    const clauses: ICaseClause[] = [];
    while (peek(state) !== null && peek(state)!.value !== "esac") {
        const clauseStartPos = state.pos;

        // An optional leading `(` may precede the pattern list, as in `(a|b)`
        if (peek(state)?.value === "(") {
            consume(state);
        }

        const patterns: string[] = [];
        if (peek(state)?.kind === "word") {
            patterns.push(consume(state).value);
        }
        while (peek(state)?.value === "|") {
            consume(state);
            if (peek(state)?.kind === "word") {
                patterns.push(consume(state).value);
            }
        }

        if (peek(state)?.value === ")") {
            consume(state);
        }

        const body = parseSequenceUntil(state, descriptors, CASE_CLAUSE_TERMINATORS);
        clauses.push({ patterns, body });

        if (peek(state)?.value === ";;") {
            consume(state);
        }
        skipSeparators(state);

        // Safety: if a malformed clause made no progress, stop to avoid an infinite loop
        if (state.pos === clauseStartPos) {
            break;
        }
    }

    let endPos = state.raw.length;
    if (peek(state)?.value === "esac") {
        endPos = consume(state).end;
    }

    const caseStatement: ICaseStatement = {
        type: "case_statement",
        word,
        clauses,
        raw: state.raw.substring(startPos, endPos),
    };
    return caseStatement;
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

    skipSeparators(state);

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

// skipSeparators: consumes a run of consecutive `;` separator tokens. Newlines and bare `&` are
// normalised to `;` by the lexer, so this also collapses blank lines and stray separators, and
// skips any leading separators at the start of a sequence or block body.
function skipSeparators(state: IParserState): void {
    while (peek(state)?.value === ";") {
        consume(state);
    }
}

// parseSequenceUntil: parses a `;`-separated sequence of statements until the next statement
// would begin with one of the given block terminator tokens (e.g. "done", "then", "else",
// "elif", "fi", ")", "}", "esac", ";;"), which the caller consumes. Leading and repeated
// separators are collapsed. Mirrors parseSequence but stops at block terminators instead of
// running to the end of the token stream.
function parseSequenceUntil(state: IParserState, descriptors: Map<string, ICommandDescriptor>, terminators: Set<string>): BashAstNode {
    skipSeparators(state);
    let left: BashAstNode = parseAnd(state, descriptors);
    while (peek(state)?.value === ";") {
        skipSeparators(state);
        const next = peek(state);
        if (next === null || terminators.has(next.value)) {
            break;
        }
        const right = parseAnd(state, descriptors);
        left = { type: "binop", op: ";", left, right };
    }
    return left;
}

// parseSequenceUntilDone: parses a `;`-separated sequence of statements until the next
// non-`;` token is the literal word "done", which the caller (parseForLoop) consumes.
function parseSequenceUntilDone(state: IParserState, descriptors: Map<string, ICommandDescriptor>): BashAstNode {
    return parseSequenceUntil(state, descriptors, DONE_TERMINATOR);
}

// Pairs a parsed if-clause node with the offset of its first token. After the whole statement
// is parsed, the shared closing `fi` offset is back-filled into every clause's raw field.
interface IIfClauseStart {
    // The if-statement node produced for this clause (the top-level if, or a nested elif)
    node: IIfStatement;
    // The start offset of this clause's first token in the raw input
    start: number;
}

// parseIfStatement: parses `if COND ; then BODY [elif COND ; then BODY]* [else BODY] ; fi` into
// an IfStatement node. elif clauses are represented as nested IfStatement nodes in elseBranch.
// The closing `fi` is consumed here and its offset back-filled into every clause's raw field.
function parseIfStatement(state: IParserState, descriptors: Map<string, ICommandDescriptor>): BashAstNode {
    const ifToken = consume(state);
    const clauses: IIfClauseStart[] = [];
    const node = parseIfClause(state, descriptors, ifToken.start, clauses);

    let endPos = state.raw.length;
    if (peek(state)?.value === "fi") {
        endPos = consume(state).end;
    }

    for (const clause of clauses) {
        clause.node.raw = state.raw.substring(clause.start, endPos);
    }
    return node;
}

// parseIfClause: parses one `COND ; then BODY` clause plus its optional elif/else continuation.
// An "elif" recurses to build a nested IfStatement; an "else" parses a final branch. The closing
// `fi` belongs to the top-level parseIfStatement, not to any clause. Each clause records its start
// offset in clauses so its raw can be back-filled once the `fi` offset is known.
function parseIfClause(state: IParserState, descriptors: Map<string, ICommandDescriptor>, clauseStart: number, clauses: IIfClauseStart[]): IIfStatement {
    const condition = parseSequenceUntil(state, descriptors, THEN_TERMINATOR);

    if (peek(state)?.value === "then") {
        consume(state);
    }

    const thenBranch = parseSequenceUntil(state, descriptors, IF_BODY_TERMINATORS);

    let elseBranch: BashAstNode | undefined = undefined;
    const next = peek(state);
    if (next?.value === "elif") {
        const elifToken = consume(state);
        elseBranch = parseIfClause(state, descriptors, elifToken.start, clauses);
    }
    else if (next?.value === "else") {
        consume(state);
        elseBranch = parseSequenceUntil(state, descriptors, FI_TERMINATOR);
    }

    const node: IIfStatement = {
        type: "if_statement",
        condition,
        thenBranch,
        raw: "",
    };
    if (elseBranch !== undefined) {
        node.elseBranch = elseBranch;
    }
    clauses.push({ node, start: clauseStart });
    return node;
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

// The empty terminator set used by the top-level sequence, which runs to the end of the stream.
const NO_TERMINATORS = new Set<string>();

// parseSequence: parseAnd (';' parseAnd)*  — lowest operator precedence. Runs to the end of the
// token stream, collapsing leading, repeated, and trailing separators.
function parseSequence(state: IParserState, descriptors: Map<string, ICommandDescriptor>): BashAstNode {
    return parseSequenceUntil(state, descriptors, NO_TERMINATORS);
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
