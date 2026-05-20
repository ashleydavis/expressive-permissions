import type { ICommand, IToolCall, IEnvironment } from "../types";

// Builds a named-options record for use in makeCommand.
export function makeOptions(named: Record<string, string | boolean>): Record<string, string | boolean> {
    return named;
}

// Builds a Command leaf node as the parser would produce.
export function makeCommand(binary: string, options: Record<string, string | boolean>, cmd: string | string[], envPrefix: Record<string, string>): ICommand {
    const cmdArray = Array.isArray(cmd) ? cmd : [cmd];
    return {
        type: "command",
        binary,
        options,
        cmd,
        envPrefix,
        redirects: [],
        raw: `${binary} ${cmdArray.join(" ")}`.trim(),
    };
}

// Builds an Environment fixture.
export function makeEnv(cwd: string, cwdResolved: boolean, envVars: Record<string, string>): IEnvironment {
    return { cwd, cwdResolved, env: envVars };
}

// Stub ToolCall for tests that do not inspect the ToolCall argument.
export const dummyCall = {} as IToolCall;
