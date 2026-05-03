// Minimal type declarations for picomatch (no @types/picomatch exists for v4)
declare module "picomatch" {
    // Returns a matcher function for the given glob pattern
    function picomatch(glob: string): (value: string) => boolean;
    export = picomatch;
}
