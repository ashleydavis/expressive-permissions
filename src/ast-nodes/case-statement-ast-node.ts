import { IAstChildren } from "../ast";
import { AstNode } from "./ast-node";

// One pattern clause inside a case statement; its body is a positional child of the statement node.
export interface ICaseClause {

    // Pattern alternatives before the closing parenthesis (e.g. ["stop", "halt"] for `stop|halt)`).
    patterns: string[];
}

// AST node for a bash `case WORD in PATTERN) BODY ;; ... esac` statement.
export class CaseStatementAstNode extends AstNode {

    // Word or expression being matched (opaque; not evaluated as a command).
    word: string;

    // Ordered pattern clauses, positionally aligned with the clause bodies in children._.
    clauses: ICaseClause[];

    // Clause bodies as positional children so the generic walker evaluates each and a deny in any clause wins.
    children: IAstChildren;

    constructor(word: string, clauses: ICaseClause[], children: IAstChildren, source: string) {
        super("case_statement", source);
        this.word = word;
        this.clauses = clauses;
        this.children = children;
    }
}
