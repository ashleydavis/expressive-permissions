import { IAstNode } from "../ast";
import { AstNode } from "./ast-node";

// AST node for a WebFetch tool call.
export interface IWebFetchNode extends IAstNode {

    // Discriminator for a WebFetch tool-call root.
    type: "webfetch";

    // URL to fetch.
    url: string;
}

// AST node for a WebFetch tool call.
export class WebFetchAstNode extends AstNode implements IWebFetchNode {

    // Discriminator for a WebFetch tool-call root.
    type: "webfetch" = "webfetch";

    // URL to fetch.
    url: string;

    constructor(url: string, source: string) {
        super("webfetch", source);
        this.url = url;
    }
}
