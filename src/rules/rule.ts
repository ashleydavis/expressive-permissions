import { IAstNode } from "../ast";
import { SectionConfig } from "../config";
import { IContext } from "../context";

// IDecision is the outcome when a rule applies to an AST node.
export interface IDecision {

    // The permission action: allow, deny, or ask.
    action: string;

    // Human-readable reason from the matching rule, when present.
    reason?: string;
}

// IRuleEvaluation is returned when a rule applies to an AST node.
export interface IRuleEvaluation {

    // Permission decision from the rule, when the rule has one.
    decision?: IDecision;

    // Context after this rule runs at this AST node.
    context: IContext;
}

// ISourceLocation is the file and line a rule was loaded from.
export interface ISourceLocation {

    // Path to the permissions YAML file.
    file?: string;

    // 1-based line number of the rule entry in that file.
    line?: number;
}

// IRule is implemented by each permission rule type.
export interface IRule {

    // File and line this rule was loaded from, when known.
    sourceLocation?: ISourceLocation;

    // Evaluate this rule against one AST node.
    evaluate(ast: IAstNode, context: IContext): Promise<IRuleEvaluation>;
}

// IRuleFactory parses a YAML section into zero or more rules.
export interface IRuleFactory {

    // Parse a permissions.yaml section block into rules.
    load(sectionConfig: SectionConfig): IRule[];
}
