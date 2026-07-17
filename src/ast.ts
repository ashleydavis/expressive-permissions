import { IAuditLogger } from "./audit-log";
import { IContext } from "./context";
import { IRule, IRuleEvaluation } from "./rules/rule";

// Child nodes of an AST node. Every key holds a single named child, except the `_` key which holds an ordered array of positional children walked in order (e.g. case clause bodies).
export interface IAstChildren {

    // Ordered positional children, used when a node has a variable-length child list rather than named ones.
    _?: IAstNode[];

    // Named children keyed by their role (e.g. command, condition, body); optional named children may be absent.
    [childName: string]: IAstNode | IAstNode[] | undefined;
}

// Generic AST node produced by parse().
export interface IAstNode {

    // Discriminator for the node kind.
    type: string;

    // Source text for this node, including comments when present.
    source: string;

    // Child nodes keyed by name. Omitted when this node has no children.
    children?: IAstChildren;

    // Walk this node against rules, threading context, and return the strictest decision.
    evaluate(rules: IRule[], context: IContext, logger: IAuditLogger): Promise<IRuleEvaluation>;
}
