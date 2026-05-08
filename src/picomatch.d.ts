// Minimal type declarations for picomatch (no @types/picomatch exists for v4)
declare module "picomatch" {
    // Subset of picomatch options used by this project
    interface IPicomatchOptions {
        // When true, "*" and "**" match leading dots in path segments (default: false)
        dot?: boolean;
    }

    // Returns a matcher function for the given glob pattern
    function picomatch(glob: string, options?: IPicomatchOptions): (value: string) => boolean;
    export = picomatch;
}
