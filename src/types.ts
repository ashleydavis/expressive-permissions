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


// A single I/O redirection entry attached to a Bash command
export interface IRedirect {
    // The redirection operator (e.g. ">", ">>", "<", "2>")
    op: string;
    // The redirection target (file path or file-descriptor number as string)
    target: string;
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
    // I/O redirections attached to this command
    redirects: IRedirect[];
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

// An intermediate node representing an xargs invocation. The child is the parsed subcommand
// that xargs will invoke; its decision bubbles up to become the decision of this node.
export interface IXargsNode {
    // Discriminator for the xargs node type
    type: "xargs";
    // Options that belong to xargs itself (not to the subcommand), e.g. { n: "1", I: "{}" }
    options: Record<string, string | boolean>;
    // The parsed subcommand Command that xargs will run
    child: ICommand;
    // The original raw command string including the xargs binary and all arguments
    raw: string;
}

// Union of all Bash sub-AST node types
export type BashAstNode = ICommand | IBinOp | IForLoop | IXargsNode;

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
