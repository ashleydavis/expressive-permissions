import { AstNode } from "./ast-node";

// AST node for an Agent tool call.
export class AgentAstNode extends AstNode {

    // Short description of the delegated task.
    description: string;

    // Prompt sent to the sub-agent.
    prompt: string;

    constructor(description: string, prompt: string, source: string) {
        super("agent", source);
        this.description = description;
        this.prompt = prompt;
    }
}
