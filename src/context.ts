// IContext holds cwd and environment variables at one point during AST evaluation.
export interface IContext {

    // Current working directory for path resolution and cwd rules.
    cwd: string;

    // True when cwd is known to be accurate; false after an unresolvable cd.
    cwdResolved?: boolean;

    // Environment variable map threaded through the evaluation.
    env: Record<string, string>;
}
