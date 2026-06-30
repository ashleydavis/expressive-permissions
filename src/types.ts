// Possible scalar-or-structured value types within a tool input payload.
// Covers all field types that appear across the supported Claude Code tools.
export type ToolInputValue = string | boolean | number | IEditEntry[];

// The raw stdin JSON payload sent by Claude Code's PreToolUse hook
export interface IToolCall {
    // The tool name as reported by Claude Code (e.g. "Bash", "Read", "Write")
    tool_name: string;
    // The input arguments supplied to the tool
    tool_input: Record<string, ToolInputValue>;
    // The current working directory at the time of the hook invocation
    cwd: string;
}

// Decision variant indicating the tool call is allowed to proceed
export interface IAllowDecision {
    // Discriminator for the allow variant
    action: "allow";
    // Optional human-readable reason explaining why the call was allowed
    reason?: string;
}

// Decision variant indicating the tool call should be blocked
export interface IDenyDecision {
    // Discriminator for the deny variant
    action: "deny";
    // Optional human-readable reason shown to the user
    reason?: string;
}

// Decision variant indicating the user should be prompted to decide
export interface IAskDecision {
    // Discriminator for the ask variant
    action: "ask";
    // Optional prompt text to present to the user
    reason?: string;
}

// Decision variant indicating this rule has no opinion and defers to others
export interface IAbstainDecision {
    // Discriminator for the abstain variant
    action: "abstain";
    // Optional human-readable reason explaining the abstention
    reason?: string;
}

// Union of all possible rule decision variants
export type Decision = IAllowDecision | IDenyDecision | IAskDecision | IAbstainDecision;


// A redirect intermediate node wrapping a command (or inner redirect) with an I/O redirection
export interface IRedirectNode {
    // Discriminator for the redirect node type
    type: "redirect";
    // The redirection operator (e.g. ">", ">>", "<", "2>", "&>", "2>&")
    op: string;
    // The wrapped inner node (another redirect or the command leaf)
    command: BashAstNode;
    // The redirection target (file path, or fd number as string for merges like "1")
    target: string;
}

// Shell operators that write redirect output to a file path
export const REDIRECT_OUT_OPS: Set<string> = new Set([">", ">>", "2>", "&>"]);

// Shell operators that read redirect input from a file path
export const REDIRECT_IN_OPS: Set<string> = new Set(["<"]);

// Returns true when the redirect node merges one fd into another (e.g. 2>&1) rather than a file path
export function isRedirectFdMerge(node: IRedirectNode): boolean {
    if (node.op === "2>&") {
        return true;
    }
    return /^\d$/.test(node.target);
}

// Walks inward through nested redirect nodes and returns the innermost command leaf
export function findInnerCommand(node: BashAstNode): ICommand {
    let current: BashAstNode = node;
    while (current.type === "redirect") {
        current = current.command;
    }
    return current as ICommand;
}

// A leaf node representing a single Bash command in the sub-AST
export interface ICommand {
    // Discriminator for the command node type
    type: "command";
    // The command binary (e.g. "ls", "rm", "cd")
    binary: string;
    // Named options: boolean for standalone flags (--watch, -f), string for value flags (--reporter=spec)
    options: Record<string, string | boolean>;
    // Positional arguments (cmd): a single string when there is one, an array when there are zero or multiple
    cmd: string | string[];
    // Environment variable assignments prefixed before the command (e.g. FOO=bar cmd)
    envPrefix: Record<string, string>;
    // Inner commands from embedded command substitutions ($(...) or `...`) found anywhere in this
    // command's words, redirect targets, or env values. Present only when at least one exists.
    // The interpreter evaluates each so a denial inside a substitution denies the whole command.
    substitutions?: BashAstNode[];
    // The original raw command string
    raw: string;
}

// A binary operator node connecting two Bash sub-expressions
export interface IBinOp {
    // Discriminator for the binop node type
    type: "binop";
    // The operator token (e.g. "&&", "||", ";", "|")
    op: string;
    // The left-hand operand
    left: BashAstNode;
    // The right-hand operand
    right: BashAstNode;
}

// A loop node representing a Bash for-in loop. The interpreter walks the body once per
// item in items, with env[variable] set to that item for the duration of that iteration.
export interface IForLoop {
    // Discriminator for the for-loop node type
    type: "for_loop";
    // The loop variable name (e.g. "region" in `for region in ...`)
    variable: string;
    // The list of items the variable iterates over
    items: string[];
    // The loop body that runs once per item
    body: BashAstNode;
    // The original raw command string spanning the entire for-loop
    raw: string;
}

// A conditional node representing a Bash if/then/elif/else/fi statement. The interpreter walks
// the condition (which always runs) and each branch body for permission analysis, since which
// branch executes at runtime cannot be known statically. An elif chain is represented as a
// nested IfStatement node in elseBranch.
export interface IIfStatement {
    // Discriminator for the if-statement node type
    type: "if_statement";
    // The condition command(s) evaluated to decide which branch runs
    condition: BashAstNode;
    // The body that runs when the condition succeeds
    thenBranch: BashAstNode;
    // Optional body that runs when the condition fails; an elif chain nests another IfStatement here
    elseBranch?: BashAstNode;
    // The original raw command string spanning the entire if statement
    raw: string;
}

// A loop node representing a Bash while/until loop. The interpreter walks the condition (which
// always runs) and the body once for permission analysis; whether and how often the body runs at
// runtime is not known statically.
export interface IWhileLoop {
    // Discriminator for the while-loop node type
    type: "while_loop";
    // true for `until` (body runs while the condition is false); false for `while`
    until: boolean;
    // The condition command(s) evaluated before each iteration
    condition: BashAstNode;
    // The loop body
    body: BashAstNode;
    // The original raw command string spanning the entire loop
    raw: string;
}

// A grouped sub-expression. `( list )` runs in a subshell; `{ list; }` runs in the current shell.
// For permission analysis both simply evaluate their inner list; the style controls whether
// environment changes inside the group propagate to later sibling commands.
export interface IGroup {
    // Discriminator for the group node type
    type: "group";
    // "subshell" for ( ... ) (env changes are isolated); "brace" for { ...; } (env propagates)
    style: "subshell" | "brace";
    // The inner statement list
    body: BashAstNode;
    // The original raw command string including the group delimiters
    raw: string;
}

// One pattern clause within a case statement (e.g. `a|b) cmds ;;`).
export interface ICaseClause {
    // The pattern alternatives before the `)` (e.g. ["a", "b"] for `a|b)`)
    patterns: string[];
    // The statement list run when one of the patterns matches
    body: BashAstNode;
}

// A conditional node representing a Bash `case WORD in ... esac` statement. The interpreter walks
// every clause body for permission analysis, since which clause matches is not known statically.
export interface ICaseStatement {
    // Discriminator for the case-statement node type
    type: "case_statement";
    // The word/expression being matched (opaque; not evaluated as a command)
    word: string;
    // The ordered list of pattern clauses
    clauses: ICaseClause[];
    // The original raw command string spanning the entire case statement
    raw: string;
}

// An intermediate node representing an xargs invocation. The child is the parsed subcommand
// that xargs will invoke; its decision bubbles up to become the decision of this node.
export interface IXargsNode {
    // Discriminator for the xargs node type
    type: "xargs";
    // Options that belong to xargs itself (not to the subcommand), e.g. { n: "1", I: "{}" }
    options: Record<string, string | boolean>;
    // The parsed subcommand that xargs will run (may be wrapped in redirect nodes)
    child: BashAstNode;
    // The original raw command string including the xargs binary and all arguments
    raw: string;
}

// Union of all Bash sub-AST node types
export type BashAstNode = ICommand | IBinOp | IForLoop | IXargsNode | IIfStatement | IWhileLoop | IGroup | ICaseStatement | IRedirectNode;

// A single edit operation within a MultiEdit tool call
export interface IEditEntry {
    // The path of the file to edit
    file_path: string;
    // The exact string to be replaced
    old_string: string;
    // The replacement string
    new_string: string;
    // When true, all occurrences of old_string are replaced; otherwise only the first
    replace_all?: boolean;
}

// Tool-root node for a Bash tool call
export interface IBash {
    // Discriminator for the bash tool root
    type: "bash";
    // The parsed Bash sub-AST
    ast: BashAstNode;
    // The original raw command string
    raw: string;
}

// Tool-root node for a Read tool call
export interface IRead {
    // Discriminator for the read tool root
    type: "read";
    // The path of the file being read
    file_path: string;
    // Optional line offset to start reading from
    offset?: number;
    // Optional maximum number of lines to read
    limit?: number;
}

// Tool-root node for a Write tool call
export interface IWrite {
    // Discriminator for the write tool root
    type: "write";
    // The path of the file being written
    file_path: string;
    // The content to write to the file
    content: string;
}

// Tool-root node for an Edit tool call
export interface IEdit {
    // Discriminator for the edit tool root
    type: "edit";
    // The path of the file being edited
    file_path: string;
    // The exact string to be replaced
    old_string: string;
    // The replacement string
    new_string: string;
    // When true, all occurrences of old_string are replaced; otherwise only the first
    replace_all?: boolean;
}

// Tool-root node for a MultiEdit tool call
export interface IMultiEdit {
    // Discriminator for the multiedit tool root
    type: "multiedit";
    // The path of the file being edited
    file_path: string;
    // The ordered list of edit operations to apply
    edits: IEditEntry[];
}

// Tool-root node for any tool not explicitly modelled above
export interface IOtherTool {
    // Discriminator for the other-tool fallback root
    type: "other";
    // The name of the tool as reported by Claude Code
    tool_name: string;
    // The raw tool input payload
    tool_input: Record<string, ToolInputValue>;
}

// Union of all tool-root node types (one per supported Claude Code tool)
export type ToolRoot = IBash | IRead | IWrite | IEdit | IMultiEdit | IOtherTool;

// Union of every AST node type that can appear anywhere in the tree
export type AstNode = ToolRoot | BashAstNode;

// Immutable snapshot of the execution environment at a given tree node
export interface IEnvironment {
    // The logical current working directory (may contain unresolved symlinks)
    cwd: string;
    // True when cwd is known to be accurate; false when a cd to an unresolvable target occurred
    cwdResolved: boolean;
    // The environment variable map at this point in execution
    env: Record<string, string>;
}

// Metadata attached to a tree node after rule evaluation is complete
export interface IAnnotation {
    // The aggregated decision for this node
    decision: Decision;
    // The source file of the rule responsible for the decision, if applicable
    ruleFile?: string;
    // The 1-based line number in ruleFile, if known
    ruleLine?: number;
    // The raw string fragment that triggered the decision, if applicable
    triggeringRaw?: string;
}

// The value a rule returns after evaluating a single AST node
export interface IRuleOutcome {
    // The rule's decision for this node
    decision: Decision;
    // Optional replacement for the global environment propagated after this node
    env?: IEnvironment;
    // Optional scoped environment update visible only to descendant nodes
    scopedEnv?: IEnvironment;
}

// Sentinel IRuleOutcome returned by a rule that has no opinion on the current node
export const ABSTAIN: IRuleOutcome = { decision: { action: "abstain" } };

// A rule function: inspects one AST node and returns a decision with optional env updates.
// ruleFile and ruleLine optionally identify the source location this rule was compiled from.
export interface IRule {
    // The rule evaluation function.
    (node: AstNode, env: IEnvironment, call: IToolCall): IRuleOutcome;
    // The source file this rule was compiled from, if known.
    ruleFile?: string;
    // The 1-based line number in ruleFile where this rule's entry begins, if known.
    ruleLine?: number;
}


// Numeric priority table for strictest-wins comparisons: abstain(0) < allow(1) < ask(2) < deny(3).
const RANK: Record<string, number> = {
    abstain: 0,
    allow: 1,
    ask: 2,
    deny: 3,
};

// rank returns the numeric priority of a decision action for strictest-wins comparisons.
export function rank(decision: Decision): number {
    return RANK[decision.action] ?? 0;
}

// Result returned by runRules for a single node after iterating the full rule list.
export interface IRunRulesResult {
    // The strictest-wins annotation produced by all rules at this node.
    annotation: IAnnotation;
    // Applies all persistent env updates from this node's rules to a base environment.
    // Returns the base unchanged when no rule produced a persistent env update.
    envUpdate: (environment: IEnvironment) => IEnvironment;
    // The env after all rules ran at this node, including both persistent and scoped updates.
    // Used by RuleRegistry to thread env between layers for the same node evaluation.
    nodeRunningEnv: IEnvironment;
}

// Arity 1 means the flag consumes the next token as its value; 0 means boolean
// kind indicates whether the consumed value is a path (subject to cmd rules) or an opaque string
// description is a human-readable summary of the flag's purpose
export interface IFlagDescriptor {
    // 0 = boolean flag; 1 = flag consumes the next token as its value
    arity: 0 | 1;
    // Whether the consumed value is a file-system path or an opaque string
    kind: "path" | "string";
    // Human-readable summary of the flag
    description: string;
}

// Describes one positional slot for a command
// kind: path means the token is subject to cmd rules; string means it is opaque
// variadic: true means this slot captures all remaining positional tokens (only valid on the last entry)
export interface IPositionalDescriptor {
    // Whether the positional is a file-system path or an opaque string
    kind: "path" | "string";
    // Human-readable summary of the positional slot
    description: string;
    // When true, this slot captures all remaining positional tokens
    variadic: boolean;
}

// description is a human-readable summary of the command
// source is a URL pointing to the official documentation for the command
// positionals describes each positional slot in order; the last may be variadic
// flags keys are pipe-separated alias groups, e.g. "r|recursive"
// cmds maps sub-command names to their own descriptors (flags are merged with top-level on match)
export interface ICommandDescriptor {
    // Human-readable summary of the command
    description: string;
    // URL to the official documentation for this command (informational only; not used by the engine)
    source?: string;
    // Ordered list of positional slots; the last entry may be variadic
    positionals: IPositionalDescriptor[];
    // Flag alias groups mapped to their descriptor; keys are pipe-separated, e.g. "f|file"
    flags: { [aliasGroup: string]: IFlagDescriptor };
    // Optional sub-command descriptors; when a positional matches a key here, its flags are merged
    cmds?: { [subCommand: string]: ICommandDescriptor };
}

// The raw stdin JSON payload sent by Claude Code's PostToolUse hook
export interface IPostToolUseCall {
    // The tool name as reported by Claude Code (e.g. "Bash", "Read", "Write")
    tool_name: string;
    // The input arguments supplied to the tool
    tool_input: Record<string, ToolInputValue>;
    // The raw tool response payload (shape varies by tool)
    tool_response: Record<string, unknown>;
    // The current working directory at the time of the hook invocation
    cwd: string;
}
