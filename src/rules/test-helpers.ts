import type { Command, ToolCall, Environment } from "../types";

// Builds a named-args record for use in makeCommand.
export function makeArgs(named: Record<string, string | boolean>): Record<string, string | boolean> {
    return named;
}

// Builds a Command leaf node as the parser would produce.
export function makeCommand(binary: string, args: Record<string, string | boolean>, pos: string | string[], envPrefix: Record<string, string>): Command {
    const posArray = Array.isArray(pos) ? pos : [pos];
    return {
        type: "command",
        binary,
        args,
        pos,
        envPrefix,
        redirects: [],
        raw: `${binary} ${posArray.join(" ")}`.trim(),
    };
}

// Builds an Environment fixture.
export function makeEnv(cwd: string, cwdResolved: boolean, envVars: Record<string, string>): Environment {
    return { cwd, cwdResolved, env: envVars };
}

// Stub ToolCall for tests that do not inspect the ToolCall argument.
export const dummyCall = {} as ToolCall;
