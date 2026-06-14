import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { loadConfigRules, loadConfigRulesFromFile, loadHomeConfigRules, loadProjectConfigRules, validateConfig, resolveCwdPattern, resolveEntryCwdPatterns, resolveRelativeCwdPatterns, isCmdPathPattern, resolveCmdPathPattern, resolveEntryCmdPatterns, resolveRelativeCmdPatterns, expandEntryEnvTokens, expandConfigEnvTokens, aggregateOutcomes, buildBashScopedRule, buildFileScopedRule, notFieldsAllMatch, evaluateFileField, matchesFileField, lineOfOffset, annotateLines, compileTopLevelToolRules, discoverConfigDirFiles, discoverHomeConfigDirFiles, discoverProjectConfigDirFiles, makeConfigFileLoader, IYamlEntry, IYamlConfig, INotFields, IFileMatch, IConfigError, IConfigFileSource } from "../load-config";
import { parseDocument } from "yaml";
import { IRule, IRuleOutcome, AstNode, IEnvironment, IToolCall, ICommand } from "../types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Builds a minimal Environment for tests
function makeEnv(cwd: string = "/project", cwdResolved: boolean = true, envVars: Record<string, string> = {}): IEnvironment {
    return { cwd, cwdResolved, env: envVars };
}

// Stub ToolCall for tests
const dummyCall: IToolCall = { tool_name: "Bash", tool_input: { command: "" }, cwd: "/project" };

// Builds a Command node
function makeCommand(binary: string, cmd: string | string[], namedOptions: Record<string, string | boolean> = {}): ICommand {
    return { type: "command", binary, options: namedOptions, cmd, envPrefix: {}, redirects: [], raw: binary };
}

// Runs the first rule and returns its decision action
function decide(rule: IRule, node: AstNode, env: IEnvironment = makeEnv()): string {
    return rule(node, env, dummyCall).decision.action;
}

// Optional drop-in files to populate under <home>/.claude/permissions.d/ and
// <project>/.claude/permissions.d/ when running withYamlFixtures.
interface IYamlFixtureExtras {
    // Map of file name -> YAML body, written under <home>/.claude/permissions.d/
    homeDirFiles?: Record<string, string>;
    // Map of file name -> YAML body, written under <project>/.claude/permissions.d/
    projectDirFiles?: Record<string, string>;
}

// Sets up a temp directory with home and project YAML files, runs the callback, then cleans up.
// The optional extras parameter writes per-file drop-ins under permissions.d/ in either tree.
function withYamlFixtures(
    homeYaml: string | null,
    projectYaml: string | null,
    callback: (rules: IRule[]) => void,
    extras?: IYamlFixtureExtras
): void {
    const tmpDir = join("/tmp", `claude-perm-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const homeDir = join(tmpDir, "home");
    const projectDir = join(tmpDir, "project");

    mkdirSync(join(homeDir, ".claude"), { recursive: true });
    mkdirSync(join(projectDir, ".claude"), { recursive: true });

    const origHome = process.env["HOME"];
    const origProject = process.env["CLAUDE_PROJECT_DIR"];

    process.env["HOME"] = homeDir;
    process.env["CLAUDE_PROJECT_DIR"] = projectDir;

    if (homeYaml !== null) {
        writeFileSync(join(homeDir, ".claude", "permissions.yaml"), homeYaml, "utf-8");
    }
    if (projectYaml !== null) {
        writeFileSync(join(projectDir, ".claude", "permissions.yaml"), projectYaml, "utf-8");
    }

    if (extras !== undefined && extras.homeDirFiles !== undefined) {
        const homeDropInDir = join(homeDir, ".claude", "permissions.d");
        mkdirSync(homeDropInDir, { recursive: true });
        for (const [name, body] of Object.entries(extras.homeDirFiles)) {
            writeFileSync(join(homeDropInDir, name), body, "utf-8");
        }
    }
    if (extras !== undefined && extras.projectDirFiles !== undefined) {
        const projectDropInDir = join(projectDir, ".claude", "permissions.d");
        mkdirSync(projectDropInDir, { recursive: true });
        for (const [name, body] of Object.entries(extras.projectDirFiles)) {
            writeFileSync(join(projectDropInDir, name), body, "utf-8");
        }
    }

    let rules: IRule[] = [];
    try {
        rules = loadConfigRules();
        callback(rules);
    } finally {
        if (origHome === undefined) {
            delete process.env["HOME"];
        } else {
            process.env["HOME"] = origHome;
        }
        if (origProject === undefined) {
            delete process.env["CLAUDE_PROJECT_DIR"];
        } else {
            process.env["CLAUDE_PROJECT_DIR"] = origProject;
        }
        rmSync(tmpDir, { recursive: true, force: true });
    }
}

// ---------------------------------------------------------------------------
// Environment variable absence
// ---------------------------------------------------------------------------

test("loadConfigRules: CLAUDE_PROJECT_DIR absent → returns []", () => {
    const origHome = process.env["HOME"];
    const origProject = process.env["CLAUDE_PROJECT_DIR"];
    delete process.env["CLAUDE_PROJECT_DIR"];
    delete process.env["HOME"];
    const result = loadConfigRules();
    if (origHome !== undefined) { process.env["HOME"] = origHome; }
    if (origProject !== undefined) { process.env["CLAUDE_PROJECT_DIR"] = origProject; }
    expect(result).toEqual([]);
});

test("loadConfigRules: HOME absent → user-global YAML skipped, project-only rules returned", () => {
    const tmpDir = join("/tmp", `claude-perm-test-${Date.now()}`);
    const projectDir = join(tmpDir, "project");
    mkdirSync(join(projectDir, ".claude"), { recursive: true });
    writeFileSync(join(projectDir, ".claude", "permissions.yaml"), "bash:\n  rm:\n    decide: deny\n", "utf-8");

    const origHome = process.env["HOME"];
    const origProject = process.env["CLAUDE_PROJECT_DIR"];
    delete process.env["HOME"];
    process.env["CLAUDE_PROJECT_DIR"] = projectDir;

    const rules = loadConfigRules();

    if (origHome !== undefined) { process.env["HOME"] = origHome; }
    if (origProject !== undefined) { process.env["CLAUDE_PROJECT_DIR"] = origProject; }
    rmSync(tmpDir, { recursive: true, force: true });

    expect(rules.length).toBeGreaterThan(0);
});

test("loadConfigRules: file not found (env var set but file missing) → returns []", () => {
    const origHome = process.env["HOME"];
    const origProject = process.env["CLAUDE_PROJECT_DIR"];
    process.env["HOME"] = "/nonexistent-dir-xyz";
    process.env["CLAUDE_PROJECT_DIR"] = "/nonexistent-dir-xyz";

    const result = loadConfigRules();

    if (origHome !== undefined) { process.env["HOME"] = origHome; }
    else { delete process.env["HOME"]; }
    if (origProject !== undefined) { process.env["CLAUDE_PROJECT_DIR"] = origProject; }
    else { delete process.env["CLAUDE_PROJECT_DIR"]; }

    expect(result).toEqual([]);
});

// ---------------------------------------------------------------------------
// Merging home + project YAML
// ---------------------------------------------------------------------------

test("loadConfigRules: project beats home on conflicting sections", () => {
    const homeYaml = `
bash:
  rm:
    decide: ask
`;
    const projectYaml = `
bash:
  rm:
    decide: deny
`;
    withYamlFixtures(homeYaml, projectYaml, (rules) => {
        const rmNode = makeCommand("rm", []);
        const outcomes = rules.map((rule) => rule(rmNode, makeEnv(), dummyCall).decision.action);
        expect(outcomes).toContain("deny");
        expect(outcomes).not.toContain("ask");
    });
});

test("loadConfigRules: home rules apply when project has no conflicting section", () => {
    const homeYaml = `
bash:
  rm:
    decide: deny
`;
    const projectYaml = `
read:
  path: "/etc/**"
  decide: deny
`;
    withYamlFixtures(homeYaml, projectYaml, (rules) => {
        const rmNode = makeCommand("rm", []);
        const outcomes = rules.map((rule) => rule(rmNode, makeEnv(), dummyCall).decision.action);
        expect(outcomes).toContain("deny");
    });
});

test("loadConfigRules: home bash rules survive when project bash section covers a different binary", () => {
    const homeYaml = `
bash:
  grep:
    decide: allow
    reason: Searching file contents
`;
    const projectYaml = `
bash:
  echo:
    decide: deny
    reason: Echo is blocked
`;
    withYamlFixtures(homeYaml, projectYaml, (rules) => {
        const grepNode = makeCommand("grep", ["/home/user/src"]);
        const outcomes = rules.map((rule) => rule(grepNode, makeEnv(), dummyCall).decision.action);
        expect(outcomes).toContain("allow");
    });
});

test("loadConfigRules: multiple home bash rules survive when project bash section covers a different binary", () => {
    const homeYaml = `
bash:
  grep:
    decide: allow
  ls:
    decide: allow
  find:
    decide: allow
`;
    const projectYaml = `
bash:
  echo:
    decide: deny
`;
    withYamlFixtures(homeYaml, projectYaml, (rules) => {
        const grepNode = makeCommand("grep", []);
        const lsNode = makeCommand("ls", []);
        const findNode = makeCommand("find", []);
        const grepOutcomes = rules.map((rule) => rule(grepNode, makeEnv(), dummyCall).decision.action);
        const lsOutcomes = rules.map((rule) => rule(lsNode, makeEnv(), dummyCall).decision.action);
        const findOutcomes = rules.map((rule) => rule(findNode, makeEnv(), dummyCall).decision.action);
        expect(grepOutcomes).toContain("allow");
        expect(lsOutcomes).toContain("allow");
        expect(findOutcomes).toContain("allow");
    });
});

test("loadConfigRules: home bash rule count is preserved when project adds a different bash binary", () => {
    const homeYaml = `
bash:
  grep:
    decide: allow
  ls:
    decide: allow
`;
    const projectYaml = `
bash:
  echo:
    decide: deny
`;
    withYamlFixtures(homeYaml, projectYaml, (rules) => {
        // Should have 3 rules total: grep (home), ls (home), echo (project)
        expect(rules.length).toBe(3);
    });
});

// ---------------------------------------------------------------------------
// Bash: catch-all (no matcher fields)
// ---------------------------------------------------------------------------

test("bash catch-all: fires on any command with matching binary", () => {
    const yaml = `
bash:
  git:
    decide: ask
`;
    withYamlFixtures(null, yaml, (rules) => {
        expect(rules.length).toBe(1);
        expect(decide(rules[0], makeCommand("git", []))).toBe("ask");
        expect(decide(rules[0], makeCommand("git", "push"))).toBe("ask");
    });
});

test("bash catch-all: abstains on wrong binary", () => {
    const yaml = `
bash:
  git:
    decide: ask
`;
    withYamlFixtures(null, yaml, (rules) => {
        expect(decide(rules[0], makeCommand("npm", []))).toBe("abstain");
    });
});

// ---------------------------------------------------------------------------
// Bash: flag presence matcher
// ---------------------------------------------------------------------------

test("bash options flag presence: fires when flag is present", () => {
    const yaml = `
bash:
  rm:
    options:
      - r|recursive
    decide: deny
`;
    withYamlFixtures(null, yaml, (rules) => {
        expect(decide(rules[0], makeCommand("rm", [], { r: true }))).toBe("deny");
        expect(decide(rules[0], makeCommand("rm", [], { recursive: true }))).toBe("deny");
    });
});

test("bash options flag presence: abstains when flag absent", () => {
    const yaml = `
bash:
  rm:
    options:
      - r|recursive
    decide: deny
`;
    withYamlFixtures(null, yaml, (rules) => {
        expect(decide(rules[0], makeCommand("rm", [], {}))).toBe("abstain");
    });
});

// ---------------------------------------------------------------------------
// Bash: positional match (string)
// ---------------------------------------------------------------------------

test("bash cmd string: fires when cmd[0] matches glob", () => {
    const yaml = `
bash:
  cat:
    cmd: "*.ts"
    decide: allow
`;
    withYamlFixtures(null, yaml, (rules) => {
        expect(decide(rules[0], makeCommand("cat", "foo.ts"))).toBe("allow");
        expect(decide(rules[0], makeCommand("cat", "foo.js"))).toBe("abstain");
    });
});

test("bash cmd glob: matches paths containing hidden directory segments", () => {
    // Regression: picomatch defaults to dot:false, which makes "*" and "**" refuse
    // to traverse path segments beginning with ".". Users expect "./**" to mean
    // "any path under here", including ones that pass through .git, .claude-plugin, etc.
    // Under path-aware cmd: matching, ./** resolves to <projectDir>/** at load time, and
    // each positional arg is resolved against env.cwd before being matched against it.
    const yaml = `
bash:
  cat:
    cmd: "./**"
    decide: allow
`;
    withYamlFixtures(null, yaml, (rules) => {
        const projectDir = process.env["CLAUDE_PROJECT_DIR"]!;
        const projectEnv = makeEnv(projectDir, true, {});
        // Plain relative path → matches
        expect(decide(rules[0], makeCommand("cat", "src/index.ts"), projectEnv)).toBe("allow");
        // Relative path through a hidden directory → must also match
        expect(decide(rules[0], makeCommand("cat", "plugin/.claude-plugin/plugin.json"), projectEnv)).toBe("allow");
        // Direct hidden file → must also match
        expect(decide(rules[0], makeCommand("cat", ".env"), projectEnv)).toBe("allow");
        // Absolute path with a hidden segment, under the project dir → must also match
        const absoluteHiddenPath = projectDir + "/plugin/.claude-plugin/plugin.json";
        expect(decide(rules[0], makeCommand("cat", absoluteHiddenPath), projectEnv)).toBe("allow");
    });
});

test("read path glob: matches file paths containing hidden directory segments", () => {
    // Same dot-segment regression as the bash cmd glob, but on the read path field.
    const yaml = `
read:
  path: "/home/user/project/**"
  decide: allow
`;
    withYamlFixtures(null, yaml, (rules) => {
        const plainNode: AstNode = { type: "read", file_path: "/home/user/project/src/index.ts" };
        const dotDirNode: AstNode = { type: "read", file_path: "/home/user/project/.git/HEAD" };
        const nestedDotNode: AstNode = { type: "read", file_path: "/home/user/project/plugin/.claude-plugin/plugin.json" };
        const dotFileNode: AstNode = { type: "read", file_path: "/home/user/project/.env" };

        expect(decide(rules[0], plainNode)).toBe("allow");
        expect(decide(rules[0], dotDirNode)).toBe("allow");
        expect(decide(rules[0], nestedDotNode)).toBe("allow");
        expect(decide(rules[0], dotFileNode)).toBe("allow");
    });
});

test("bash cmd string with spaces: matches multiple positionals in order", () => {
    const yaml = `
bash:
  aws:
    cmd: "* describe-*"
    decide: allow
`;
    withYamlFixtures(null, yaml, (rules) => {
        // both positionals match → allow
        expect(decide(rules[0], makeCommand("aws", ["ec2", "describe-instances"]))).toBe("allow");
        expect(decide(rules[0], makeCommand("aws", ["s3", "describe-bucket"]))).toBe("allow");
        // second positional doesn't match describe-* → abstain
        expect(decide(rules[0], makeCommand("aws", ["ec2", "delete-instance"]))).toBe("abstain");
        // only one positional → abstain (second missing)
        expect(decide(rules[0], makeCommand("aws", "ec2"))).toBe("abstain");
    });
});

// ---------------------------------------------------------------------------
// Bash: positional OR semantics (cmd-in)
// ---------------------------------------------------------------------------

test("bash cmd-in: fires when any positional matches any pattern", () => {
    const yaml = `
bash:
  curl:
    cmd-in:
      - "http://*"
      - "ftp://*"
    decide: deny
`;
    withYamlFixtures(null, yaml, (rules) => {
        expect(decide(rules[0], makeCommand("curl", "http://example.com"))).toBe("deny");
        expect(decide(rules[0], makeCommand("curl", "ftp://example.com"))).toBe("deny");
        expect(decide(rules[0], makeCommand("curl", "https://example.com"))).toBe("abstain");
    });
});

// ---------------------------------------------------------------------------
// Bash: flag value (object options)
// ---------------------------------------------------------------------------

test("bash options flag value: fires when flag value matches glob", () => {
    const yaml = `
bash:
  git:
    options:
      m|message: "wip*"
    decide: deny
`;
    withYamlFixtures(null, yaml, (rules) => {
        expect(decide(rules[0], makeCommand("git", [], { m: "wip: temp" }))).toBe("deny");
        expect(decide(rules[0], makeCommand("git", [], { message: "wip: temp" }))).toBe("deny");
        expect(decide(rules[0], makeCommand("git", [], { m: "feat: add stuff" }))).toBe("abstain");
        expect(decide(rules[0], makeCommand("git", [], {}))).toBe("abstain");
    });
});

// ---------------------------------------------------------------------------
// Bash: cwd glob matcher
// ---------------------------------------------------------------------------

test("bash cwd glob: fires inside /etc subtree but not at /etc itself", () => {
    const yaml = `
bash:
  cat:
    cwd: "/etc/**"
    decide: deny
`;
    withYamlFixtures(null, yaml, (rules) => {
        expect(decide(rules[0], makeCommand("cat", []), makeEnv("/etc/nginx"))).toBe("deny");
        expect(decide(rules[0], makeCommand("cat", []), makeEnv("/etc"))).toBe("abstain");
        expect(decide(rules[0], makeCommand("cat", []), makeEnv("/home/user"))).toBe("abstain");
    });
});

// ---------------------------------------------------------------------------
// Bash: cwd_resolved boolean matcher
// ---------------------------------------------------------------------------

test("bash cwd_resolved false: fires only when cwdResolved is false", () => {
    const yaml = `
bash:
  rm:
    cwd_resolved: false
    decide: deny
`;
    withYamlFixtures(null, yaml, (rules) => {
        expect(decide(rules[0], makeCommand("rm", []), makeEnv("/x", false))).toBe("deny");
        expect(decide(rules[0], makeCommand("rm", []), makeEnv("/x", true))).toBe("abstain");
    });
});

test("bash cwd_resolved true: fires only when cwdResolved is true", () => {
    const yaml = `
bash:
  rm:
    cwd_resolved: true
    decide: deny
`;
    withYamlFixtures(null, yaml, (rules) => {
        expect(decide(rules[0], makeCommand("rm", []), makeEnv("/x", true))).toBe("deny");
        expect(decide(rules[0], makeCommand("rm", []), makeEnv("/x", false))).toBe("abstain");
    });
});

test("bash cwd_resolved omitted: fires regardless of cwdResolved", () => {
    const yaml = `
bash:
  rm:
    decide: deny
`;
    withYamlFixtures(null, yaml, (rules) => {
        expect(decide(rules[0], makeCommand("rm", []), makeEnv("/x", true))).toBe("deny");
        expect(decide(rules[0], makeCommand("rm", []), makeEnv("/x", false))).toBe("deny");
    });
});

// ---------------------------------------------------------------------------
// Bash: env value glob matcher
// ---------------------------------------------------------------------------

test("bash env glob: fires when env var matches pattern", () => {
    const yaml = `
bash:
  node:
    env:
      NODE_ENV: "prod*"
    decide: allow
`;
    withYamlFixtures(null, yaml, (rules) => {
        expect(decide(rules[0], makeCommand("node", []), makeEnv("/x", true, { NODE_ENV: "production" }))).toBe("allow");
        expect(decide(rules[0], makeCommand("node", []), makeEnv("/x", true, { NODE_ENV: "dev" }))).toBe("abstain");
        expect(decide(rules[0], makeCommand("node", []), makeEnv("/x", true, {}))).toBe("abstain");
    });
});

// ---------------------------------------------------------------------------
// Bash: subcommand matching
// ---------------------------------------------------------------------------

test("bash single-level subcommand: fires on correct subcommand, abstains on binary alone", () => {
    const yaml = `
bash:
  git:
    push:
      decide: deny
`;
    withYamlFixtures(null, yaml, (rules) => {
        expect(rules.length).toBe(1);
        expect(decide(rules[0], makeCommand("git", "push"))).toBe("deny");
        expect(decide(rules[0], makeCommand("git", []))).toBe("abstain");
        expect(decide(rules[0], makeCommand("git", "pull"))).toBe("abstain");
    });
});

test("bash multi-level subcommand: docker compose build", () => {
    const yaml = `
bash:
  docker:
    compose:
      build:
        decide: ask
`;
    withYamlFixtures(null, yaml, (rules) => {
        expect(rules.length).toBe(1);
        expect(decide(rules[0], makeCommand("docker", ["compose", "build"]))).toBe("ask");
        expect(decide(rules[0], makeCommand("docker", ["compose", "up"]))).toBe("abstain");
        expect(decide(rules[0], makeCommand("docker", ["build"]))).toBe("abstain");
    });
});

// ---------------------------------------------------------------------------
// Bash: list with mixed subcommand and catch-all
// ---------------------------------------------------------------------------

test("bash list: mixed subcommand and catch-all produces correct rules", () => {
    const yaml = `
bash:
  git:
    - push:
        decide: deny
    - decide: ask
`;
    withYamlFixtures(null, yaml, (rules) => {
        expect(rules.length).toBe(2);

        const pushNode = makeCommand("git", "push");
        const pullNode = makeCommand("git", "pull");

        // push rule fires on git push; catch-all fires on any git command
        const pushOutcomes = rules.map((rule) => rule(pushNode, makeEnv(), dummyCall).decision.action);
        const pullOutcomes = rules.map((rule) => rule(pullNode, makeEnv(), dummyCall).decision.action);

        expect(pushOutcomes).toContain("deny");
        expect(pushOutcomes).toContain("ask");
        expect(pullOutcomes).not.toContain("deny");
        expect(pullOutcomes).toContain("ask");
    });
});

// ---------------------------------------------------------------------------
// Bash: list mixed at nested level
// ---------------------------------------------------------------------------

test("bash nested list: docker compose build / docker compose other / docker other", () => {
    const yaml = `
bash:
  docker:
    - compose:
        - build:
            decide: ask
        - decide: deny
    - decide: ask
`;
    withYamlFixtures(null, yaml, (rules) => {
        // 3 rules: [compose/build→ask], [compose catch-all→deny], [docker catch-all→ask]
        expect(rules.length).toBe(3);

        const buildNode = makeCommand("docker", ["compose", "build"]);
        const upNode = makeCommand("docker", ["compose", "up"]);
        const runNode = makeCommand("docker", ["run"]);

        const buildOutcomes = rules.map((rule) => rule(buildNode, makeEnv(), dummyCall).decision.action);
        const upOutcomes = rules.map((rule) => rule(upNode, makeEnv(), dummyCall).decision.action);
        const runOutcomes = rules.map((rule) => rule(runNode, makeEnv(), dummyCall).decision.action);

        // docker compose build: build rule fires ask; compose catch-all fires deny; docker catch-all fires ask
        expect(buildOutcomes).toContain("ask");
        expect(buildOutcomes).toContain("deny");

        // docker compose up: build rule abstains; compose catch-all fires deny; docker catch-all fires ask
        // (strictest-wins gives deny; per-rule both deny and ask fire)
        expect(upOutcomes).toContain("deny");
        expect(upOutcomes).toContain("ask");
        expect(upOutcomes).not.toContain("allow");

        // docker run: both compose rules abstain; docker catch-all fires ask
        expect(runOutcomes).toContain("ask");
        expect(runOutcomes).not.toContain("deny");
    });
});

// ---------------------------------------------------------------------------
// Bash: multi-level subcommand with positional args offset
// ---------------------------------------------------------------------------

test("bash multi-level subcommand cmd: cmd offset by path length", () => {
    const yaml = `
bash:
  git:
    add:
      cmd: "src/*"
      decide: allow
`;
    withYamlFixtures(null, yaml, (rules) => {
        // git add src/foo.ts → cmd = ["add", "src/foo.ts"], path length = 1, cmd checks cmd[1]
        expect(decide(rules[0], makeCommand("git", ["add", "src/foo.ts"]))).toBe("allow");
        expect(decide(rules[0], makeCommand("git", ["add", "test/foo.ts"]))).toBe("abstain");
        // Without enough positionals → abstain
        expect(decide(rules[0], makeCommand("git", "add"))).toBe("abstain");
    });
});

// ---------------------------------------------------------------------------
// Read / Write / Edit / MultiEdit rules
// ---------------------------------------------------------------------------

test("read rule: path glob fires on matching file_path", () => {
    const yaml = `
read:
  path: "/etc/**"
  decide: deny
`;
    withYamlFixtures(null, yaml, (rules) => {
        const readNode: AstNode = { type: "read", file_path: "/etc/passwd" };
        const otherNode: AstNode = { type: "read", file_path: "/home/user/.bashrc" };

        expect(decide(rules[0], readNode)).toBe("deny");
        expect(decide(rules[0], otherNode)).toBe("abstain");
    });
});

test("write rule: abstains on non-write node type", () => {
    const yaml = `
write:
  path: "/etc/**"
  decide: deny
`;
    withYamlFixtures(null, yaml, (rules) => {
        const readNode: AstNode = { type: "read", file_path: "/etc/passwd" };
        expect(decide(rules[0], readNode)).toBe("abstain");
    });
});

test("edit rule: fires on matching file_path", () => {
    const yaml = `
edit:
  path: "**/*.ts"
  decide: allow
`;
    withYamlFixtures(null, yaml, (rules) => {
        const editNode: AstNode = { type: "edit", file_path: "src/foo.ts", old_string: "a", new_string: "b" };
        const jsNode: AstNode = { type: "edit", file_path: "src/foo.js", old_string: "a", new_string: "b" };

        expect(decide(rules[0], editNode)).toBe("allow");
        expect(decide(rules[0], jsNode)).toBe("abstain");
    });
});

test("read rule: path-in fires when file_path matches any pattern", () => {
    const yaml = `
read:
  path-in:
    - "**/.env*"
    - "~/.ssh/*"
  decide: ask
`;
    withYamlFixtures(null, yaml, (rules) => {
        const envNode: AstNode = { type: "read", file_path: "/project/.env" };
        const sshNode: AstNode = { type: "read", file_path: "~/.ssh/id_rsa" };
        const otherNode: AstNode = { type: "read", file_path: "/project/index.ts" };
        expect(decide(rules[0], envNode)).toBe("ask");
        expect(decide(rules[0], sshNode)).toBe("ask");
        expect(decide(rules[0], otherNode)).toBe("abstain");
    });
});

test("multi_edit rule: fires on multiedit node type", () => {
    const yaml = `
multi_edit:
  path: "/secret/**"
  decide: deny
`;
    withYamlFixtures(null, yaml, (rules) => {
        const multiNode: AstNode = { type: "multiedit", file_path: "/secret/data.json", edits: [] };
        expect(decide(rules[0], multiNode)).toBe("deny");
    });
});

// ---------------------------------------------------------------------------
// WebFetch rules
// ---------------------------------------------------------------------------

test("webfetch host: fires when URL host matches glob", () => {
    const yaml = `
webfetch:
  host: "*.evil.com"
  decide: deny
`;
    withYamlFixtures(null, yaml, (rules) => {
        const evilNode: AstNode = { type: "other", tool_name: "WebFetch", tool_input: { url: "https://bad.evil.com/path" } };
        const safeNode: AstNode = { type: "other", tool_name: "WebFetch", tool_input: { url: "https://good.com/path" } };

        expect(decide(rules[0], evilNode)).toBe("deny");
        expect(decide(rules[0], safeNode)).toBe("abstain");
    });
});

test("webfetch host-in: fires when URL host matches any in list", () => {
    const yaml = `
webfetch:
  host-in:
    - "evil.com"
    - "bad.org"
  decide: deny
`;
    withYamlFixtures(null, yaml, (rules) => {
        const evilNode: AstNode = { type: "other", tool_name: "WebFetch", tool_input: { url: "https://evil.com/path" } };
        const badNode: AstNode = { type: "other", tool_name: "WebFetch", tool_input: { url: "https://bad.org/path" } };
        const safeNode: AstNode = { type: "other", tool_name: "WebFetch", tool_input: { url: "https://good.com/path" } };

        expect(decide(rules[0], evilNode)).toBe("deny");
        expect(decide(rules[0], badNode)).toBe("deny");
        expect(decide(rules[0], safeNode)).toBe("abstain");
    });
});

test("webfetch: abstains on non-WebFetch other tool", () => {
    const yaml = `
webfetch:
  decide: deny
`;
    withYamlFixtures(null, yaml, (rules) => {
        const mcpNode: AstNode = { type: "other", tool_name: "SomeMcpTool", tool_input: {} };
        expect(decide(rules[0], mcpNode)).toBe("abstain");
    });
});

// ---------------------------------------------------------------------------
// Tool-name rules
// ---------------------------------------------------------------------------

test("tool-name rule: fires when tool_name matches glob key", () => {
    const yaml = `
"mcp__*__delete*":
  decide: deny
`;
    withYamlFixtures(null, yaml, (rules) => {
        const deleteNode: AstNode = { type: "other", tool_name: "mcp__files__deleteFile", tool_input: {} };
        const safeNode: AstNode = { type: "other", tool_name: "mcp__files__readFile", tool_input: {} };
        const webFetchNode: AstNode = { type: "other", tool_name: "WebFetch", tool_input: {} };

        expect(decide(rules[0], deleteNode)).toBe("deny");
        expect(decide(rules[0], safeNode)).toBe("abstain");
        expect(decide(rules[0], webFetchNode)).toBe("abstain");
    });
});

// ---------------------------------------------------------------------------
// Section mismatch
// ---------------------------------------------------------------------------

test("section mismatch: git bash rule abstains on npm command", () => {
    const yaml = `
bash:
  git:
    decide: deny
`;
    withYamlFixtures(null, yaml, (rules) => {
        expect(decide(rules[0], makeCommand("npm", []))).toBe("abstain");
    });
});

test("section mismatch: read rule abstains on write node", () => {
    const yaml = `
read:
  decide: deny
`;
    withYamlFixtures(null, yaml, (rules) => {
        const writeNode: AstNode = { type: "write", file_path: "/tmp/foo", content: "bar" };
        expect(decide(rules[0], writeNode)).toBe("abstain");
    });
});

// ---------------------------------------------------------------------------
// Rule names
// ---------------------------------------------------------------------------

test("compiled rules have descriptive names", () => {
    const yaml = `
bash:
  rm:
    decide: deny
`;
    withYamlFixtures(null, yaml, (rules) => {
        expect(rules[0].name).toMatch(/yaml:rm/);
    });
});

test("subcommand rule name includes subcommand path", () => {
    const yaml = `
bash:
  docker:
    compose:
      build:
        decide: ask
`;
    withYamlFixtures(null, yaml, (rules) => {
        expect(rules[0].name).toMatch(/compose/);
        expect(rules[0].name).toMatch(/build/);
    });
});

// ---------------------------------------------------------------------------
// Mega config: all features combined
// ---------------------------------------------------------------------------

test("mega config: all features combined load and match correctly", () => {
    const yaml = `
bash:
  rm:
    - options:
        - r|recursive
      decide: deny
    - cmd: "/etc/**"
      decide: deny
    - decide: ask
  git:
    - push:
        decide: deny
    - commit:
        options:
          m|message: "wip*"
        decide: deny
    - decide: ask
  docker:
    compose:
      build:
        decide: ask
      up:
        cwd: "/prod/**"
        decide: deny
  cat:
    cwd: "/etc/**"
    decide: deny
  node:
    env:
      NODE_ENV: "prod*"
    decide: allow
  curl:
    cmd-in:
      - "http://*"
      - "ftp://*"
    decide: deny

read:
  - path: "/etc/**"
    decide: deny
  - path: "**/.env"
    decide: deny
  - decide: allow

write:
  path: "/etc/**"
  decide: deny

edit:
  path: "**/*.ts"
  decide: allow

multi_edit:
  path: "/readonly/**"
  decide: deny

webfetch:
  - host: "*.internal"
    decide: allow
  - host-in:
      - "evil.com"
      - "malware.org"
    decide: deny

"mcp__*__delete*":
  decide: deny
"mcp__*__read*":
  decide: allow
`;

    withYamlFixtures(null, yaml, (rules) => {
        const env = makeEnv("/project", true, {});
        const prodEnv = makeEnv("/prod/app", true, { NODE_ENV: "production" });
        const etcEnv = makeEnv("/etc/nginx", true, {});

        // Helper: find the strictest decision across all rules for a given node
        function strictest(node: AstNode, testEnv: IEnvironment = env): string {
            const rank: Record<string, number> = { abstain: 0, allow: 1, ask: 2, deny: 3 };
            let best = "abstain";
            for (const rule of rules) {
                const action = rule(node, testEnv, dummyCall).decision.action;
                if ((rank[action] ?? 0) > (rank[best] ?? 0)) {
                    best = action;
                }
            }
            return best;
        }

        // --- bash: rm ---
        // rm -r → deny (flag presence)
        expect(strictest(makeCommand("rm", [], { r: true }))).toBe("deny");
        // rm --recursive → deny (alias)
        expect(strictest(makeCommand("rm", [], { recursive: true }))).toBe("deny");
        // rm /etc/passwd → deny (positional glob /**)
        expect(strictest(makeCommand("rm", "/etc/passwd"))).toBe("deny");
        // rm foo.txt → ask (catch-all)
        expect(strictest(makeCommand("rm", "foo.txt"))).toBe("ask");

        // --- bash: git ---
        // git push → deny
        expect(strictest(makeCommand("git", "push"))).toBe("deny");
        // git commit -m "wip: stuff" → deny (flag value glob)
        expect(strictest(makeCommand("git", "commit", { m: "wip: stuff" }))).toBe("deny");
        // git commit -m "feat: add stuff" → ask (flag value doesn't match wip*)
        expect(strictest(makeCommand("git", "commit", { m: "feat: add stuff" }))).toBe("ask");
        // git pull → ask (catch-all)
        expect(strictest(makeCommand("git", "pull"))).toBe("ask");

        // --- bash: docker ---
        // docker compose build → ask
        expect(strictest(makeCommand("docker", ["compose", "build"]))).toBe("ask");
        // docker compose up in /prod/** → deny (cwd-restricted)
        expect(strictest(makeCommand("docker", ["compose", "up"]), prodEnv)).toBe("deny");
        // docker compose up outside /prod/** → abstain (no matching rule)
        expect(strictest(makeCommand("docker", ["compose", "up"]))).toBe("abstain");

        // --- bash: cat ---
        // cat inside /etc/** → deny
        expect(strictest(makeCommand("cat", []), etcEnv)).toBe("deny");
        // cat outside /etc/** → abstain
        expect(strictest(makeCommand("cat", []))).toBe("abstain");

        // --- bash: node with env ---
        // node with NODE_ENV=production → allow
        expect(strictest(makeCommand("node", []), prodEnv)).toBe("allow");
        // node without matching env → abstain
        expect(strictest(makeCommand("node", []))).toBe("abstain");

        // --- bash: curl ---
        // curl http://... → deny
        expect(strictest(makeCommand("curl", "http://example.com"))).toBe("deny");
        // curl ftp://... → deny
        expect(strictest(makeCommand("curl", "ftp://example.com"))).toBe("deny");
        // curl https://... → abstain (no matching rule)
        expect(strictest(makeCommand("curl", "https://example.com"))).toBe("abstain");

        // --- read ---
        const readEtc: AstNode = { type: "read", file_path: "/etc/passwd" };
        const readEnv: AstNode = { type: "read", file_path: "/project/.env" };
        const readSrc: AstNode = { type: "read", file_path: "/project/src/foo.ts" };
        expect(strictest(readEtc)).toBe("deny");
        expect(strictest(readEnv)).toBe("deny");
        expect(strictest(readSrc)).toBe("allow");

        // --- write ---
        const writeEtc: AstNode = { type: "write", file_path: "/etc/hosts", content: "" };
        const writeSrc: AstNode = { type: "write", file_path: "/project/src/foo.ts", content: "" };
        expect(strictest(writeEtc)).toBe("deny");
        expect(strictest(writeSrc)).toBe("abstain");

        // --- edit ---
        const editTs: AstNode = { type: "edit", file_path: "src/foo.ts", old_string: "a", new_string: "b" };
        const editJs: AstNode = { type: "edit", file_path: "src/foo.js", old_string: "a", new_string: "b" };
        expect(strictest(editTs)).toBe("allow");
        expect(strictest(editJs)).toBe("abstain");

        // --- multi_edit ---
        const multiReadonly: AstNode = { type: "multiedit", file_path: "/readonly/config.json", edits: [] };
        const multiSrc: AstNode = { type: "multiedit", file_path: "/project/src/foo.ts", edits: [] };
        expect(strictest(multiReadonly)).toBe("deny");
        expect(strictest(multiSrc)).toBe("abstain");

        // --- webfetch ---
        const fetchInternal: AstNode = { type: "other", tool_name: "WebFetch", tool_input: { url: "https://api.internal/data" } };
        const fetchEvil: AstNode = { type: "other", tool_name: "WebFetch", tool_input: { url: "https://evil.com/payload" } };
        const fetchMalware: AstNode = { type: "other", tool_name: "WebFetch", tool_input: { url: "https://malware.org/x" } };
        const fetchPublic: AstNode = { type: "other", tool_name: "WebFetch", tool_input: { url: "https://example.com/api" } };
        expect(strictest(fetchInternal)).toBe("allow");
        expect(strictest(fetchEvil)).toBe("deny");
        expect(strictest(fetchMalware)).toBe("deny");
        expect(strictest(fetchPublic)).toBe("abstain");

        // --- mcp ---
        const mcpDelete: AstNode = { type: "other", tool_name: "mcp__files__deleteFile", tool_input: {} };
        const mcpRead: AstNode = { type: "other", tool_name: "mcp__files__readFile", tool_input: {} };
        const mcpOther: AstNode = { type: "other", tool_name: "mcp__files__listFiles", tool_input: {} };
        expect(strictest(mcpDelete)).toBe("deny");
        expect(strictest(mcpRead)).toBe("allow");
        expect(strictest(mcpOther)).toBe("abstain");
    });
});

// ---------------------------------------------------------------------------
// Realistic scenario: defensive project config
// ---------------------------------------------------------------------------

test("realistic project config: deny dangerous ops, ask for writes, allow reads", () => {
    const yaml = `
bash:
  rm:
    - options-in:
        - r|recursive
        - f|force
      decide: deny
    - decide: ask
  git:
    - push:
        decide: ask
    - decide: allow
  sudo:
    decide: deny
  curl:
    cwd_resolved: false
    decide: deny

read:
  decide: allow

write:
  - path: "/etc/**"
    decide: deny
  - path: "**/.env"
    decide: deny
  - decide: ask

webfetch:
  decide: allow
`;

    withYamlFixtures(null, yaml, (rules) => {
        function strictest(node: AstNode, testEnv: IEnvironment = makeEnv()): string {
            const rank: Record<string, number> = { abstain: 0, allow: 1, ask: 2, deny: 3 };
            let best = "abstain";
            for (const rule of rules) {
                const action = rule(node, testEnv, dummyCall).decision.action;
                if ((rank[action] ?? 0) > (rank[best] ?? 0)) {
                    best = action;
                }
            }
            return best;
        }

        // rm -rf → deny (either flag present via options-in OR semantics)
        expect(strictest(makeCommand("rm", [], { r: true, f: true }))).toBe("deny");
        // rm -r → deny (recursive flag matches options-in)
        expect(strictest(makeCommand("rm", [], { r: true }))).toBe("deny");
        // rm foo.txt → ask (catch-all)
        expect(strictest(makeCommand("rm", "foo.txt"))).toBe("ask");

        // git push → ask
        expect(strictest(makeCommand("git", "push"))).toBe("ask");
        // git status → allow (catch-all)
        expect(strictest(makeCommand("git", "status"))).toBe("allow");

        // sudo → deny (catch-all)
        expect(strictest(makeCommand("sudo", []))).toBe("deny");

        // curl with unresolved cwd → deny
        expect(strictest(makeCommand("curl", "https://example.com"), makeEnv("/unknown", false))).toBe("deny");
        // curl with resolved cwd → abstain (no rule matches)
        expect(strictest(makeCommand("curl", "https://example.com"), makeEnv("/project", true))).toBe("abstain");

        // any read → allow
        const readNode: AstNode = { type: "read", file_path: "/project/src/foo.ts" };
        expect(strictest(readNode)).toBe("allow");

        // write to /etc → deny
        const writeEtc: AstNode = { type: "write", file_path: "/etc/hosts", content: "" };
        expect(strictest(writeEtc)).toBe("deny");
        // write to .env → deny
        const writeEnv: AstNode = { type: "write", file_path: "/project/.env", content: "" };
        expect(strictest(writeEnv)).toBe("deny");
        // write to source → ask (catch-all)
        const writeSrc: AstNode = { type: "write", file_path: "/project/src/foo.ts", content: "" };
        expect(strictest(writeSrc)).toBe("ask");

        // any webfetch → allow
        const fetchNode: AstNode = { type: "other", tool_name: "WebFetch", tool_input: { url: "https://example.com" } };
        expect(strictest(fetchNode)).toBe("allow");
    });
});

// ---------------------------------------------------------------------------
// Realistic scenario: home + project merge with full sections
// ---------------------------------------------------------------------------

test("realistic merge: home provides defaults, project overrides bash section", () => {
    const homeYaml = `
bash:
  rm:
    decide: ask
  curl:
    decide: ask

read:
  decide: allow

write:
  decide: ask
`;

    const projectYaml = `
bash:
  rm:
    options:
      - r|recursive
    decide: deny
  curl:
    cmd: "http://*"
    decide: deny
`;

    withYamlFixtures(homeYaml, projectYaml, (rules) => {
        function strictest(node: AstNode, testEnv: IEnvironment = makeEnv()): string {
            const rank: Record<string, number> = { abstain: 0, allow: 1, ask: 2, deny: 3 };
            let best = "abstain";
            for (const rule of rules) {
                const action = rule(node, testEnv, dummyCall).decision.action;
                if ((rank[action] ?? 0) > (rank[best] ?? 0)) {
                    best = action;
                }
            }
            return best;
        }

        // Project bash section fully replaces home bash section (shallow merge)
        // rm -r → deny (project rule), but rm alone → abstain (home catch-all gone)
        expect(strictest(makeCommand("rm", [], { r: true }))).toBe("deny");
        expect(strictest(makeCommand("rm", "foo.txt"))).toBe("abstain");

        // curl http://... → deny (project rule); curl https://... → abstain (home catch-all gone)
        expect(strictest(makeCommand("curl", "http://example.com"))).toBe("deny");
        expect(strictest(makeCommand("curl", "https://example.com"))).toBe("abstain");

        // read and write sections come from home (project has no read/write section)
        const readNode: AstNode = { type: "read", file_path: "/project/src/foo.ts" };
        expect(strictest(readNode)).toBe("allow");

        const writeNode: AstNode = { type: "write", file_path: "/project/src/foo.ts", content: "" };
        expect(strictest(writeNode)).toBe("ask");
    });
});

// ---------------------------------------------------------------------------
// readYamlFile: invalid YAML propagates as a thrown error
// ---------------------------------------------------------------------------

test("loadConfigRules: syntactically invalid YAML file throws", () => {
    expect(() => {
        withYamlFixtures("key: [unclosed", null, () => {});
    }).toThrow();
});

// ---------------------------------------------------------------------------
// extractHost: malformed URL falls back to empty string
// ---------------------------------------------------------------------------

test("webfetch: malformed URL yields empty host, abstains when host pattern is set", () => {
    const yaml = `
webfetch:
  host: "example.com"
  decide: deny
`;
    withYamlFixtures(null, yaml, (rules) => {
        const malformedNode: AstNode = { type: "other", tool_name: "WebFetch", tool_input: { url: "not-a-url" } };
        expect(decide(rules[0], malformedNode)).toBe("abstain");
    });
});

// ---------------------------------------------------------------------------
// matchesCwd: cwd-in OR semantics
// ---------------------------------------------------------------------------

test("bash cwd-in: fires when cwd matches any pattern in the list", () => {
    const yaml = `
bash:
  cat:
    cwd-in:
      - "/etc/**"
      - "/var/**"
    decide: deny
`;
    withYamlFixtures(null, yaml, (rules) => {
        expect(decide(rules[0], makeCommand("cat", []), makeEnv("/etc/nginx"))).toBe("deny");
        expect(decide(rules[0], makeCommand("cat", []), makeEnv("/var/log"))).toBe("deny");
        expect(decide(rules[0], makeCommand("cat", []), makeEnv("/home/user"))).toBe("abstain");
    });
});

// ---------------------------------------------------------------------------
// matchesCmd: cmd-in at subcommand level
// ---------------------------------------------------------------------------

test("bash cmd-in at subcommand level: abstains when no positional matches", () => {
    const yaml = `
bash:
  git:
    add:
      cmd-in:
        - "src/*"
        - "test/*"
      decide: allow
`;
    withYamlFixtures(null, yaml, (rules) => {
        expect(decide(rules[0], makeCommand("git", "add"))).toBe("abstain");
        expect(decide(rules[0], makeCommand("git", ["add", "src/foo.ts"]))).toBe("allow");
        expect(decide(rules[0], makeCommand("git", ["add", "test/bar.ts"]))).toBe("allow");
        expect(decide(rules[0], makeCommand("git", ["add", "other/foo.ts"]))).toBe("abstain");
    });
});

// ---------------------------------------------------------------------------
// matchesOptions: object args with boolean flag value (not a string) → abstain
// ---------------------------------------------------------------------------

test("bash options flag value: abstains when flag has a boolean value rather than a string", () => {
    const yaml = `
bash:
  git:
    options:
      m|message: "wip*"
    decide: deny
`;
    withYamlFixtures(null, yaml, (rules) => {
        expect(decide(rules[0], makeCommand("git", [], { m: true }))).toBe("abstain");
    });
});

// ---------------------------------------------------------------------------
// matchesEnvVars: multiple env vars (AND semantics — all must match)
// ---------------------------------------------------------------------------

test("bash env: all env vars must match (AND semantics)", () => {
    const yaml = `
bash:
  cmd:
    env:
      NODE_ENV: "prod*"
      APP_MODE: "live"
    decide: allow
`;
    withYamlFixtures(null, yaml, (rules) => {
        expect(decide(rules[0], makeCommand("cmd", []), makeEnv("/x", true, { NODE_ENV: "production", APP_MODE: "live" }))).toBe("allow");
        expect(decide(rules[0], makeCommand("cmd", []), makeEnv("/x", true, { NODE_ENV: "production", APP_MODE: "dev" }))).toBe("abstain");
        expect(decide(rules[0], makeCommand("cmd", []), makeEnv("/x", true, { NODE_ENV: "development", APP_MODE: "live" }))).toBe("abstain");
    });
});

// ---------------------------------------------------------------------------
// matchesOptions: array AND semantics (all flags must be present)
// ---------------------------------------------------------------------------

test("bash options array AND: fires only when all listed flags are present", () => {
    const yaml = `
bash:
  rm:
    options:
      - r|recursive
      - f|force
    decide: deny
`;
    withYamlFixtures(null, yaml, (rules) => {
        expect(decide(rules[0], makeCommand("rm", [], { r: true, f: true }))).toBe("deny");
        expect(decide(rules[0], makeCommand("rm", [], { recursive: true, force: true }))).toBe("deny");
        // Only one flag → abstain (AND requires both)
        expect(decide(rules[0], makeCommand("rm", [], { r: true }))).toBe("abstain");
        expect(decide(rules[0], makeCommand("rm", [], { f: true }))).toBe("abstain");
        expect(decide(rules[0], makeCommand("rm", [], {}))).toBe("abstain");
    });
});

// ---------------------------------------------------------------------------
// options-in: OR semantics (any listed flag is sufficient)
// ---------------------------------------------------------------------------

test("bash options-in: fires when any listed flag is present", () => {
    const yaml = `
bash:
  rm:
    options-in:
      - r|recursive
      - f|force
    decide: deny
`;
    withYamlFixtures(null, yaml, (rules) => {
        expect(decide(rules[0], makeCommand("rm", [], { r: true }))).toBe("deny");
        expect(decide(rules[0], makeCommand("rm", [], { f: true }))).toBe("deny");
        expect(decide(rules[0], makeCommand("rm", [], { r: true, f: true }))).toBe("deny");
        expect(decide(rules[0], makeCommand("rm", [], {}))).toBe("abstain");
    });
});

// ---------------------------------------------------------------------------
// cmd + options combined (AND across fields)
// ---------------------------------------------------------------------------

test("bash cmd and options combined: both must match simultaneously", () => {
    const yaml = `
bash:
  git:
    add:
      cmd: "*.ts"
      options:
        - f
      decide: deny
`;
    withYamlFixtures(null, yaml, (rules) => {
        // cmd[1] matches *.ts AND -f is present → deny
        expect(decide(rules[0], makeCommand("git", ["add", "foo.ts"], { f: true }))).toBe("deny");
        // cmd[1] matches but -f absent → abstain
        expect(decide(rules[0], makeCommand("git", ["add", "foo.ts"]))).toBe("abstain");
        // -f present but cmd[1] doesn't match → abstain
        expect(decide(rules[0], makeCommand("git", ["add", "foo.js"], { f: true }))).toBe("abstain");
    });
});

// ---------------------------------------------------------------------------
// cmd as list (positional by index, AND)
// ---------------------------------------------------------------------------

test("bash cmd array: matches positional args by index (AND)", () => {
    const yaml = `
bash:
  mv:
    cmd:
      - "src/**"
      - "dist/**"
    decide: ask
`;
    withYamlFixtures(null, yaml, (rules) => {
        expect(decide(rules[0], makeCommand("mv", ["src/foo.ts", "dist/foo.ts"]))).toBe("ask");
        // Second positional doesn't match dist/**
        expect(decide(rules[0], makeCommand("mv", ["src/foo.ts", "other/foo.ts"]))).toBe("abstain");
        // First positional doesn't match src/**
        expect(decide(rules[0], makeCommand("mv", ["lib/foo.ts", "dist/foo.ts"]))).toBe("abstain");
        // Only one positional (second missing) → abstain
        expect(decide(rules[0], makeCommand("mv", "src/foo.ts"))).toBe("abstain");
    });
});

// ---------------------------------------------------------------------------
// cmd-in scanning multiple positionals
// ---------------------------------------------------------------------------

test("bash cmd-in: fires when any positional from offset matches any pattern", () => {
    const yaml = `
bash:
  rm:
    cmd-in:
      - "/etc/**"
      - "/usr/**"
    decide: deny
`;
    withYamlFixtures(null, yaml, (rules) => {
        expect(decide(rules[0], makeCommand("rm", "/etc/passwd"))).toBe("deny");
        expect(decide(rules[0], makeCommand("rm", "/usr/bin/sh"))).toBe("deny");
        // Multiple positionals: any one matching is enough
        expect(decide(rules[0], makeCommand("rm", ["/home/user/file", "/etc/passwd"]))).toBe("deny");
        expect(decide(rules[0], makeCommand("rm", "/home/user/file"))).toBe("abstain");
    });
});

// ---------------------------------------------------------------------------
// matchesPattern: regex patterns
// ---------------------------------------------------------------------------

test("bash cmd regex: fires when positional matches regex", () => {
    const yaml = `
bash:
  curl:
    cmd: "/^ftp:/"
    decide: deny
`;
    withYamlFixtures(null, yaml, (rules) => {
        expect(decide(rules[0], makeCommand("curl", "ftp://example.com"))).toBe("deny");
        expect(decide(rules[0], makeCommand("curl", "http://example.com"))).toBe("abstain");
        expect(decide(rules[0], makeCommand("curl", "https://example.com"))).toBe("abstain");
    });
});

test("read rule: path regex fires on matching file_path", () => {
    const yaml = `
read:
  path: "/.env/"
  decide: ask
`;
    withYamlFixtures(null, yaml, (rules) => {
        const envNode: AstNode = { type: "read", file_path: "/project/.env" };
        const envLocalNode: AstNode = { type: "read", file_path: "/project/.env.local" };
        const otherNode: AstNode = { type: "read", file_path: "/project/index.ts" };
        expect(decide(rules[0], envNode)).toBe("ask");
        expect(decide(rules[0], envLocalNode)).toBe("ask");
        expect(decide(rules[0], otherNode)).toBe("abstain");
    });
});

test("bash cwd regex: fires when cwd matches regex", () => {
    const yaml = `
bash:
  rm:
    cwd: "/-prod/"
    decide: deny
`;
    withYamlFixtures(null, yaml, (rules) => {
        expect(decide(rules[0], makeCommand("rm", []), makeEnv("/projects/myapp-prod"))).toBe("deny");
        expect(decide(rules[0], makeCommand("rm", []), makeEnv("/projects/myapp-dev"))).toBe("abstain");
        expect(decide(rules[0], makeCommand("rm", []), makeEnv("/projects/myapp-prod/sub"))).toBe("deny");
    });
});

// ---------------------------------------------------------------------------
// path-in
// ---------------------------------------------------------------------------

test("read rule: path-in with multiple patterns", () => {
    const yaml = `
read:
  path-in:
    - "**/.env*"
    - "**/.netrc"
    - "~/.ssh/*"
  decide: ask
`;
    withYamlFixtures(null, yaml, (rules) => {
        const envNode: AstNode = { type: "read", file_path: "/project/.env" };
        const netrcNode: AstNode = { type: "read", file_path: "/project/.netrc" };
        const sshNode: AstNode = { type: "read", file_path: "~/.ssh/id_rsa" };
        const otherNode: AstNode = { type: "read", file_path: "/project/index.ts" };
        expect(decide(rules[0], envNode)).toBe("ask");
        expect(decide(rules[0], netrcNode)).toBe("ask");
        expect(decide(rules[0], sshNode)).toBe("ask");
        expect(decide(rules[0], otherNode)).toBe("abstain");
    });
});

// ---------------------------------------------------------------------------
// cwd-in
// ---------------------------------------------------------------------------

test("bash cwd-in: fires when cwd matches any listed pattern", () => {
    const yaml = `
bash:
  rm:
    cwd-in:
      - "/etc/**"
      - "/usr/**"
    decide: deny
`;
    withYamlFixtures(null, yaml, (rules) => {
        expect(decide(rules[0], makeCommand("rm", []), makeEnv("/etc/nginx"))).toBe("deny");
        expect(decide(rules[0], makeCommand("rm", []), makeEnv("/usr/local"))).toBe("deny");
        expect(decide(rules[0], makeCommand("rm", []), makeEnv("/home/user"))).toBe("abstain");
    });
});

// ---------------------------------------------------------------------------
// tool-in for tool-name rules
// ---------------------------------------------------------------------------

test("tool-name rule tool-in: fires when tool_name matches any in list", () => {
    const yaml = `
github-write:
  tool-in:
    - "mcp__github__create_issue"
    - "mcp__github__create_pull_request"
  decide: ask
`;
    withYamlFixtures(null, yaml, (rules) => {
        const issueNode: AstNode = { type: "other", tool_name: "mcp__github__create_issue", tool_input: {} };
        const prNode: AstNode = { type: "other", tool_name: "mcp__github__create_pull_request", tool_input: {} };
        const listNode: AstNode = { type: "other", tool_name: "mcp__github__list_repos", tool_input: {} };
        expect(decide(rules[0], issueNode)).toBe("ask");
        expect(decide(rules[0], prNode)).toBe("ask");
        expect(decide(rules[0], listNode)).toBe("abstain");
    });
});

// ---------------------------------------------------------------------------
// abstain decide value
// ---------------------------------------------------------------------------

test("bash abstain decide: rule fires but returns abstain", () => {
    const yaml = `
bash:
  git:
    decide: abstain
`;
    withYamlFixtures(null, yaml, (rules) => {
        expect(decide(rules[0], makeCommand("git", []))).toBe("abstain");
        expect(decide(rules[0], makeCommand("git", "push"))).toBe("abstain");
        expect(decide(rules[0], makeCommand("npm", []))).toBe("abstain");
    });
});

// ---------------------------------------------------------------------------
// reason field: must not be treated as a subcommand key (would cause infinite
// recursion as compileBashBinary recurses into the string value)
// ---------------------------------------------------------------------------

test("bash reason field: rule with reason compiles and fires correctly", () => {
    const yaml = `
bash:
  rm:
    options:
      - r|recursive
      - f|force
    decide: deny
    reason: rm -rf in any format is not allowed
`;
    withYamlFixtures(null, yaml, (rules) => {
        expect(rules.length).toBe(1);
        expect(decide(rules[0], makeCommand("rm", [], { r: true, f: true }))).toBe("deny");
        expect(decide(rules[0], makeCommand("rm", [], { r: true }))).toBe("abstain");
    });
});

test("read reason field: rule with reason compiles and fires correctly", () => {
    const yaml = `
read:
  path: "/etc/**"
  decide: deny
  reason: System files are read-only
`;
    withYamlFixtures(null, yaml, (rules) => {
        expect(rules.length).toBe(1);
        const etcNode: AstNode = { type: "read", file_path: "/etc/passwd" };
        const homeNode: AstNode = { type: "read", file_path: "/home/user/file" };
        expect(decide(rules[0], etcNode)).toBe("deny");
        expect(decide(rules[0], homeNode)).toBe("abstain");
    });
});

// ---------------------------------------------------------------------------
// reason forwarding: decision.reason must equal the YAML reason field
// ---------------------------------------------------------------------------

test("bash rule with reason: decision.reason equals the reason value", () => {
    const yaml = `
bash:
  rm:
    decide: deny
    reason: destructive deletion blocked
`;
    withYamlFixtures(null, yaml, (rules) => {
        const result = rules[0](makeCommand("rm", []), makeEnv(), dummyCall);
        expect(result.decision.action).toBe("deny");
        expect((result.decision as { action: string; reason?: string }).reason).toBe("destructive deletion blocked");
    });
});

test("bash rule with ask decision: decision.reason equals the reason value", () => {
    const yaml = `
bash:
  git:
    push:
      decide: ask
      reason: confirm before pushing
`;
    withYamlFixtures(null, yaml, (rules) => {
        const pushNode = makeCommand("git", ["push"]);
        const result = rules[0](pushNode, makeEnv(), dummyCall);
        expect(result.decision.action).toBe("ask");
        expect((result.decision as { action: string; reason?: string }).reason).toBe("confirm before pushing");
    });
});

test("read rule with reason: decision.reason equals the reason value", () => {
    const yaml = `
read:
  path: "/etc/**"
  decide: deny
  reason: system files are read-only
`;
    withYamlFixtures(null, yaml, (rules) => {
        const etcNode: AstNode = { type: "read", file_path: "/etc/passwd" };
        const result = rules[0](etcNode, makeEnv(), dummyCall);
        expect(result.decision.action).toBe("deny");
        expect((result.decision as { action: string; reason?: string }).reason).toBe("system files are read-only");
    });
});

test("write rule with reason: decision.reason equals the reason value", () => {
    const yaml = `
write:
  path: "/etc/**"
  decide: deny
  reason: /etc is read-only
`;
    withYamlFixtures(null, yaml, (rules) => {
        const writeNode: AstNode = { type: "write", file_path: "/etc/hosts", content: "" };
        const result = rules[0](writeNode, makeEnv(), dummyCall);
        expect(result.decision.action).toBe("deny");
        expect((result.decision as { action: string; reason?: string }).reason).toBe("/etc is read-only");
    });
});

test("edit rule with reason: decision.reason equals the reason value", () => {
    const yaml = `
edit:
  path: "/etc/**"
  decide: deny
  reason: editing /etc not allowed
`;
    withYamlFixtures(null, yaml, (rules) => {
        const editNode: AstNode = { type: "edit", file_path: "/etc/hosts", old_string: "", new_string: "" };
        const result = rules[0](editNode, makeEnv(), dummyCall);
        expect(result.decision.action).toBe("deny");
        expect((result.decision as { action: string; reason?: string }).reason).toBe("editing /etc not allowed");
    });
});

test("multi_edit rule with reason: decision.reason equals the reason value", () => {
    const yaml = `
multi_edit:
  path: "/etc/**"
  decide: deny
  reason: multi-editing /etc not allowed
`;
    withYamlFixtures(null, yaml, (rules) => {
        const multiEditNode: AstNode = { type: "multiedit", file_path: "/etc/hosts", edits: [] };
        const result = rules[0](multiEditNode, makeEnv(), dummyCall);
        expect(result.decision.action).toBe("deny");
        expect((result.decision as { action: string; reason?: string }).reason).toBe("multi-editing /etc not allowed");
    });
});

test("webfetch rule with reason: decision.reason equals the reason value", () => {
    const yaml = `
webfetch:
  host: "internal.corp"
  decide: deny
  reason: internal hosts not accessible
`;
    withYamlFixtures(null, yaml, (rules) => {
        const fetchNode: AstNode = { type: "other", tool_name: "WebFetch", tool_input: { url: "https://internal.corp/api" } };
        const result = rules[0](fetchNode, makeEnv(), dummyCall);
        expect(result.decision.action).toBe("deny");
        expect((result.decision as { action: string; reason?: string }).reason).toBe("internal hosts not accessible");
    });
});

test("tool-name rule with reason: decision.reason equals the reason value", () => {
    const yaml = `
"mcp__*__dangerous_tool":
  decide: deny
  reason: this mcp tool is blocked
`;
    withYamlFixtures(null, yaml, (rules) => {
        const mcpNode: AstNode = { type: "other", tool_name: "mcp__server__dangerous_tool", tool_input: {} };
        const result = rules[0](mcpNode, makeEnv(), dummyCall);
        expect(result.decision.action).toBe("deny");
        expect((result.decision as { action: string; reason?: string }).reason).toBe("this mcp tool is blocked");
    });
});

test("rule with no reason: decision.reason is undefined", () => {
    const yaml = `
bash:
  rm:
    decide: deny
`;
    withYamlFixtures(null, yaml, (rules) => {
        const result = rules[0](makeCommand("rm", []), makeEnv(), dummyCall);
        expect(result.decision.action).toBe("deny");
        expect((result.decision as { action: string; reason?: string }).reason).toBeUndefined();
    });
});

test("bash allow rule with reason: decision.reason equals the reason value", () => {
    const yaml = `
bash:
  ls:
    decide: allow
    reason: ls is safe
`;
    withYamlFixtures(null, yaml, (rules) => {
        const result = rules[0](makeCommand("ls", []), makeEnv(), dummyCall);
        expect(result.decision.action).toBe("allow");
        expect((result.decision as { action: string; reason?: string }).reason).toBe("ls is safe");
    });
});

test("read allow rule with reason: decision.reason equals the reason value", () => {
    const yaml = `
read:
  path: "/home/**"
  decide: allow
  reason: home dir reads are fine
`;
    withYamlFixtures(null, yaml, (rules) => {
        const readNode: AstNode = { type: "read", file_path: "/home/user/file.txt" };
        const result = rules[0](readNode, makeEnv(), dummyCall);
        expect(result.decision.action).toBe("allow");
        expect((result.decision as { action: string; reason?: string }).reason).toBe("home dir reads are fine");
    });
});

test("allow rule with no reason: decision.reason is undefined", () => {
    const yaml = `
bash:
  ls:
    decide: allow
`;
    withYamlFixtures(null, yaml, (rules) => {
        const result = rules[0](makeCommand("ls", []), makeEnv(), dummyCall);
        expect(result.decision.action).toBe("allow");
        expect((result.decision as { action: string; reason?: string }).reason).toBeUndefined();
    });
});

// ---------------------------------------------------------------------------
// cmd: "." literal exact match (README quick-start example)
// ---------------------------------------------------------------------------

test("bash cmd literal dot: fires only on exact dot argument", () => {
    const yaml = `
bash:
  git:
    add:
      cmd: "."
      decide: deny
      reason: Use specific files instead of git add .
`;
    withYamlFixtures(null, yaml, (rules) => {
        expect(decide(rules[0], makeCommand("git", ["add", "."]))).toBe("deny");
        expect(decide(rules[0], makeCommand("git", ["add", "src/foo.ts"]))).toBe("abstain");
        expect(decide(rules[0], makeCommand("git", ["add", ".."]))).toBe("abstain");
    });
});

// ---------------------------------------------------------------------------
// Glob alternation {a,b,c} in path pattern
// ---------------------------------------------------------------------------

test("read rule: path glob alternation fires on any matching extension", () => {
    const yaml = `
read:
  path: "**/{.env,.env.local,.env.production}"
  decide: ask
`;
    withYamlFixtures(null, yaml, (rules) => {
        const envNode: AstNode = { type: "read", file_path: "/project/.env" };
        const envLocalNode: AstNode = { type: "read", file_path: "/project/.env.local" };
        const envProdNode: AstNode = { type: "read", file_path: "/project/.env.production" };
        const otherNode: AstNode = { type: "read", file_path: "/project/.env.test" };
        expect(decide(rules[0], envNode)).toBe("ask");
        expect(decide(rules[0], envLocalNode)).toBe("ask");
        expect(decide(rules[0], envProdNode)).toBe("ask");
        expect(decide(rules[0], otherNode)).toBe("abstain");
    });
});

// ---------------------------------------------------------------------------
// Relative cwd pattern: ./** — resolved to <projectDir>/** at load time,
// so it only matches paths within the project directory.
// ---------------------------------------------------------------------------

test("bash cwd ./** pattern: resolved to project dir, matches inside but not outside", () => {
    const yaml = `
bash:
  git:
    add:
      cwd: "./**"
      decide: allow
`;
    withYamlFixtures(null, yaml, (rules) => {
        const projectDir = process.env["CLAUDE_PROJECT_DIR"]!;
        expect(decide(rules[0], makeCommand("git", "add"), makeEnv(join(projectDir, "src")))).toBe("allow");
        expect(decide(rules[0], makeCommand("git", "add"), makeEnv("/other/project/src"))).toBe("abstain");
    });
});

// ---------------------------------------------------------------------------
// Wildcard top-level key fires for any tool
// ---------------------------------------------------------------------------

test("wildcard top-level key fires for any tool", () => {
    const yaml = `
"*":
  decide: ask
`;
    withYamlFixtures(null, yaml, (rules) => {
        const anyMcp: AstNode = { type: "other", tool_name: "mcp__anything__action", tool_input: {} };
        const webFetch: AstNode = { type: "other", tool_name: "WebFetch", tool_input: {} };
        expect(decide(rules[0], anyMcp)).toBe("ask");
        expect(decide(rules[0], webFetch)).toBe("ask");
    });
});

// ---------------------------------------------------------------------------
// USER-DEFINED-RULES.md: regex alternation in cmd (/(http|ftp):/),
// Replaces the broken /{http|ftp}://* glob example that was in the docs.
// ---------------------------------------------------------------------------

test("bash cmd regex alternation: /(http|ftp):/ matches http and ftp but not https", () => {
    const yaml = `
bash:
  curl:
    cmd: "/(http|ftp):/"
    decide: deny
    reason: Only HTTPS allowed
`;
    withYamlFixtures(null, yaml, (rules) => {
        expect(decide(rules[0], makeCommand("curl", "http://example.com"))).toBe("deny");
        expect(decide(rules[0], makeCommand("curl", "ftp://example.com"))).toBe("deny");
        expect(decide(rules[0], makeCommand("curl", "https://example.com"))).toBe("abstain");
    });
});

// ---------------------------------------------------------------------------
// README quick start: git status → allow (the simplest subcommand allow example)
// ---------------------------------------------------------------------------

test("README quick start: git status allow rule fires and abstains on other subcommands", () => {
    const yaml = `
bash:
  git:
    status:
      decide: allow
`;
    withYamlFixtures(null, yaml, (rules) => {
        expect(rules.length).toBe(1);
        expect(decide(rules[0], makeCommand("git", "status"))).toBe("allow");
        expect(decide(rules[0], makeCommand("git", "push"))).toBe("abstain");
        expect(decide(rules[0], makeCommand("git", []))).toBe("abstain");
    });
});

// ---------------------------------------------------------------------------
// USER-DEFINED-RULES subcommand example: git status/log/add/push explicit rules
// ---------------------------------------------------------------------------

test("USER-DEFINED-RULES subcommand example: git status log add push", () => {
    const yaml = `
bash:
  git:
    status:
      decide: allow
    log:
      decide: allow
    add:
      decide: ask
      reason: Confirm before staging
    push:
      decide: deny
      reason: Pushing is not allowed
`;
    withYamlFixtures(null, yaml, (rules) => {
        function strictest(node: AstNode): string {
            const rank: Record<string, number> = { abstain: 0, allow: 1, ask: 2, deny: 3 };
            let best = "abstain";
            for (const rule of rules) {
                const action = rule(node, makeEnv(), dummyCall).decision.action;
                if ((rank[action] ?? 0) > (rank[best] ?? 0)) {
                    best = action;
                }
            }
            return best;
        }

        expect(strictest(makeCommand("git", "status"))).toBe("allow");
        expect(strictest(makeCommand("git", "log"))).toBe("allow");
        expect(strictest(makeCommand("git", ["add", "src/foo.ts"]))).toBe("ask");
        expect(strictest(makeCommand("git", "push"))).toBe("deny");
        expect(strictest(makeCommand("git", "pull"))).toBe("abstain");
    });
});

// ---------------------------------------------------------------------------
// USER-DEFINED-RULES: options object with boolean true value
// Docs show: rm: options: r|recursive: true → deny (presence check via object form)
// ---------------------------------------------------------------------------

test("USER-DEFINED-RULES: options object boolean true value matches flag presence", () => {
    const yaml = `
bash:
  rm:
    options:
      r|recursive: true
    decide: deny
`;
    withYamlFixtures(null, yaml, (rules) => {
        expect(decide(rules[0], makeCommand("rm", [], { r: true }))).toBe("deny");
        expect(decide(rules[0], makeCommand("rm", [], { recursive: true }))).toBe("deny");
        expect(decide(rules[0], makeCommand("rm", [], {}))).toBe("abstain");
    });
});

// ---------------------------------------------------------------------------
// USER-DEFINED-RULES: regex in flag value
// Docs show: git commit options: m|message: "/wip/" → deny
// ---------------------------------------------------------------------------

test("USER-DEFINED-RULES: git commit regex flag value /wip/ matches wip messages", () => {
    const yaml = `
bash:
  git:
    commit:
      options:
        m|message: "/wip/"
      decide: deny
      reason: Don't commit with WIP messages
`;
    withYamlFixtures(null, yaml, (rules) => {
        expect(decide(rules[0], makeCommand("git", ["commit"], { m: "just a bit of wip" }))).toBe("deny");
        expect(decide(rules[0], makeCommand("git", ["commit"], { message: "wip: temp" }))).toBe("deny");
        expect(decide(rules[0], makeCommand("git", ["commit"], { m: "feat: add stuff" }))).toBe("abstain");
    });
});

// ---------------------------------------------------------------------------
// USER-DEFINED-RULES: multi-field combined rule (AND semantics across options+env+cwd)
// Docs show: git push --remote origin with CI=true from /projects/** → deny
// ---------------------------------------------------------------------------

test("USER-DEFINED-RULES: multi-field combined rule fires only when all fields match", () => {
    const yaml = `
bash:
  git:
    push:
      options:
        remote: origin
      env:
        CI: "true"
      cwd: /projects/**
      decide: deny
      reason: No pushes to origin from CI inside /projects
`;
    withYamlFixtures(null, yaml, (rules) => {
        const ciProjEnv = makeEnv("/projects/myapp", true, { CI: "true" });
        const ciOutsideEnv = makeEnv("/home/user/myapp", true, { CI: "true" });
        const noCiProjEnv = makeEnv("/projects/myapp", true, {});

        expect(decide(rules[0], makeCommand("git", "push", { remote: "origin" }), ciProjEnv)).toBe("deny");
        expect(decide(rules[0], makeCommand("git", "push", { remote: "origin" }), ciOutsideEnv)).toBe("abstain");
        expect(decide(rules[0], makeCommand("git", "push", { remote: "origin" }), noCiProjEnv)).toBe("abstain");
        expect(decide(rules[0], makeCommand("git", "push", { remote: "upstream" }), ciProjEnv)).toBe("abstain");
    });
});

// ---------------------------------------------------------------------------
// USER-DEFINED-RULES: options-in for force push flags
// Docs show: git push options-in [force, force-with-lease] → ask
// ---------------------------------------------------------------------------

test("USER-DEFINED-RULES: git push force or force-with-lease → ask", () => {
    const yaml = `
bash:
  git:
    push:
      options-in:
        - force
        - force-with-lease
      decide: ask
      reason: Confirm force push
`;
    withYamlFixtures(null, yaml, (rules) => {
        expect(decide(rules[0], makeCommand("git", "push", { force: true }))).toBe("ask");
        expect(decide(rules[0], makeCommand("git", "push", { "force-with-lease": true }))).toBe("ask");
        expect(decide(rules[0], makeCommand("git", "push", {}))).toBe("abstain");
    });
});

// ---------------------------------------------------------------------------
// USER-DEFINED-RULES: curl cmd https → allow
// Docs show: curl cmd: "https://*" → allow
// ---------------------------------------------------------------------------

test("USER-DEFINED-RULES: curl https → allow, other schemes → abstain", () => {
    const yaml = `
bash:
  curl:
    cmd: "https://*"
    decide: allow
`;
    withYamlFixtures(null, yaml, (rules) => {
        expect(decide(rules[0], makeCommand("curl", "https://example.com"))).toBe("allow");
        expect(decide(rules[0], makeCommand("curl", "http://example.com"))).toBe("abstain");
        expect(decide(rules[0], makeCommand("curl", "ftp://example.com"))).toBe("abstain");
    });
});

// ---------------------------------------------------------------------------
// USER-DEFINED-RULES: curl with host field in bash section
// Docs show: bash: curl: host: "*.internal.example.com" → allow
// The host field is not evaluated for bash rules; test reveals this gap.
// ---------------------------------------------------------------------------

test("USER-DEFINED-RULES: curl host in bash rules - internal host → allow, external → ask", () => {
    const yaml = `
bash:
  curl:
    - host: "*.internal.example.com"
      decide: allow
`;
    withYamlFixtures(null, yaml, (rules) => {
        function strictest(node: AstNode): string {
            const rank: Record<string, number> = { abstain: 0, allow: 1, ask: 2, deny: 3 };
            let best = "abstain";
            for (const rule of rules) {
                const action = rule(node, makeEnv(), dummyCall).decision.action;
                if ((rank[action] ?? 0) > (rank[best] ?? 0)) {
                    best = action;
                }
            }
            return best;
        }

        expect(strictest(makeCommand("curl", "https://api.internal.example.com"))).toBe("allow");
        expect(strictest(makeCommand("curl", "https://external.com"))).toBe("abstain");
    });
});

// ---------------------------------------------------------------------------
// USER-DEFINED-RULES: npm install/run full example
// ---------------------------------------------------------------------------

test("USER-DEFINED-RULES: npm install ask, npm run build/test/lint allow, npm run other ask", () => {
    const yaml = `
bash:
  npm:
    install:
      decide: ask
      reason: Confirm before installing packages
    run:
      - build:
          decide: allow
      - test:
          decide: allow
      - lint:
          decide: allow
`;
    withYamlFixtures(null, yaml, (rules) => {
        function strictest(node: AstNode): string {
            const rank: Record<string, number> = { abstain: 0, allow: 1, ask: 2, deny: 3 };
            let best = "abstain";
            for (const rule of rules) {
                const action = rule(node, makeEnv(), dummyCall).decision.action;
                if ((rank[action] ?? 0) > (rank[best] ?? 0)) {
                    best = action;
                }
            }
            return best;
        }

        expect(strictest(makeCommand("npm", ["install", "express"]))).toBe("ask");
        expect(strictest(makeCommand("npm", ["run", "build"]))).toBe("allow");
        expect(strictest(makeCommand("npm", ["run", "test"]))).toBe("allow");
        expect(strictest(makeCommand("npm", ["run", "lint"]))).toBe("allow");
        expect(strictest(makeCommand("npm", ["run", "dev"]))).toBe("abstain");
        expect(strictest(makeCommand("npm", ["run", "start"]))).toBe("abstain");
        expect(strictest(makeCommand("npm", ["publish"]))).toBe("abstain");
    });
});

// ---------------------------------------------------------------------------
// USER-DEFINED-RULES: write .env* → deny (file tool rules section example)
// ---------------------------------------------------------------------------

test("USER-DEFINED-RULES: write env files denied, other writes abstain", () => {
    const yaml = `
write:
  path: "**/.env*"
  decide: deny
  reason: Env files are read-only
`;
    withYamlFixtures(null, yaml, (rules) => {
        const writeEnv: AstNode = { type: "write", file_path: "/project/.env", content: "" };
        const writeEnvLocal: AstNode = { type: "write", file_path: "/project/.env.local", content: "" };
        const writeEnvProd: AstNode = { type: "write", file_path: "/project/.env.production", content: "" };
        const writeSrc: AstNode = { type: "write", file_path: "/project/src/index.ts", content: "" };

        expect(decide(rules[0], writeEnv)).toBe("deny");
        expect(decide(rules[0], writeEnvLocal)).toBe("deny");
        expect(decide(rules[0], writeEnvProd)).toBe("deny");
        expect(decide(rules[0], writeSrc)).toBe("abstain");
    });
});

// ---------------------------------------------------------------------------
// USER-DEFINED-RULES: edit list form [src/** allow, catch-all ask]
// ---------------------------------------------------------------------------

test("USER-DEFINED-RULES: edit list allows src files and asks for others", () => {
    const yaml = `
edit:
  - path: src/**
    decide: allow
`;
    withYamlFixtures(null, yaml, (rules) => {
        function strictest(node: AstNode): string {
            const rank: Record<string, number> = { abstain: 0, allow: 1, ask: 2, deny: 3 };
            let best = "abstain";
            for (const rule of rules) {
                const action = rule(node, makeEnv(), dummyCall).decision.action;
                if ((rank[action] ?? 0) > (rank[best] ?? 0)) {
                    best = action;
                }
            }
            return best;
        }

        const editSrc: AstNode = { type: "edit", file_path: "src/foo.ts", old_string: "a", new_string: "b" };
        const editRoot: AstNode = { type: "edit", file_path: "README.md", old_string: "a", new_string: "b" };
        const editConfig: AstNode = { type: "edit", file_path: "config/settings.json", old_string: "a", new_string: "b" };

        expect(strictest(editSrc)).toBe("allow");
        expect(strictest(editRoot)).toBe("abstain");
        expect(strictest(editConfig)).toBe("abstain");
    });
});

// ---------------------------------------------------------------------------
// USER-DEFINED-RULES: read path-in list with allow catch-all
// ---------------------------------------------------------------------------

test("USER-DEFINED-RULES: read path-in secrets ask, all other reads allow", () => {
    const yaml = `
read:
  - path-in:
      - "**/.env*"
      - "**/.netrc"
      - "~/.ssh/*"
    decide: ask
    reason: Confirm before reading secrets
  - decide: allow
`;
    withYamlFixtures(null, yaml, (rules) => {
        function strictest(node: AstNode): string {
            const rank: Record<string, number> = { abstain: 0, allow: 1, ask: 2, deny: 3 };
            let best = "abstain";
            for (const rule of rules) {
                const action = rule(node, makeEnv(), dummyCall).decision.action;
                if ((rank[action] ?? 0) > (rank[best] ?? 0)) {
                    best = action;
                }
            }
            return best;
        }

        expect(strictest({ type: "read", file_path: "/project/.env" })).toBe("ask");
        expect(strictest({ type: "read", file_path: "/project/.netrc" })).toBe("ask");
        expect(strictest({ type: "read", file_path: "~/.ssh/id_rsa" })).toBe("ask");
        expect(strictest({ type: "read", file_path: "/project/src/index.ts" })).toBe("allow");
        expect(strictest({ type: "read", file_path: "/project/package.json" })).toBe("allow");
    });
});

// ---------------------------------------------------------------------------
// USER-DEFINED-RULES: webfetch allow known hosts + catch-all ask
// Docs show: host-in: [docs.anthropic.com, *.github.com, npmjs.com] allow, else ask
// ---------------------------------------------------------------------------

test("USER-DEFINED-RULES: webfetch known hosts allow, unknown host ask", () => {
    const yaml = `
webfetch:
  - host-in:
      - docs.anthropic.com
      - "*.github.com"
      - npmjs.com
    decide: allow
`;
    withYamlFixtures(null, yaml, (rules) => {
        function strictest(node: AstNode): string {
            const rank: Record<string, number> = { abstain: 0, allow: 1, ask: 2, deny: 3 };
            let best = "abstain";
            for (const rule of rules) {
                const action = rule(node, makeEnv(), dummyCall).decision.action;
                if ((rank[action] ?? 0) > (rank[best] ?? 0)) {
                    best = action;
                }
            }
            return best;
        }

        const makeWebFetch = (url: string): AstNode => ({ type: "other", tool_name: "WebFetch", tool_input: { url } });

        expect(strictest(makeWebFetch("https://docs.anthropic.com/api"))).toBe("allow");
        expect(strictest(makeWebFetch("https://api.github.com/repos"))).toBe("allow");
        expect(strictest(makeWebFetch("https://npmjs.com/package/foo"))).toBe("allow");
        expect(strictest(makeWebFetch("https://example.com/api"))).toBe("abstain");
        expect(strictest(makeWebFetch("https://unknown-host.io"))).toBe("abstain");
    });
});

// ---------------------------------------------------------------------------
// USER-DEFINED-RULES: webfetch deny internal corp, allow known, catch-all ask
// ---------------------------------------------------------------------------

test("USER-DEFINED-RULES: webfetch deny internal, allow known, ask others", () => {
    const yaml = `
webfetch:
  - host: "*.internal.corp"
    decide: deny
    reason: Internal hosts not accessible externally
  - host: docs.anthropic.com
    decide: allow
`;
    withYamlFixtures(null, yaml, (rules) => {
        function strictest(node: AstNode): string {
            const rank: Record<string, number> = { abstain: 0, allow: 1, ask: 2, deny: 3 };
            let best = "abstain";
            for (const rule of rules) {
                const action = rule(node, makeEnv(), dummyCall).decision.action;
                if ((rank[action] ?? 0) > (rank[best] ?? 0)) {
                    best = action;
                }
            }
            return best;
        }

        const makeWebFetch = (url: string): AstNode => ({ type: "other", tool_name: "WebFetch", tool_input: { url } });

        expect(strictest(makeWebFetch("https://service.internal.corp/api"))).toBe("deny");
        expect(strictest(makeWebFetch("https://docs.anthropic.com/api"))).toBe("allow");
        expect(strictest(makeWebFetch("https://example.com/api"))).toBe("abstain");
    });
});

// ---------------------------------------------------------------------------
// USER-DEFINED-RULES: tool-name list with allow list_*, deny delete_*, ask rest
// ---------------------------------------------------------------------------

test("USER-DEFINED-RULES: MCP list operations allow, delete deny, others ask", () => {
    const yaml = `
"mcp__*__list_*":
  decide: allow
"mcp__*__delete_*":
  decide: deny
  reason: Delete operations not allowed
`;
    withYamlFixtures(null, yaml, (rules) => {
        function strictest(node: AstNode): string {
            const rank: Record<string, number> = { abstain: 0, allow: 1, ask: 2, deny: 3 };
            let best = "abstain";
            for (const rule of rules) {
                const action = rule(node, makeEnv(), dummyCall).decision.action;
                if ((rank[action] ?? 0) > (rank[best] ?? 0)) {
                    best = action;
                }
            }
            return best;
        }

        const makeMcp = (toolName: string): AstNode => ({ type: "other", tool_name: toolName, tool_input: {} });

        expect(strictest(makeMcp("mcp__github__list_repos"))).toBe("allow");
        expect(strictest(makeMcp("mcp__files__list_directory"))).toBe("allow");
        expect(strictest(makeMcp("mcp__github__delete_branch"))).toBe("deny");
        expect(strictest(makeMcp("mcp__files__delete_file"))).toBe("deny");
        expect(strictest(makeMcp("mcp__github__create_issue"))).toBe("abstain");
        expect(strictest(makeMcp("mcp__files__read_file"))).toBe("abstain");
    });
});

// ---------------------------------------------------------------------------
// USER-DEFINED-RULES: rm cwd /home/** → ask
// Docs show: rm cwd: /home/** → ask
// ---------------------------------------------------------------------------

test("USER-DEFINED-RULES: rm cwd /home/** → ask, outside /home → abstain", () => {
    const yaml = `
bash:
  rm:
    cwd: /home/**
    decide: ask
    reason: Confirm before deleting from home directories
`;
    withYamlFixtures(null, yaml, (rules) => {
        expect(decide(rules[0], makeCommand("rm", "file.txt"), makeEnv("/home/alice/projects"))).toBe("ask");
        expect(decide(rules[0], makeCommand("rm", "file.txt"), makeEnv("/home/bob"))).toBe("ask");
        expect(decide(rules[0], makeCommand("rm", "file.txt"), makeEnv("/home"))).toBe("abstain");
        expect(decide(rules[0], makeCommand("rm", "file.txt"), makeEnv("/tmp"))).toBe("abstain");
        expect(decide(rules[0], makeCommand("rm", "file.txt"), makeEnv("/etc"))).toBe("abstain");
    });
});

// ---------------------------------------------------------------------------
// USER-DEFINED-RULES: rm cwd regex for prod project directories → deny
// Docs show: rm cwd: /\/projects\/[^/]+-prod\// → deny
// ---------------------------------------------------------------------------

test("USER-DEFINED-RULES: rm cwd regex matches prod project directories", () => {
    const yaml = `
bash:
  rm:
    cwd: /\\/projects\\/[^/]+-prod\\//
    decide: deny
    reason: No deletions in production project directories
`;
    withYamlFixtures(null, yaml, (rules) => {
        expect(decide(rules[0], makeCommand("rm", "file.txt"), makeEnv("/projects/myapp-prod/src"))).toBe("deny");
        expect(decide(rules[0], makeCommand("rm", "file.txt"), makeEnv("/projects/api-prod/dist"))).toBe("deny");
        expect(decide(rules[0], makeCommand("rm", "file.txt"), makeEnv("/projects/myapp-dev/src"))).toBe("abstain");
        expect(decide(rules[0], makeCommand("rm", "file.txt"), makeEnv("/projects/myapp-staging/src"))).toBe("abstain");
        expect(decide(rules[0], makeCommand("rm", "file.txt"), makeEnv("/home/user/myapp-prod"))).toBe("abstain");
    });
});

// ---------------------------------------------------------------------------
// USER-DEFINED-RULES: rm cmd /etc/** → deny (absolute path glob in cmd)
// Docs show: rm cmd: /etc/** → deny (No deleting from /etc)
// ---------------------------------------------------------------------------

test("USER-DEFINED-RULES: rm cmd absolute path glob /etc/** → deny", () => {
    const yaml = `
bash:
  rm:
    cmd: "/etc/**"
    decide: deny
    reason: No deleting from /etc
`;
    withYamlFixtures(null, yaml, (rules) => {
        expect(decide(rules[0], makeCommand("rm", "/etc/passwd"))).toBe("deny");
        expect(decide(rules[0], makeCommand("rm", "/etc/nginx/nginx.conf"))).toBe("deny");
        expect(decide(rules[0], makeCommand("rm", "/home/user/file.txt"))).toBe("abstain");
        expect(decide(rules[0], makeCommand("rm", "/tmp/tempfile"))).toBe("abstain");
    });
});

// ---------------------------------------------------------------------------
// USER-DEFINED-RULES: cwd ./** should be scoped to the current project directory
// Docs say: "cwd: ./** means anywhere within the current project"
// This test verifies the documented behaviour; it will fail if ./** matches outside too.
// ---------------------------------------------------------------------------

test("USER-DEFINED-RULES: cwd ./** is scoped to the current project directory", () => {
    const yaml = `
bash:
  git:
    add:
      cwd: "./**"
      decide: allow
    push:
      cwd: "./**"
      decide: ask
      reason: Confirm push from project directory
`;
    withYamlFixtures(null, yaml, (rules) => {
        function strictest(node: AstNode, testEnv: IEnvironment): string {
            const rank: Record<string, number> = { abstain: 0, allow: 1, ask: 2, deny: 3 };
            let best = "abstain";
            for (const rule of rules) {
                const action = rule(node, testEnv, dummyCall).decision.action;
                if ((rank[action] ?? 0) > (rank[best] ?? 0)) {
                    best = action;
                }
            }
            return best;
        }

        const projectDir = process.env["CLAUDE_PROJECT_DIR"]!;
        const insideProject = makeEnv(join(projectDir, "src"));
        const outsideProject = makeEnv("/some/other/unrelated/path");

        expect(strictest(makeCommand("git", "add"), insideProject)).toBe("allow");
        expect(strictest(makeCommand("git", "push"), insideProject)).toBe("ask");
        expect(strictest(makeCommand("git", "add"), outsideProject)).toBe("abstain");
        expect(strictest(makeCommand("git", "push"), outsideProject)).toBe("abstain");
    });
});

// ---------------------------------------------------------------------------
// USER-DEFINED-RULES: strictest-wins with allow catch-all (not ask)
// Docs show: git add [cmd: "." → deny, decide: allow]
// A deny above should win even though allow catch-all matches
// ---------------------------------------------------------------------------

test("USER-DEFINED-RULES: strictest-wins deny beats allow catch-all", () => {
    const yaml = `
bash:
  git:
    add:
      - cmd: "."
        decide: deny
        reason: use specific files
      - decide: allow
`;
    withYamlFixtures(null, yaml, (rules) => {
        function strictest(node: AstNode): string {
            const rank: Record<string, number> = { abstain: 0, allow: 1, ask: 2, deny: 3 };
            let best = "abstain";
            for (const rule of rules) {
                const action = rule(node, makeEnv(), dummyCall).decision.action;
                if ((rank[action] ?? 0) > (rank[best] ?? 0)) {
                    best = action;
                }
            }
            return best;
        }

        expect(strictest(makeCommand("git", ["add", "."]))).toBe("deny");
        expect(strictest(makeCommand("git", ["add", "src/foo.ts"]))).toBe("allow");
    });
});

// ---------------------------------------------------------------------------
// README table: read ~/.aws/credentials → ask
// ---------------------------------------------------------------------------

test("README table: read ~/.aws/credentials → ask", () => {
    const yaml = `
read:
  path-in:
    - "**/.env*"
    - "~/.ssh/id_rsa"
    - "~/.aws/credentials"
  decide: ask
  reason: Confirm before reading secrets
`;
    withYamlFixtures(null, yaml, (rules) => {
        expect(decide(rules[0], { type: "read", file_path: "~/.aws/credentials" })).toBe("ask");
        expect(decide(rules[0], { type: "read", file_path: "/project/.env" })).toBe("ask");
        expect(decide(rules[0], { type: "read", file_path: "~/.ssh/id_rsa" })).toBe("ask");
        expect(decide(rules[0], { type: "read", file_path: "/project/src/index.ts" })).toBe("abstain");
    });
});

// ---------------------------------------------------------------------------
// README table: edit .env file → deny
// ---------------------------------------------------------------------------

test("README table: edit .env file → deny", () => {
    const yaml = `
edit:
  path: "**/.env"
  decide: deny
  reason: Env files must not be edited
`;
    withYamlFixtures(null, yaml, (rules) => {
        const editEnv: AstNode = { type: "edit", file_path: "/project/.env", old_string: "FOO=bar", new_string: "FOO=baz" };
        const editSrc: AstNode = { type: "edit", file_path: "/project/src/index.ts", old_string: "a", new_string: "b" };

        expect(decide(rules[0], editEnv)).toBe("deny");
        expect(decide(rules[0], editSrc)).toBe("abstain");
    });
});

// ---------------------------------------------------------------------------
// README table: WebFetch to docs.anthropic.com → allow, unknown host → ask
// ---------------------------------------------------------------------------

test("README table: webfetch docs.anthropic.com allow, unknown host ask", () => {
    const yaml = `
webfetch:
  - host: docs.anthropic.com
    decide: allow
`;
    withYamlFixtures(null, yaml, (rules) => {
        function strictest(node: AstNode): string {
            const rank: Record<string, number> = { abstain: 0, allow: 1, ask: 2, deny: 3 };
            let best = "abstain";
            for (const rule of rules) {
                const action = rule(node, makeEnv(), dummyCall).decision.action;
                if ((rank[action] ?? 0) > (rank[best] ?? 0)) {
                    best = action;
                }
            }
            return best;
        }

        const makeWebFetch = (url: string): AstNode => ({ type: "other", tool_name: "WebFetch", tool_input: { url } });

        expect(strictest(makeWebFetch("https://docs.anthropic.com/api/reference"))).toBe("allow");
        expect(strictest(makeWebFetch("https://unknown-site.com/page"))).toBe("abstain");
        expect(strictest(makeWebFetch("https://example.com"))).toBe("abstain");
    });
});

// ---------------------------------------------------------------------------
// resolveCwdPattern
// ---------------------------------------------------------------------------

test("resolveCwdPattern: ./ prefix replaced with baseDir", () => {
    expect(resolveCwdPattern("./src/**", "/home/user/project")).toBe("/home/user/project/src/**");
});

test("resolveCwdPattern: ./** replaced with baseDir/**", () => {
    expect(resolveCwdPattern("./**", "/home/user/project")).toBe("/home/user/project/**");
});

test("resolveCwdPattern: ./ alone replaced with baseDir/", () => {
    expect(resolveCwdPattern("./", "/home/user/project")).toBe("/home/user/project/");
});

test("resolveCwdPattern: absolute path unchanged", () => {
    expect(resolveCwdPattern("/etc/**", "/home/user/project")).toBe("/etc/**");
});

test("resolveCwdPattern: glob without ./ prefix unchanged", () => {
    expect(resolveCwdPattern("src/**", "/home/user/project")).toBe("src/**");
});

test("resolveCwdPattern: regex pattern unchanged", () => {
    expect(resolveCwdPattern("/-prod/", "/home/user/project")).toBe("/-prod/");
});

// ---------------------------------------------------------------------------
// resolveEntryCwdPatterns
// ---------------------------------------------------------------------------

test("resolveEntryCwdPatterns: cwd ./ resolved in entry", () => {
    const entry: IYamlEntry = { cwd: "./src/**", decide: "allow" };
    resolveEntryCwdPatterns(entry, "/base");
    expect(entry.cwd).toBe("/base/src/**");
});

test("resolveEntryCwdPatterns: cwd without ./ prefix left unchanged", () => {
    const entry: IYamlEntry = { cwd: "/etc/**", decide: "deny" };
    resolveEntryCwdPatterns(entry, "/base");
    expect(entry.cwd).toBe("/etc/**");
});

test("resolveEntryCwdPatterns: cwd-in array each ./ pattern resolved", () => {
    const entry: IYamlEntry = { "cwd-in": ["./src/**", "/etc/**", "./test/**"], decide: "allow" };
    resolveEntryCwdPatterns(entry, "/base");
    expect(entry["cwd-in"]).toEqual(["/base/src/**", "/etc/**", "/base/test/**"]);
});

test("resolveEntryCwdPatterns: no cwd or cwd-in leaves entry unchanged", () => {
    const entry: IYamlEntry = { decide: "allow" };
    resolveEntryCwdPatterns(entry, "/base");
    expect(entry.decide).toBe("allow");
    expect(entry.cwd).toBeUndefined();
});

test("resolveEntryCwdPatterns: object-form subcommand key recursed into", () => {
    const entry: IYamlEntry = { push: { cwd: "./**", decide: "deny" } };
    resolveEntryCwdPatterns(entry, "/base");
    const subEntry = entry["push"] as IYamlEntry;
    expect(subEntry.cwd).toBe("/base/**");
});

test("resolveEntryCwdPatterns: array-form subcommand key recursed into", () => {
    const entry: IYamlEntry = { push: [{ cwd: "./**", decide: "deny" }, { decide: "ask" }] };
    resolveEntryCwdPatterns(entry, "/base");
    const subEntries = entry["push"] as IYamlEntry[];
    expect(subEntries[0].cwd).toBe("/base/**");
    expect(subEntries[1].cwd).toBeUndefined();
});

test("resolveEntryCwdPatterns: known fields (options, cmd, env) not recursed into", () => {
    const entry: IYamlEntry = { options: ["r"], cmd: "./foo", decide: "deny" };
    resolveEntryCwdPatterns(entry, "/base");
    expect(entry.cmd).toBe("./foo");
});

test("resolveEntryCwdPatterns: not: cwd ./ resolved", () => {
    const entry: IYamlEntry = { not: { cwd: "./**" }, decide: "deny" };
    resolveEntryCwdPatterns(entry, "/base");
    expect(entry.not!.cwd).toBe("/base/**");
});

test("resolveEntryCwdPatterns: not: cwd-in each ./ pattern resolved", () => {
    const entry: IYamlEntry = { not: { "cwd-in": ["./src/**", "/etc/**", "./test/**"] }, decide: "deny" };
    resolveEntryCwdPatterns(entry, "/base");
    expect(entry.not!["cwd-in"]).toEqual(["/base/src/**", "/etc/**", "/base/test/**"]);
});

test("resolveEntryCwdPatterns: not: absolute cwd unchanged", () => {
    const entry: IYamlEntry = { not: { cwd: "/etc/**" }, decide: "deny" };
    resolveEntryCwdPatterns(entry, "/base");
    expect(entry.not!.cwd).toBe("/etc/**");
});

// ---------------------------------------------------------------------------
// resolveRelativeCwdPatterns
// ---------------------------------------------------------------------------

test("resolveRelativeCwdPatterns: bash section cwd resolved", () => {
    const config: IYamlConfig = {
        bash: { rm: { cwd: "./**", decide: "deny" } },
    };
    resolveRelativeCwdPatterns(config, "/base");
    expect((config.bash!["rm"] as IYamlEntry).cwd).toBe("/base/**");
});

test("resolveRelativeCwdPatterns: bash section list entries all resolved", () => {
    const config: IYamlConfig = {
        bash: { rm: [{ cwd: "./a/**", decide: "deny" }, { cwd: "./b/**", decide: "ask" }] },
    };
    resolveRelativeCwdPatterns(config, "/base");
    const entries = config.bash!["rm"] as IYamlEntry[];
    expect(entries[0].cwd).toBe("/base/a/**");
    expect(entries[1].cwd).toBe("/base/b/**");
});

test("resolveRelativeCwdPatterns: read section cwd resolved", () => {
    const config: IYamlConfig = { read: { cwd: "./**", decide: "allow" } };
    resolveRelativeCwdPatterns(config, "/base");
    expect((config.read as IYamlEntry).cwd).toBe("/base/**");
});

test("resolveRelativeCwdPatterns: write section cwd resolved", () => {
    const config: IYamlConfig = { write: { cwd: "./**", decide: "deny" } };
    resolveRelativeCwdPatterns(config, "/base");
    expect((config.write as IYamlEntry).cwd).toBe("/base/**");
});

test("resolveRelativeCwdPatterns: edit section cwd resolved", () => {
    const config: IYamlConfig = { edit: { cwd: "./**", decide: "allow" } };
    resolveRelativeCwdPatterns(config, "/base");
    expect((config.edit as IYamlEntry).cwd).toBe("/base/**");
});

test("resolveRelativeCwdPatterns: multi_edit section cwd resolved", () => {
    const config: IYamlConfig = { multi_edit: { cwd: "./**", decide: "deny" } };
    resolveRelativeCwdPatterns(config, "/base");
    expect((config.multi_edit as IYamlEntry).cwd).toBe("/base/**");
});

test("resolveRelativeCwdPatterns: webfetch section cwd resolved", () => {
    const config: IYamlConfig = { webfetch: { cwd: "./**", decide: "allow" } };
    resolveRelativeCwdPatterns(config, "/base");
    expect((config.webfetch as IYamlEntry).cwd).toBe("/base/**");
});

test("resolveRelativeCwdPatterns: top-level tool-name key cwd resolved", () => {
    const config = { Foo: { cwd: "./**", decide: "allow" } } as IYamlConfig & { Foo: IYamlEntry };
    resolveRelativeCwdPatterns(config, "/base");
    expect(config.Foo.cwd).toBe("/base/**");
});

test("resolveRelativeCwdPatterns: empty config is a no-op", () => {
    const config: IYamlConfig = {};
    expect(() => resolveRelativeCwdPatterns(config, "/base")).not.toThrow();
});

test("resolveRelativeCwdPatterns: absolute patterns in all sections left unchanged", () => {
    const config: IYamlConfig = {
        bash: { rm: { cwd: "/etc/**", decide: "deny" } },
        read: { cwd: "/secrets/**", decide: "ask" },
    };
    resolveRelativeCwdPatterns(config, "/base");
    expect((config.bash!["rm"] as IYamlEntry).cwd).toBe("/etc/**");
    expect((config.read as IYamlEntry).cwd).toBe("/secrets/**");
});

// ---------------------------------------------------------------------------
// isCmdPathPattern
// ---------------------------------------------------------------------------

test("isCmdPathPattern: returns true for ./", () => {
    expect(isCmdPathPattern("./")).toBe(true);
});

test("isCmdPathPattern: returns true for ./**", () => {
    expect(isCmdPathPattern("./**")).toBe(true);
});

test("isCmdPathPattern: returns true for ./foo", () => {
    expect(isCmdPathPattern("./foo")).toBe(true);
});

test("isCmdPathPattern: returns true for /foo", () => {
    expect(isCmdPathPattern("/foo")).toBe(true);
});

test("isCmdPathPattern: returns false for empty string", () => {
    expect(isCmdPathPattern("")).toBe(false);
});

test("isCmdPathPattern: returns false for plain glob foo-*", () => {
    expect(isCmdPathPattern("foo-*")).toBe(false);
});

test("isCmdPathPattern: returns false for *.yaml", () => {
    expect(isCmdPathPattern("*.yaml")).toBe(false);
});

test("isCmdPathPattern: returns false for plain word foo", () => {
    expect(isCmdPathPattern("foo")).toBe(false);
});

test("isCmdPathPattern: returns false for regex pattern /.../", () => {
    expect(isCmdPathPattern("/^ftp:/")).toBe(false);
});

// ---------------------------------------------------------------------------
// resolveCmdPathPattern
// ---------------------------------------------------------------------------

test("resolveCmdPathPattern: ./** anchored to project dir", () => {
    expect(resolveCmdPathPattern("./**", "/proj")).toBe("/proj/**");
});

test("resolveCmdPathPattern: ./foo/bar anchored to project dir", () => {
    expect(resolveCmdPathPattern("./foo/bar", "/proj")).toBe("/proj/foo/bar");
});

test("resolveCmdPathPattern: absolute /etc/hosts passthrough", () => {
    expect(resolveCmdPathPattern("/etc/hosts", "/proj")).toBe("/etc/hosts");
});

test("resolveCmdPathPattern: plain glob foo-* passthrough", () => {
    expect(resolveCmdPathPattern("foo-*", "/proj")).toBe("foo-*");
});

// ---------------------------------------------------------------------------
// resolveEntryCmdPatterns
// ---------------------------------------------------------------------------

test("resolveEntryCmdPatterns: cmd string form rewritten", () => {
    const entry: IYamlEntry = { cmd: "./**", decide: "allow" };
    resolveEntryCmdPatterns(entry, "/proj");
    expect(entry.cmd).toBe("/proj/**");
});

test("resolveEntryCmdPatterns: cmd string form with multiple tokens rewrites each path-style token", () => {
    const entry: IYamlEntry = { cmd: "./src ./test other-*", decide: "allow" };
    resolveEntryCmdPatterns(entry, "/proj");
    expect(entry.cmd).toBe("/proj/src /proj/test other-*");
});

test("resolveEntryCmdPatterns: cmd array form rewritten per-element", () => {
    const entry: IYamlEntry = { cmd: ["./src/**", "/etc/hosts", "foo-*"], decide: "deny" };
    resolveEntryCmdPatterns(entry, "/proj");
    expect(entry.cmd).toEqual(["/proj/src/**", "/etc/hosts", "foo-*"]);
});

test("resolveEntryCmdPatterns: cmd-in array each path pattern rewritten", () => {
    const entry: IYamlEntry = { "cmd-in": ["./a/**", "/etc/**", "./b/**", "foo-*"], decide: "allow" };
    resolveEntryCmdPatterns(entry, "/proj");
    expect(entry["cmd-in"]).toEqual(["/proj/a/**", "/etc/**", "/proj/b/**", "foo-*"]);
});

test("resolveEntryCmdPatterns: not.cmd rewritten", () => {
    const entry: IYamlEntry = { not: { cmd: "./**" }, decide: "deny" };
    resolveEntryCmdPatterns(entry, "/proj");
    expect(entry.not!.cmd).toBe("/proj/**");
});

test("resolveEntryCmdPatterns: not.cmd-in rewritten", () => {
    const entry: IYamlEntry = { not: { "cmd-in": ["./x/**", "foo-*"] }, decide: "deny" };
    resolveEntryCmdPatterns(entry, "/proj");
    expect(entry.not!["cmd-in"]).toEqual(["/proj/x/**", "foo-*"]);
});

test("resolveEntryCmdPatterns: rules sub-entries recursed into", () => {
    const entry: IYamlEntry = { rules: [{ cmd: "./a", decide: "allow" }, { cmd: "./b", decide: "deny" }] };
    resolveEntryCmdPatterns(entry, "/proj");
    expect((entry.rules![0] as IYamlEntry).cmd).toBe("/proj/a");
    expect((entry.rules![1] as IYamlEntry).cmd).toBe("/proj/b");
});

test("resolveEntryCmdPatterns: subcommand children recursed when not a tool-name entry", () => {
    const entry: IYamlEntry = { push: { cmd: "./**", decide: "deny" } };
    resolveEntryCmdPatterns(entry, "/proj");
    const subEntry = entry["push"] as IYamlEntry;
    expect(subEntry.cmd).toBe("/proj/**");
});

test("resolveEntryCmdPatterns: tool-name entry skips subcommand recursion", () => {
    const entry: IYamlEntry = { push: { cmd: "./**", decide: "deny" } };
    resolveEntryCmdPatterns(entry, "/proj", { isToolNameEntry: true });
    const subEntry = entry["push"] as IYamlEntry;
    expect(subEntry.cmd).toBe("./**");
});

test("resolveEntryCmdPatterns: cwd field not affected by cmd walker", () => {
    const entry: IYamlEntry = { cwd: "./src/**", decide: "allow" };
    resolveEntryCmdPatterns(entry, "/proj");
    expect(entry.cwd).toBe("./src/**");
});

// ---------------------------------------------------------------------------
// resolveRelativeCmdPatterns
// ---------------------------------------------------------------------------

test("resolveRelativeCmdPatterns: bash section cmd resolved", () => {
    const config: IYamlConfig = { bash: { find: { cmd: "./**", decide: "allow" } } };
    resolveRelativeCmdPatterns(config, "/proj");
    expect((config.bash!["find"] as IYamlEntry).cmd).toBe("/proj/**");
});

test("resolveRelativeCmdPatterns: read section cmd resolved", () => {
    const config: IYamlConfig = { read: { cmd: "./**", decide: "allow" } };
    resolveRelativeCmdPatterns(config, "/proj");
    expect((config.read as IYamlEntry).cmd).toBe("/proj/**");
});

test("resolveRelativeCmdPatterns: write section cmd resolved", () => {
    const config: IYamlConfig = { write: { cmd: "./**", decide: "deny" } };
    resolveRelativeCmdPatterns(config, "/proj");
    expect((config.write as IYamlEntry).cmd).toBe("/proj/**");
});

test("resolveRelativeCmdPatterns: edit section cmd resolved", () => {
    const config: IYamlConfig = { edit: { cmd: "./**", decide: "allow" } };
    resolveRelativeCmdPatterns(config, "/proj");
    expect((config.edit as IYamlEntry).cmd).toBe("/proj/**");
});

test("resolveRelativeCmdPatterns: multi_edit section cmd resolved", () => {
    const config: IYamlConfig = { multi_edit: { cmd: "./**", decide: "deny" } };
    resolveRelativeCmdPatterns(config, "/proj");
    expect((config.multi_edit as IYamlEntry).cmd).toBe("/proj/**");
});

test("resolveRelativeCmdPatterns: webfetch section cmd resolved", () => {
    const config: IYamlConfig = { webfetch: { cmd: "./**", decide: "allow" } };
    resolveRelativeCmdPatterns(config, "/proj");
    expect((config.webfetch as IYamlEntry).cmd).toBe("/proj/**");
});

test("resolveRelativeCmdPatterns: top-level tool-name key cmd resolved", () => {
    const config = { Foo: { cmd: "./**", decide: "allow" } } as IYamlConfig & { Foo: IYamlEntry };
    resolveRelativeCmdPatterns(config, "/proj");
    expect(config.Foo.cmd).toBe("/proj/**");
});

test("resolveRelativeCmdPatterns: empty config is a no-op", () => {
    const config: IYamlConfig = {};
    expect(() => resolveRelativeCmdPatterns(config, "/proj")).not.toThrow();
});

// ---------------------------------------------------------------------------
// matchesCmd path-aware semantics (via end-to-end YAML evaluation)
// ---------------------------------------------------------------------------

test("matchesCmd path-aware: arg '.' under project resolves and matches ./**", () => {
    const yaml = `
bash:
  find:
    cmd: "./**"
    decide: allow
`;
    withYamlFixtures(null, yaml, (rules) => {
        const projectDir = process.env["CLAUDE_PROJECT_DIR"]!;
        const subDirEnv = makeEnv(projectDir + "/foo/bar", true, {});
        expect(decide(rules[0], makeCommand("find", "."), subDirEnv)).toBe("allow");
    });
});

test("matchesCmd path-aware: arg '.' outside project does not match ./**", () => {
    const yaml = `
bash:
  find:
    cmd: "./**"
    decide: allow
`;
    withYamlFixtures(null, yaml, (rules) => {
        const tmpEnv = makeEnv("/tmp", true, {});
        expect(decide(rules[0], makeCommand("find", "."), tmpEnv)).toBe("abstain");
    });
});

test("matchesCmd path-aware: absolute arg under project matches ./**", () => {
    const yaml = `
bash:
  find:
    cmd: "./**"
    decide: allow
`;
    withYamlFixtures(null, yaml, (rules) => {
        const projectDir = process.env["CLAUDE_PROJECT_DIR"]!;
        const someEnv = makeEnv("/some/other/place", true, {});
        expect(decide(rules[0], makeCommand("find", projectDir + "/sub/file"), someEnv)).toBe("allow");
    });
});

test("matchesCmd path-aware: arg /etc/passwd does not match ./**", () => {
    const yaml = `
bash:
  find:
    cmd: "./**"
    decide: allow
`;
    withYamlFixtures(null, yaml, (rules) => {
        const projectDir = process.env["CLAUDE_PROJECT_DIR"]!;
        const projectEnv = makeEnv(projectDir, true, {});
        expect(decide(rules[0], makeCommand("find", "/etc/passwd"), projectEnv)).toBe("abstain");
    });
});

test("matchesCmd path-aware: string-glob pattern foo-* still matches arg foo-1 (no regression)", () => {
    const yaml = `
bash:
  custom:
    cmd: "foo-*"
    decide: allow
`;
    withYamlFixtures(null, yaml, (rules) => {
        expect(decide(rules[0], makeCommand("custom", "foo-1"))).toBe("allow");
    });
});

test("matchesCmd path-aware: project root itself matches ./** (base dir included)", () => {
    const yaml = `
bash:
  find:
    cmd: "./**"
    decide: allow
`;
    withYamlFixtures(null, yaml, (rules) => {
        const projectDir = process.env["CLAUDE_PROJECT_DIR"]!;
        const rootEnv = makeEnv(projectDir, true, {});
        // arg "." resolves to projectDir itself; matchesPathGlob includes base dir
        expect(decide(rules[0], makeCommand("find", "."), rootEnv)).toBe("allow");
    });
});

// ---------------------------------------------------------------------------
// aggregateOutcomes
// ---------------------------------------------------------------------------

test("aggregateOutcomes: deny beats ask", () => {
    const deny: IRuleOutcome = { decision: { action: "deny" } };
    const ask: IRuleOutcome = { decision: { action: "ask" } };
    expect(aggregateOutcomes(deny, ask).decision.action).toBe("deny");
    expect(aggregateOutcomes(ask, deny).decision.action).toBe("deny");
});

test("aggregateOutcomes: deny beats allow", () => {
    const deny: IRuleOutcome = { decision: { action: "deny" } };
    const allow: IRuleOutcome = { decision: { action: "allow" } };
    expect(aggregateOutcomes(deny, allow).decision.action).toBe("deny");
    expect(aggregateOutcomes(allow, deny).decision.action).toBe("deny");
});

test("aggregateOutcomes: deny beats abstain", () => {
    const deny: IRuleOutcome = { decision: { action: "deny" } };
    const abstain: IRuleOutcome = { decision: { action: "abstain" } };
    expect(aggregateOutcomes(deny, abstain).decision.action).toBe("deny");
    expect(aggregateOutcomes(abstain, deny).decision.action).toBe("deny");
});

test("aggregateOutcomes: ask beats allow", () => {
    const ask: IRuleOutcome = { decision: { action: "ask" } };
    const allow: IRuleOutcome = { decision: { action: "allow" } };
    expect(aggregateOutcomes(ask, allow).decision.action).toBe("ask");
    expect(aggregateOutcomes(allow, ask).decision.action).toBe("ask");
});

test("aggregateOutcomes: ask beats abstain", () => {
    const ask: IRuleOutcome = { decision: { action: "ask" } };
    const abstain: IRuleOutcome = { decision: { action: "abstain" } };
    expect(aggregateOutcomes(ask, abstain).decision.action).toBe("ask");
    expect(aggregateOutcomes(abstain, ask).decision.action).toBe("ask");
});

test("aggregateOutcomes: allow beats abstain", () => {
    const allow: IRuleOutcome = { decision: { action: "allow" } };
    const abstain: IRuleOutcome = { decision: { action: "abstain" } };
    expect(aggregateOutcomes(allow, abstain).decision.action).toBe("allow");
    expect(aggregateOutcomes(abstain, allow).decision.action).toBe("allow");
});

test("aggregateOutcomes: abstain + abstain → abstain", () => {
    const abstain: IRuleOutcome = { decision: { action: "abstain" } };
    expect(aggregateOutcomes(abstain, abstain).decision.action).toBe("abstain");
});

// ---------------------------------------------------------------------------
// buildBashScopedRule
// ---------------------------------------------------------------------------

test("buildBashScopedRule: parent env no match → ABSTAIN", () => {
    const entry: IYamlEntry = {
        env: { AWS_PROFILE: "sandbox" },
        rules: [{ decide: "deny" }],
    };
    const rule = buildBashScopedRule("aws", [], entry);
    const node = makeCommand("aws", ["ec2", "delete-vpc"]);
    const env = makeEnv("/project", true, { AWS_PROFILE: "prod" });
    expect(rule(node, env, dummyCall).decision.action).toBe("abstain");
});

test("buildBashScopedRule: empty rules list, parent matches → ABSTAIN", () => {
    const entry: IYamlEntry = {
        env: { AWS_PROFILE: "prod" },
        rules: [],
    };
    const rule = buildBashScopedRule("aws", [], entry);
    const node = makeCommand("aws", ["ec2", "delete-vpc"]);
    const env = makeEnv("/project", true, { AWS_PROFILE: "prod" });
    expect(rule(node, env, dummyCall).decision.action).toBe("abstain");
});

test("buildBashScopedRule: 1 deny sub-rule, parent env matches → deny", () => {
    const entry: IYamlEntry = {
        env: { AWS_PROFILE: "/^(?!sandbox$)/" },
        rules: [{ cmd: "* delete-*", decide: "deny" }],
    };
    const rule = buildBashScopedRule("aws", [], entry);
    const node = makeCommand("aws", ["ec2", "delete-vpc"]);
    const env = makeEnv("/project", true, { AWS_PROFILE: "prod" });
    expect(rule(node, env, dummyCall).decision.action).toBe("deny");
});

test("buildBashScopedRule: allow+ask+deny sub-rules all match → deny wins", () => {
    const entry: IYamlEntry = {
        rules: [
            { cmd: "s3 ls", decide: "allow" },
            { decide: "ask" },
            { cmd: "* delete-*", decide: "deny" },
        ],
    };
    const rule = buildBashScopedRule("aws", [], entry);
    const node = makeCommand("aws", ["ec2", "delete-vpc"]);
    expect(rule(node, makeEnv(), dummyCall).decision.action).toBe("deny");
});

test("buildBashScopedRule: multi-level nesting, innermost deny → deny", () => {
    const yaml = `
bash:
  aws:
    - env:
        AWS_PROFILE: "/^(?!sandbox$)/"
      rules:
        - env:
            AWS_REGION: us-east-1
          rules:
            - cmd: "* delete-*"
              decide: deny
            - decide: ask
`;
    withYamlFixtures(null, yaml, (rules) => {
        const env = makeEnv("/project", true, { AWS_PROFILE: "prod", AWS_REGION: "us-east-1" });
        const node = makeCommand("aws", ["ec2", "delete-vpc"]);
        const actions = rules.map((rule) => rule(node, env, dummyCall).decision.action);
        expect(actions).toContain("deny");
        expect(actions).not.toContain("allow");
    });
});

test("buildBashScopedRule: multi-level, inner env no-match → outer catch-all ask fires", () => {
    const yaml = `
bash:
  aws:
    - env:
        AWS_PROFILE: "/^(?!sandbox$)/"
      rules:
        - env:
            AWS_REGION: us-east-1
          rules:
            - cmd: "* delete-*"
              decide: deny
        - decide: ask
`;
    withYamlFixtures(null, yaml, (rules) => {
        const env = makeEnv("/project", true, { AWS_PROFILE: "prod", AWS_REGION: "eu-west-1" });
        const node = makeCommand("aws", ["ec2", "delete-vpc"]);
        const nonAbstain = rules
            .map((rule) => rule(node, env, dummyCall).decision.action)
            .filter((action) => action !== "abstain");
        expect(nonAbstain).toContain("ask");
        expect(nonAbstain).not.toContain("deny");
    });
});

// ---------------------------------------------------------------------------
// buildFileScopedRule
// ---------------------------------------------------------------------------

test("buildFileScopedRule: parent cwd match + sub-rule path match → deny", () => {
    const entry: IYamlEntry = {
        cwd: "/projects/production/**",
        rules: [{ path: "**/.env", decide: "deny" }],
    };
    const rule = buildFileScopedRule("write", entry);
    const node: AstNode = { type: "write", file_path: "/projects/production/app/.env", content: "" };
    const env = makeEnv("/projects/production/app");
    expect(rule(node, env, dummyCall).decision.action).toBe("deny");
});

test("buildFileScopedRule: parent cwd no-match → ABSTAIN", () => {
    const entry: IYamlEntry = {
        cwd: "/projects/production/**",
        rules: [{ path: "**/.env", decide: "deny" }],
    };
    const rule = buildFileScopedRule("write", entry);
    const node: AstNode = { type: "write", file_path: "/projects/staging/app/.env", content: "" };
    const env = makeEnv("/projects/staging/app");
    expect(rule(node, env, dummyCall).decision.action).toBe("abstain");
});

// ---------------------------------------------------------------------------
// resolveEntryCwdPatterns: rules: sub-entries
// ---------------------------------------------------------------------------

test("resolveEntryCwdPatterns: ./relative cwd inside rules: block is resolved", () => {
    const entry: IYamlEntry = {
        rules: [{ cwd: "./src", decide: "deny" }],
    };
    resolveEntryCwdPatterns(entry, "/base");
    expect(entry.rules![0].cwd).toBe("/base/src");
});

// ---------------------------------------------------------------------------
// notFieldsAllMatch: direct unit tests
// ---------------------------------------------------------------------------

test("notFieldsAllMatch: env field matches → true", () => {
    const not: INotFields = { env: { AWS_PROFILE: "sandbox" } };
    const node = makeCommand("aws", []);
    const env = makeEnv("/project", true, { AWS_PROFILE: "sandbox" });
    expect(notFieldsAllMatch(not, node, env, 0)).toBe(true);
});

test("notFieldsAllMatch: env field does not match → false", () => {
    const not: INotFields = { env: { AWS_PROFILE: "sandbox" } };
    const node = makeCommand("aws", []);
    const env = makeEnv("/project", true, { AWS_PROFILE: "prod" });
    expect(notFieldsAllMatch(not, node, env, 0)).toBe(false);
});

test("notFieldsAllMatch: cmd field matches → true", () => {
    const not: INotFields = { cmd: "ls" };
    const node = makeCommand("bash", ["ls"]);
    const env = makeEnv();
    expect(notFieldsAllMatch(not, node, env, 0)).toBe(true);
});

test("notFieldsAllMatch: cmd field does not match → false", () => {
    const not: INotFields = { cmd: "ls" };
    const node = makeCommand("bash", ["rm"]);
    const env = makeEnv();
    expect(notFieldsAllMatch(not, node, env, 0)).toBe(false);
});

test("notFieldsAllMatch: multiple fields, all match → true", () => {
    const not: INotFields = { cmd: "delete-*", env: { ENV: "prod" } };
    const node = makeCommand("aws", ["delete-bucket"]);
    const env = makeEnv("/project", true, { ENV: "prod" });
    expect(notFieldsAllMatch(not, node, env, 0)).toBe(true);
});

test("notFieldsAllMatch: multiple fields, one does not match → false", () => {
    const not: INotFields = { cmd: "delete-*", env: { ENV: "prod" } };
    const node = makeCommand("aws", ["delete-bucket"]);
    const env = makeEnv("/project", true, { ENV: "dev" });
    expect(notFieldsAllMatch(not, node, env, 0)).toBe(false);
});

test("notFieldsAllMatch: no fields set → true (empty not: always matches)", () => {
    const not: INotFields = {};
    const node = makeCommand("aws", ["anything"]);
    const env = makeEnv();
    expect(notFieldsAllMatch(not, node, env, 0)).toBe(true);
});

// ---------------------------------------------------------------------------
// not: in bash rules
// ---------------------------------------------------------------------------

test("bash rule not: env: — env matches → ABSTAIN (rule suppressed)", () => {
    const yaml = `
bash:
  aws:
    decide: deny
    not:
      env:
        AWS_PROFILE: sandbox
`;
    withYamlFixtures(null, yaml, (rules) => {
        const node = makeCommand("aws", ["ec2", "delete-vpc"]);
        const sandboxEnv = makeEnv("/project", true, { AWS_PROFILE: "sandbox" });
        expect(decide(rules[0], node, sandboxEnv)).toBe("abstain");
    });
});

test("bash rule not: env: — env does not match → rule fires (deny)", () => {
    const yaml = `
bash:
  aws:
    decide: deny
    not:
      env:
        AWS_PROFILE: sandbox
`;
    withYamlFixtures(null, yaml, (rules) => {
        const node = makeCommand("aws", ["ec2", "delete-vpc"]);
        const prodEnv = makeEnv("/project", true, { AWS_PROFILE: "prod" });
        expect(decide(rules[0], node, prodEnv)).toBe("deny");
    });
});

test("bash rule not: cmd: — cmd matches → ABSTAIN", () => {
    const yaml = `
bash:
  aws:
    decide: deny
    not:
      cmd: "s3 ls"
`;
    withYamlFixtures(null, yaml, (rules) => {
        const node = makeCommand("aws", ["s3", "ls"]);
        expect(decide(rules[0], node)).toBe("abstain");
    });
});

test("bash rule not: cmd: — cmd does not match → rule fires", () => {
    const yaml = `
bash:
  aws:
    decide: deny
    not:
      cmd: "s3 ls"
`;
    withYamlFixtures(null, yaml, (rules) => {
        const node = makeCommand("aws", ["ec2", "describe-instances"]);
        expect(decide(rules[0], node)).toBe("deny");
    });
});

test("bash rule not: combined cmd and env — both match → ABSTAIN", () => {
    const yaml = `
bash:
  aws:
    decide: deny
    not:
      cmd: "s3 ls"
      env:
        AWS_PROFILE: sandbox
`;
    withYamlFixtures(null, yaml, (rules) => {
        const node = makeCommand("aws", ["s3", "ls"]);
        const sandboxEnv = makeEnv("/project", true, { AWS_PROFILE: "sandbox" });
        expect(decide(rules[0], node, sandboxEnv)).toBe("abstain");
    });
});

test("bash rule not: combined cmd and env — only cmd matches → rule fires", () => {
    const yaml = `
bash:
  aws:
    decide: deny
    not:
      cmd: "s3 ls"
      env:
        AWS_PROFILE: sandbox
`;
    withYamlFixtures(null, yaml, (rules) => {
        const node = makeCommand("aws", ["s3", "ls"]);
        const prodEnv = makeEnv("/project", true, { AWS_PROFILE: "prod" });
        expect(decide(rules[0], node, prodEnv)).toBe("deny");
    });
});

// ---------------------------------------------------------------------------
// not: in file tool rules
// ---------------------------------------------------------------------------

test("read rule not: env: matching → ABSTAIN (rule suppressed)", () => {
    const yaml = `
read:
  path: "**"
  decide: deny
  not:
    env:
      AWS_PROFILE: sandbox
`;
    withYamlFixtures(null, yaml, (rules) => {
        const node: AstNode = { type: "read", file_path: "/project/file.ts" };
        const sandboxEnv = makeEnv("/project", true, { AWS_PROFILE: "sandbox" });
        expect(decide(rules[0], node, sandboxEnv)).toBe("abstain");
    });
});

test("read rule not: env: not matching → rule fires", () => {
    const yaml = `
read:
  path: "**"
  decide: deny
  not:
    env:
      AWS_PROFILE: sandbox
`;
    withYamlFixtures(null, yaml, (rules) => {
        const node: AstNode = { type: "read", file_path: "/project/file.ts" };
        const prodEnv = makeEnv("/project", true, { AWS_PROFILE: "prod" });
        expect(decide(rules[0], node, prodEnv)).toBe("deny");
    });
});

// ---------------------------------------------------------------------------
// not: in webfetch rules
// ---------------------------------------------------------------------------

test("webfetch rule not: env: matching → ABSTAIN", () => {
    const yaml = `
webfetch:
  decide: deny
  not:
    env:
      DEPLOY_ENV: prod
`;
    withYamlFixtures(null, yaml, (rules) => {
        const node: AstNode = { type: "other", tool_name: "WebFetch", tool_input: { url: "https://example.com" } };
        const prodEnv = makeEnv("/project", true, { DEPLOY_ENV: "prod" });
        expect(decide(rules[0], node, prodEnv)).toBe("abstain");
    });
});

// ---------------------------------------------------------------------------
// not: in tool-name rules
// ---------------------------------------------------------------------------

test("tool-name rule not: env: matching ABSTAIN", () => {
    const yaml = `
"*":
  decide: deny
  not:
    env:
      SAFE_MODE: "true"
`;
    withYamlFixtures(null, yaml, (rules) => {
        const node: AstNode = { type: "other", tool_name: "mcp__server__action", tool_input: {} };
        const safeEnv = makeEnv("/project", true, { SAFE_MODE: "true" });
        expect(decide(rules[0], node, safeEnv)).toBe("abstain");
    });
});

// ---------------------------------------------------------------------------
// evaluateFileField: direct unit tests
// ---------------------------------------------------------------------------

// Creates a temp directory, invokes callback with its path, then removes it.
function withTempDir(callback: (dir: string) => void): void {
    const dir = mkdtempSync(join(tmpdir(), "claude-file-test-"));
    try {
        callback(dir);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

test("evaluateFileField: file absent → file-absent", () => {
    const result = evaluateFileField({ "/nonexistent-path-xyz/file.txt": { contains: "anything" } });
    expect(result).toBe("file-absent");
});

test("evaluateFileField: value true, file exists → match (existence-only check)", () => {
    withTempDir((dir) => {
        const filePath = join(dir, "test.txt");
        writeFileSync(filePath, "some content", "utf-8");
        const result = evaluateFileField({ [filePath]: true });
        expect(result).toBe("match");
    });
});

test("evaluateFileField: value IFileMatch, file exists, contains matches → match", () => {
    withTempDir((dir) => {
        const filePath = join(dir, "kube.yaml");
        writeFileSync(filePath, "current-context: sandbox\nclusters: []", "utf-8");
        const result = evaluateFileField({ [filePath]: { contains: "current-context: sandbox" } });
        expect(result).toBe("match");
    });
});

test("evaluateFileField: value IFileMatch, file exists, contains does not match → no-match", () => {
    withTempDir((dir) => {
        const filePath = join(dir, "kube.yaml");
        writeFileSync(filePath, "current-context: production\nclusters: []", "utf-8");
        const result = evaluateFileField({ [filePath]: { contains: "current-context: sandbox" } });
        expect(result).toBe("no-match");
    });
});

test("evaluateFileField: ~ in path is expanded (absolute path check passes as a proxy)", () => {
    withTempDir((dir) => {
        const filePath = join(dir, "config.txt");
        writeFileSync(filePath, "hello", "utf-8");
        expect(evaluateFileField({ [filePath]: { contains: "hello" } })).toBe("match");
    });
});

test("evaluateFileField: relative path is resolved against CLAUDE_PROJECT_DIR", () => {
    withTempDir((dir) => {
        writeFileSync(join(dir, "context.txt"), "current-context: sandbox", "utf-8");
        const origProjectDir = process.env["CLAUDE_PROJECT_DIR"];
        process.env["CLAUDE_PROJECT_DIR"] = dir;
        try {
            expect(evaluateFileField({ "context.txt": { contains: "sandbox" } })).toBe("match");
            expect(evaluateFileField({ "context.txt": { contains: "prod" } })).toBe("no-match");
            expect(evaluateFileField({ "missing.txt": { contains: "x" } })).toBe("file-absent");
        } finally {
            if (origProjectDir === undefined) {
                delete process.env["CLAUDE_PROJECT_DIR"];
            } else {
                process.env["CLAUDE_PROJECT_DIR"] = origProjectDir;
            }
        }
    });
});

// ---------------------------------------------------------------------------
// matchesFileField: direct unit tests
// ---------------------------------------------------------------------------

test("matchesFileField: no file field on entry → true", () => {
    const entry: IYamlEntry = { decide: "allow" };
    expect(matchesFileField(entry)).toBe(true);
});

test("matchesFileField: file exists and contains matches → true", () => {
    withTempDir((dir) => {
        const filePath = join(dir, "kubeconfig");
        writeFileSync(filePath, "current-context: sandbox", "utf-8");
        const entry: IYamlEntry = { decide: "allow", file: { [filePath]: { contains: "sandbox" } } };
        expect(matchesFileField(entry)).toBe(true);
    });
});

test("matchesFileField: file absent → false", () => {
    const entry: IYamlEntry = { decide: "allow", file: { "/no/such/file.txt": { contains: "x" } } };
    expect(matchesFileField(entry)).toBe(false);
});

test("matchesFileField: file exists, contains does not match → false", () => {
    withTempDir((dir) => {
        const filePath = join(dir, "kubeconfig");
        writeFileSync(filePath, "current-context: prod", "utf-8");
        const entry: IYamlEntry = { decide: "allow", file: { [filePath]: { contains: "sandbox" } } };
        expect(matchesFileField(entry)).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// notFieldsAllMatch with file
// ---------------------------------------------------------------------------

test("notConditionsAllMatch with file: file absent → true (suppresses not: block)", () => {
    const not: INotFields = { file: { "/no/such/file.txt": { contains: "sandbox" } } };
    const node = makeCommand("kubectl", ["delete", "pod"]);
    expect(notFieldsAllMatch(not, node, makeEnv(), 0)).toBe(true);
});

test("notConditionsAllMatch with file: file exists + contains matches → true", () => {
    withTempDir((dir) => {
        const filePath = join(dir, "kubeconfig");
        writeFileSync(filePath, "current-context: sandbox", "utf-8");
        const not: INotFields = { file: { [filePath]: { contains: "sandbox" } } };
        const node = makeCommand("kubectl", ["delete", "pod"]);
        expect(notFieldsAllMatch(not, node, makeEnv(), 0)).toBe(true);
    });
});

test("notConditionsAllMatch with file: file exists + contains does not match → false", () => {
    withTempDir((dir) => {
        const filePath = join(dir, "kubeconfig");
        writeFileSync(filePath, "current-context: prod", "utf-8");
        const not: INotFields = { file: { [filePath]: { contains: "sandbox" } } };
        const node = makeCommand("kubectl", ["delete", "pod"]);
        expect(notFieldsAllMatch(not, node, makeEnv(), 0)).toBe(false);
    });
});

test("notConditionsAllMatch with file + env: file matches + env matches → true", () => {
    withTempDir((dir) => {
        const filePath = join(dir, "kubeconfig");
        writeFileSync(filePath, "current-context: sandbox", "utf-8");
        const not: INotFields = { file: { [filePath]: { contains: "sandbox" } }, env: { KUBE_CONTEXT: "sandbox" } };
        const node = makeCommand("kubectl", ["delete", "pod"]);
        const env = makeEnv("/project", true, { KUBE_CONTEXT: "sandbox" });
        expect(notFieldsAllMatch(not, node, env, 0)).toBe(true);
    });
});

test("notConditionsAllMatch with file + env: file matches + env does not match → false", () => {
    withTempDir((dir) => {
        const filePath = join(dir, "kubeconfig");
        writeFileSync(filePath, "current-context: sandbox", "utf-8");
        const not: INotFields = { file: { [filePath]: { contains: "sandbox" } }, env: { KUBE_CONTEXT: "prod" } };
        const node = makeCommand("kubectl", ["delete", "pod"]);
        const env = makeEnv("/project", true, { KUBE_CONTEXT: "sandbox" });
        expect(notFieldsAllMatch(not, node, env, 0)).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// Bash rule: direct file: field integration
// ---------------------------------------------------------------------------

test("bash rule file: contains — file contains string → rule fires (allow)", () => {
    withTempDir((dir) => {
        const filePath = join(dir, "kube.yaml");
        writeFileSync(filePath, "current-context: sandbox", "utf-8");
        const yaml = `
bash:
  kubectl:
    file:
      ${filePath}:
        contains: "current-context: sandbox"
    decide: allow
`;
        withYamlFixtures(null, yaml, (rules) => {
            const node = makeCommand("kubectl", ["delete", "pod"]);
            expect(decide(rules[0], node)).toBe("allow");
        });
    });
});

test("bash rule file: contains — file does not contain string → ABSTAIN", () => {
    withTempDir((dir) => {
        const filePath = join(dir, "kube.yaml");
        writeFileSync(filePath, "current-context: prod", "utf-8");
        const yaml = `
bash:
  kubectl:
    file:
      ${filePath}:
        contains: "current-context: sandbox"
    decide: allow
`;
        withYamlFixtures(null, yaml, (rules) => {
            const node = makeCommand("kubectl", ["delete", "pod"]);
            expect(decide(rules[0], node)).toBe("abstain");
        });
    });
});

test("bash rule file: contains — file absent → ABSTAIN", () => {
    const yaml = `
bash:
  kubectl:
    file:
      /no/such/kube.yaml:
        contains: "current-context: sandbox"
    decide: allow
`;
    withYamlFixtures(null, yaml, (rules) => {
        const node = makeCommand("kubectl", ["delete", "pod"]);
        expect(decide(rules[0], node)).toBe("abstain");
    });
});

test("bash rule not: file: contains — file absent → ABSTAIN (neither fires)", () => {
    const yaml = `
bash:
  kubectl:
    not:
      file:
        /no/such/kube.yaml:
          contains: "current-context: sandbox"
    decide: deny
`;
    withYamlFixtures(null, yaml, (rules) => {
        const node = makeCommand("kubectl", ["delete", "pod"]);
        expect(decide(rules[0], node)).toBe("abstain");
    });
});

test("bash rule not: file: contains — file exists and matches → ABSTAIN (not: suppressed)", () => {
    withTempDir((dir) => {
        const filePath = join(dir, "kube.yaml");
        writeFileSync(filePath, "current-context: sandbox", "utf-8");
        const yaml = `
bash:
  kubectl:
    not:
      file:
        ${filePath}:
          contains: "current-context: sandbox"
    decide: deny
`;
        withYamlFixtures(null, yaml, (rules) => {
            const node = makeCommand("kubectl", ["delete", "pod"]);
            expect(decide(rules[0], node)).toBe("abstain");
        });
    });
});

test("bash rule not: file: contains — file exists, does not match → rule fires (deny)", () => {
    withTempDir((dir) => {
        const filePath = join(dir, "kube.yaml");
        writeFileSync(filePath, "current-context: prod", "utf-8");
        const yaml = `
bash:
  kubectl:
    not:
      file:
        ${filePath}:
          contains: "current-context: sandbox"
    decide: deny
`;
        withYamlFixtures(null, yaml, (rules) => {
            const node = makeCommand("kubectl", ["delete", "pod"]);
            expect(decide(rules[0], node)).toBe("deny");
        });
    });
});

// ---------------------------------------------------------------------------
// File tool rule: direct file: field integration
// ---------------------------------------------------------------------------

test("read rule file: matching → rule fires (allow)", () => {
    withTempDir((dir) => {
        const filePath = join(dir, "context.txt");
        writeFileSync(filePath, "env: sandbox", "utf-8");
        const yaml = `
read:
  path: "**"
  file:
    ${filePath}:
      contains: "sandbox"
  decide: allow
`;
        withYamlFixtures(null, yaml, (rules) => {
            const node: AstNode = { type: "read", file_path: "/project/src/index.ts" };
            expect(decide(rules[0], node)).toBe("allow");
        });
    });
});

test("read rule file: not matching → ABSTAIN", () => {
    withTempDir((dir) => {
        const filePath = join(dir, "context.txt");
        writeFileSync(filePath, "env: production", "utf-8");
        const yaml = `
read:
  path: "**"
  file:
    ${filePath}:
      contains: "sandbox"
  decide: allow
`;
        withYamlFixtures(null, yaml, (rules) => {
            const node: AstNode = { type: "read", file_path: "/project/src/index.ts" };
            expect(decide(rules[0], node)).toBe("abstain");
        });
    });
});

// ---------------------------------------------------------------------------
// WebFetch rule: direct file: field integration
// ---------------------------------------------------------------------------

test("webfetch rule file: matching → rule fires (allow)", () => {
    withTempDir((dir) => {
        const filePath = join(dir, "context.txt");
        writeFileSync(filePath, "env: sandbox", "utf-8");
        const yaml = `
webfetch:
  file:
    ${filePath}:
      contains: "sandbox"
  decide: allow
`;
        withYamlFixtures(null, yaml, (rules) => {
            const node: AstNode = { type: "other", tool_name: "WebFetch", tool_input: { url: "https://example.com" } };
            expect(decide(rules[0], node)).toBe("allow");
        });
    });
});

// ---------------------------------------------------------------------------
// validateConfig
// ---------------------------------------------------------------------------

test("validateConfig: valid bash entry returns no errors", () => {
    const config: IYamlConfig = {
        bash: { ls: { decide: "allow", reason: "read-only" } },
    };
    expect(validateConfig(config)).toHaveLength(0);
});

test("validateConfig: invalid decide value reports error with path and value", () => {
    const config = {
        bash: { ls: { decide: "block", reason: "test" } },
    } as IYamlConfig;
    const errors = validateConfig(config);
    expect(errors).toHaveLength(1);
    expect(errors[0].path).toBe("bash.ls[0].decide");
    expect(errors[0].message).toContain("block");
    expect(errors[0].message).toContain("allow");
});

test("validateConfig: decide and rules both set reports error", () => {
    const config: IYamlConfig = {
        bash: { ls: { decide: "allow", rules: [{ decide: "deny" }] } },
    };
    const errors = validateConfig(config);
    expect(errors.some((error: IConfigError) => error.message.includes("mutually exclusive"))).toBe(true);
});

test("validateConfig: entry with no decide, rules, or subcommands reports error", () => {
    const config: IYamlConfig = {
        bash: { ls: { reason: "no decision here" } },
    };
    const errors = validateConfig(config);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("abstain");
});

test("validateConfig: subcommand-only entry (no decide/rules) does not report error", () => {
    const config: IYamlConfig = {
        bash: { git: { log: { decide: "allow" } } },
    };
    expect(validateConfig(config)).toHaveLength(0);
});

test("validateConfig: primitive string as subcommand value reports error", () => {
    const config = {
        bash: { git: { remote: "allow" } },
    } as IYamlConfig;
    const errors = validateConfig(config);
    expect(errors.some((error: IConfigError) => error.path.includes("remote"))).toBe(true);
    expect(errors.some((error: IConfigError) => error.message.includes("string"))).toBe(true);
});

test("validateConfig: array of primitive strings as subcommand value (args:[v] bug) reports error per item", () => {
    const config = {
        bash: { git: { args: ["v"] } },
    } as IYamlConfig;
    const errors = validateConfig(config);
    expect(errors.some((error: IConfigError) => error.path.includes("args[0]"))).toBe(true);
    expect(errors.some((error: IConfigError) => error.message.includes("string"))).toBe(true);
});

test("validateConfig: invalid decide in nested subcommand reports full path", () => {
    const config = {
        bash: { git: { log: { decide: "permit" } } },
    } as IYamlConfig;
    const errors = validateConfig(config);
    expect(errors).toHaveLength(1);
    expect(errors[0].path).toBe("bash.git[0].log.decide");
    expect(errors[0].message).toContain("permit");
});

test("validateConfig: invalid decide in rules sub-entry reports path including rules index", () => {
    const config = {
        bash: { ls: { rules: [{ decide: "nope" }] } },
    } as IYamlConfig;
    const errors = validateConfig(config);
    expect(errors.some((error: IConfigError) => error.path.includes("rules[0].decide"))).toBe(true);
});

test("validateConfig: invalid decide in read section reports error", () => {
    const config = {
        read: { decide: "grant", path: "/tmp/**" },
    } as IYamlConfig;
    const errors = validateConfig(config);
    expect(errors).toHaveLength(1);
    expect(errors[0].path).toContain("read");
    expect(errors[0].message).toContain("grant");
});

test("validateConfig: invalid decide in top-level tool-name rule reports error", () => {
    const config = {
        SomeTool: { decide: "nope" },
    } as IYamlConfig & { SomeTool: IYamlEntry };
    const errors = validateConfig(config);
    expect(errors).toHaveLength(1);
    expect(errors[0].path).toContain("SomeTool");
    expect(errors[0].message).toContain("nope");
});

test("validateConfig: multiple errors in one config are all reported", () => {
    const config = {
        bash: {
            ls: { decide: "bad1" },
            cat: { decide: "bad2" },
        },
    } as IYamlConfig;
    const errors = validateConfig(config);
    expect(errors).toHaveLength(2);
    expect(errors.some((error: IConfigError) => error.message.includes("bad1"))).toBe(true);
    expect(errors.some((error: IConfigError) => error.message.includes("bad2"))).toBe(true);
});

test("validateConfig: empty config returns no errors", () => {
    expect(validateConfig({})).toHaveLength(0);
});

test("loadConfigRules: config with invalid decide writes [CONFIG ERROR] to stderr", () => {
    const stderrWrites: string[] = [];
    const stderrSpy = jest.spyOn(process.stderr, "write").mockImplementation((chunk) => {
        stderrWrites.push(String(chunk));
        return true;
    });
    try {
        withYamlFixtures(
            `bash:\n  ls:\n    decide: block`,
            null,
            () => {},
        );
        expect(stderrWrites.join("")).toContain("[CONFIG ERROR]");
        expect(stderrWrites.join("")).toContain("block");
    }
    finally {
        stderrSpy.mockRestore();
    }
});

test("lineOfOffset returns 1 for offset 0", () => {
    expect(lineOfOffset("hello\nworld", 0)).toBe(1);
});

test("lineOfOffset returns 1 for offset within first line", () => {
    expect(lineOfOffset("hello\nworld", 4)).toBe(1);
});

test("lineOfOffset returns 2 for offset on second line", () => {
    expect(lineOfOffset("hello\nworld", 6)).toBe(2);
});

test("lineOfOffset returns 3 for offset on third line", () => {
    expect(lineOfOffset("a\nb\nc", 4)).toBe(3);
});

test("annotateLines stamps sourceLine on entry with decide key", () => {
    const source = "bash:\n  git:\n    decide: allow\n";
    const doc = parseDocument(source);
    const config: IYamlConfig = doc.toJS();
    annotateLines(doc.contents, config, source, ".claude/permissions.yaml");
    const bashSection = config.bash as Record<string, IYamlEntry>;
    expect(bashSection["git"].sourceLine).toBe(3);
    expect(bashSection["git"].sourceFile).toBe(".claude/permissions.yaml");
});

test("annotateLines stamps correct line for second binary", () => {
    const source = "bash:\n  git:\n    decide: allow\n  echo:\n    decide: allow\n";
    const doc = parseDocument(source);
    const config: IYamlConfig = doc.toJS();
    annotateLines(doc.contents, config, source, ".claude/permissions.yaml");
    const bashSection = config.bash as Record<string, IYamlEntry>;
    expect(bashSection["git"].sourceLine).toBe(3);
    expect(bashSection["echo"].sourceLine).toBe(5);
});

test("annotateLines stamps correct line for nested subcommand entry", () => {
    const source = "bash:\n  git:\n    diff:\n      decide: allow\n";
    const doc = parseDocument(source);
    const config: IYamlConfig = doc.toJS();
    annotateLines(doc.contents, config, source, ".claude/permissions.yaml");
    const bashSection = config.bash as Record<string, IYamlEntry>;
    const gitEntry: IYamlEntry = bashSection["git"];
    const diffEntry: IYamlEntry = gitEntry["diff"] as IYamlEntry;
    expect(diffEntry.sourceLine).toBe(4);
});

// ---------------------------------------------------------------------------
// loadConfigRulesFromFile
// ---------------------------------------------------------------------------

test("loadConfigRulesFromFile: returns [] when file does not exist", () => {
    const result = loadConfigRulesFromFile("/nonexistent/permissions.yaml", "test", "/nonexistent");
    expect(result).toEqual([]);
});

test("loadConfigRulesFromFile: compiles rules from an existing file", () => {
    const tmpDir = join("/tmp", `load-config-file-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    const filePath = join(tmpDir, "permissions.yaml");
    writeFileSync(filePath, "bash:\n  ls:\n    decide: allow\n", "utf-8");
    const rules = loadConfigRulesFromFile(filePath, "test.yaml", tmpDir);
    expect(rules.length).toBeGreaterThan(0);
    const node = { type: "command" as const, binary: "ls", options: {}, cmd: [], envPrefix: {}, redirects: [], raw: "ls" };
    const env = { cwd: tmpDir, cwdResolved: true, env: {} };
    const call: IToolCall = { tool_name: "Bash", tool_input: { command: "ls" }, cwd: tmpDir };
    const result = rules[0](node, env, call);
    expect(result.decision.action).toBe("allow");
    rmSync(tmpDir, { recursive: true, force: true });
});

test("loadConfigRulesFromFile: ${{PROJECT_DIR}} token in cmd is expanded and matches", () => {
    const origProject = process.env["CLAUDE_PROJECT_DIR"];
    const tmpDir = join("/tmp", `load-config-token-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    process.env["CLAUDE_PROJECT_DIR"] = tmpDir;
    const filePath = join(tmpDir, "permissions.yaml");
    const TOK = "${{PROJECT_DIR}}";
    writeFileSync(filePath, `bash:\n  find:\n    cmd: "${TOK}/**"\n    decide: allow\n`, "utf-8");
    const rules = loadConfigRulesFromFile(filePath, "test.yaml", tmpDir);
    const node = { type: "command" as const, binary: "find", options: {}, cmd: [join(tmpDir, "src")], envPrefix: {}, redirects: [], raw: "find" };
    const env = { cwd: tmpDir, cwdResolved: true, env: {} };
    const call: IToolCall = { tool_name: "Bash", tool_input: { command: "find" }, cwd: tmpDir };
    const result = rules[0](node, env, call);
    expect(result.decision.action).toBe("allow");
    rmSync(tmpDir, { recursive: true, force: true });
    if (origProject !== undefined) { process.env["CLAUDE_PROJECT_DIR"] = origProject; }
    else { delete process.env["CLAUDE_PROJECT_DIR"]; }
});

// ---------------------------------------------------------------------------
// loadHomeConfigRules
// ---------------------------------------------------------------------------

test("loadHomeConfigRules: returns [] when HOME is unset", () => {
    const origHome = process.env["HOME"];
    delete process.env["HOME"];
    const result = loadHomeConfigRules();
    if (origHome !== undefined) { process.env["HOME"] = origHome; }
    expect(result).toEqual([]);
});

test("loadHomeConfigRules: returns [] when home permissions.yaml is absent", () => {
    const tmpDir = join("/tmp", `load-home-test-${Date.now()}`);
    mkdirSync(join(tmpDir, ".claude"), { recursive: true });
    const origHome = process.env["HOME"];
    process.env["HOME"] = tmpDir;
    const result = loadHomeConfigRules();
    if (origHome !== undefined) { process.env["HOME"] = origHome; } else { delete process.env["HOME"]; }
    rmSync(tmpDir, { recursive: true, force: true });
    expect(result).toEqual([]);
});

test("loadHomeConfigRules: loads rules from home permissions.yaml", () => {
    const tmpDir = join("/tmp", `load-home-test-${Date.now()}`);
    mkdirSync(join(tmpDir, ".claude"), { recursive: true });
    writeFileSync(join(tmpDir, ".claude", "permissions.yaml"), "bash:\n  cat:\n    decide: allow\n", "utf-8");
    const origHome = process.env["HOME"];
    process.env["HOME"] = tmpDir;
    const rules = loadHomeConfigRules();
    if (origHome !== undefined) { process.env["HOME"] = origHome; } else { delete process.env["HOME"]; }
    rmSync(tmpDir, { recursive: true, force: true });
    expect(rules.length).toBeGreaterThan(0);
});

// ---------------------------------------------------------------------------
// loadProjectConfigRules
// ---------------------------------------------------------------------------

test("loadProjectConfigRules: returns [] when CLAUDE_PROJECT_DIR is unset", () => {
    const origProject = process.env["CLAUDE_PROJECT_DIR"];
    delete process.env["CLAUDE_PROJECT_DIR"];
    const result = loadProjectConfigRules();
    if (origProject !== undefined) { process.env["CLAUDE_PROJECT_DIR"] = origProject; }
    expect(result).toEqual([]);
});

test("loadProjectConfigRules: returns [] when project permissions.yaml is absent", () => {
    const tmpDir = join("/tmp", `load-project-test-${Date.now()}`);
    mkdirSync(join(tmpDir, ".claude"), { recursive: true });
    const origProject = process.env["CLAUDE_PROJECT_DIR"];
    process.env["CLAUDE_PROJECT_DIR"] = tmpDir;
    const result = loadProjectConfigRules();
    if (origProject !== undefined) { process.env["CLAUDE_PROJECT_DIR"] = origProject; } else { delete process.env["CLAUDE_PROJECT_DIR"]; }
    rmSync(tmpDir, { recursive: true, force: true });
    expect(result).toEqual([]);
});

test("loadProjectConfigRules: loads rules from project permissions.yaml", () => {
    const tmpDir = join("/tmp", `load-project-test-${Date.now()}`);
    mkdirSync(join(tmpDir, ".claude"), { recursive: true });
    writeFileSync(join(tmpDir, ".claude", "permissions.yaml"), "bash:\n  ls:\n    decide: deny\n", "utf-8");
    const origProject = process.env["CLAUDE_PROJECT_DIR"];
    process.env["CLAUDE_PROJECT_DIR"] = tmpDir;
    const rules = loadProjectConfigRules();
    if (origProject !== undefined) { process.env["CLAUDE_PROJECT_DIR"] = origProject; } else { delete process.env["CLAUDE_PROJECT_DIR"]; }
    rmSync(tmpDir, { recursive: true, force: true });
    expect(rules.length).toBeGreaterThan(0);
});

// ---------------------------------------------------------------------------
// Top-level tool-name keys (new YAML shape replacing the legacy mcp: section)
// ---------------------------------------------------------------------------

test("top-level tool key: fires for the named tool only", () => {
    const yaml = `
Grep:
  decide: allow
`;
    withYamlFixtures(null, yaml, (rules) => {
        const grepNode: AstNode = { type: "other", tool_name: "Grep", tool_input: {} };
        const agentNode: AstNode = { type: "other", tool_name: "Agent", tool_input: {} };
        expect(decide(rules[0], grepNode)).toBe("allow");
        expect(decide(rules[0], agentNode)).toBe("abstain");
    });
});

test("top-level tool key: explicit tool field replaces the key as matcher; key becomes a label", () => {
    const yaml = `
SomeLabel:
  tool: ToolSearch
  decide: allow
`;
    withYamlFixtures(null, yaml, (rules) => {
        const toolSearchNode: AstNode = { type: "other", tool_name: "ToolSearch", tool_input: {} };
        const labelAsToolNode: AstNode = { type: "other", tool_name: "SomeLabel", tool_input: {} };
        expect(decide(rules[0], toolSearchNode)).toBe("allow");
        expect(decide(rules[0], labelAsToolNode)).toBe("abstain");
    });
});

test("top-level tool key: tool-in field replaces the key as matcher; key becomes a label", () => {
    const yaml = `
my-label:
  tool-in:
    - "ToolA"
    - "ToolB"
  decide: deny
`;
    withYamlFixtures(null, yaml, (rules) => {
        const toolANode: AstNode = { type: "other", tool_name: "ToolA", tool_input: {} };
        const toolBNode: AstNode = { type: "other", tool_name: "ToolB", tool_input: {} };
        const labelNode: AstNode = { type: "other", tool_name: "my-label", tool_input: {} };
        expect(decide(rules[0], toolANode)).toBe("deny");
        expect(decide(rules[0], toolBNode)).toBe("deny");
        expect(decide(rules[0], labelNode)).toBe("abstain");
    });
});

test("top-level tool key: glob in quoted key matches multiple tools end-to-end", () => {
    const yaml = `
"mcp__*__delete_*":
  decide: deny
`;
    withYamlFixtures(null, yaml, (rules) => {
        const deleteNode: AstNode = { type: "other", tool_name: "mcp__files__delete_file", tool_input: {} };
        const otherNode: AstNode = { type: "other", tool_name: "mcp__files__list_directory", tool_input: {} };
        expect(decide(rules[0], deleteNode)).toBe("deny");
        expect(decide(rules[0], otherNode)).toBe("abstain");
    });
});

test("top-level tool key: scoped form with rules: list applies parent key to sub-rules", () => {
    const yaml = `
Grep:
  rules:
    - cwd: "/project/a/**"
      decide: allow
    - cwd: "/project/b/**"
      decide: ask
`;
    withYamlFixtures(null, yaml, (rules) => {
        const grepNode: AstNode = { type: "other", tool_name: "Grep", tool_input: {} };
        const agentNode: AstNode = { type: "other", tool_name: "Agent", tool_input: {} };
        expect(decide(rules[0], grepNode, makeEnv("/project/a/src"))).toBe("allow");
        expect(decide(rules[0], grepNode, makeEnv("/project/b/src"))).toBe("ask");
        expect(decide(rules[0], grepNode, makeEnv("/elsewhere"))).toBe("abstain");
        expect(decide(rules[0], agentNode, makeEnv("/project/a/src"))).toBe("abstain");
    });
});

test("top-level tool key: list form Grep: [..., ...]", () => {
    const yaml = `
Grep:
  - cwd: "/restricted/**"
    decide: deny
  - decide: allow
`;
    withYamlFixtures(null, yaml, (rules) => {
        const grepNode: AstNode = { type: "other", tool_name: "Grep", tool_input: {} };
        expect(rules.length).toBe(2);
        expect(decide(rules[0], grepNode, makeEnv("/restricted/x"))).toBe("deny");
        expect(decide(rules[0], grepNode, makeEnv("/elsewhere"))).toBe("abstain");
        expect(decide(rules[1], grepNode, makeEnv("/elsewhere"))).toBe("allow");
    });
});

test("top-level tool key: differing keys merge across home + project", () => {
    const homeYaml = `
Grep:
  decide: allow
`;
    const projectYaml = `
Agent:
  decide: ask
`;
    withYamlFixtures(homeYaml, projectYaml, (rules) => {
        const grepNode: AstNode = { type: "other", tool_name: "Grep", tool_input: {} };
        const agentNode: AstNode = { type: "other", tool_name: "Agent", tool_input: {} };
        const grepDecisions = rules.map((rule) => rule(grepNode, makeEnv(), dummyCall).decision.action);
        const agentDecisions = rules.map((rule) => rule(agentNode, makeEnv(), dummyCall).decision.action);
        expect(grepDecisions).toContain("allow");
        expect(agentDecisions).toContain("ask");
    });
});

test("top-level tool key: same key in project replaces home", () => {
    const homeYaml = `
Grep:
  decide: ask
`;
    const projectYaml = `
Grep:
  decide: allow
`;
    withYamlFixtures(homeYaml, projectYaml, (rules) => {
        const grepNode: AstNode = { type: "other", tool_name: "Grep", tool_input: {} };
        const decisions = rules.map((rule) => rule(grepNode, makeEnv(), dummyCall).decision.action);
        expect(decisions).toContain("allow");
        expect(decisions).not.toContain("ask");
    });
});

test("top-level tool key: sourceFile/sourceLine annotations propagate", () => {
    const yaml = `Grep:
  decide: allow
`;
    withYamlFixtures(null, yaml, (rules) => {
        expect(rules.length).toBe(1);
        expect(rules[0].ruleFile).toBe(".claude/permissions.yaml");
        expect(rules[0].ruleLine).toBe(2);
    });
});

test("loader rejects top-level KNOWN_FIELDS collision", () => {
    const config = { decide: "allow" } as IYamlConfig & { decide: string };
    const errors = validateConfig(config);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((error: IConfigError) => error.path === "decide" && error.message.includes("reserved rule field"))).toBe(true);
});

test("loader rejects unknown fields under a tool-name entry", () => {
    const config = { Grep: { decide: "allow", bogus_field: 1 } } as IYamlConfig & { Grep: IYamlEntry };
    const errors = validateConfig(config);
    expect(errors.some((error: IConfigError) => error.path.includes("bogus_field") && error.message.includes("unknown field"))).toBe(true);
});

test("bash entry with non-KNOWN_FIELDS key continues to walk it as sub-binary (no regression)", () => {
    const config = { bash: { docker: { compose: { decide: "deny" } } } } as IYamlConfig;
    const errors = validateConfig(config);
    expect(errors.filter((error: IConfigError) => error.message.includes("unknown field"))).toHaveLength(0);
});

test("compileTopLevelToolRules direct unit test: produces rules for tool keys only, not sections", () => {
    const config = {
        bash: { ls: { decide: "allow" } },
        read: { decide: "allow" },
        Grep: { decide: "allow" },
        Agent: { decide: "ask" },
    } as IYamlConfig & { Grep: IYamlEntry; Agent: IYamlEntry };
    const rules = compileTopLevelToolRules(config);
    expect(rules).toHaveLength(2);
    const grepNode: AstNode = { type: "other", tool_name: "Grep", tool_input: {} };
    const agentNode: AstNode = { type: "other", tool_name: "Agent", tool_input: {} };
    const lsNode: AstNode = { type: "command", binary: "ls", options: {}, cmd: [], envPrefix: {}, redirects: [], raw: "ls" };
    const grepActions = rules.map((rule) => rule(grepNode, makeEnv(), dummyCall).decision.action);
    const agentActions = rules.map((rule) => rule(agentNode, makeEnv(), dummyCall).decision.action);
    const lsActions = rules.map((rule) => rule(lsNode, makeEnv(), dummyCall).decision.action);
    expect(grepActions).toContain("allow");
    expect(agentActions).toContain("ask");
    expect(lsActions.every((action: string) => action === "abstain")).toBe(true);
});

// ---------------------------------------------------------------------------
// Layered permissions.d/ discovery
// ---------------------------------------------------------------------------

// makeTempDir creates a unique temp directory and returns its path.
function makeTempDir(prefix: string): string {
    return mkdtempSync(join(tmpdir(), prefix));
}

test("discoverConfigDirFiles: returns [] when directory does not exist", () => {
    const missingPath = join(tmpdir(), `perm-dropin-missing-${Date.now()}`);
    const sources = discoverConfigDirFiles(missingPath, "~/.claude/permissions.d", "/base");
    expect(sources).toEqual([]);
});

test("discoverConfigDirFiles: returns [] when path is a file, not a directory", () => {
    const tmp = makeTempDir("perm-dropin-file-");
    try {
        const filePath = join(tmp, "not-a-dir");
        writeFileSync(filePath, "", "utf-8");
        const sources = discoverConfigDirFiles(filePath, "~/.claude/permissions.d", "/base");
        expect(sources).toEqual([]);
    }
    finally {
        rmSync(tmp, { recursive: true, force: true });
    }
});

test("discoverConfigDirFiles: filters out non-yaml files", () => {
    const tmp = makeTempDir("perm-dropin-filter-");
    try {
        writeFileSync(join(tmp, "aws.yaml"), "", "utf-8");
        writeFileSync(join(tmp, "notes.txt"), "", "utf-8");
        writeFileSync(join(tmp, "README.md"), "", "utf-8");
        const sources = discoverConfigDirFiles(tmp, "~/.claude/permissions.d", "/base");
        const names = sources.map((source: IConfigFileSource) => source.filePath.split("/").pop());
        expect(names).toEqual(["aws.yaml"]);
    }
    finally {
        rmSync(tmp, { recursive: true, force: true });
    }
});

test("discoverConfigDirFiles: ignores dotfiles and subdirectories", () => {
    const tmp = makeTempDir("perm-dropin-dotfile-");
    try {
        writeFileSync(join(tmp, "aws.yaml"), "", "utf-8");
        writeFileSync(join(tmp, ".hidden.yaml"), "", "utf-8");
        mkdirSync(join(tmp, "subdir.yaml"), { recursive: true });
        const sources = discoverConfigDirFiles(tmp, "~/.claude/permissions.d", "/base");
        const names = sources.map((source: IConfigFileSource) => source.filePath.split("/").pop());
        expect(names).toEqual(["aws.yaml"]);
    }
    finally {
        rmSync(tmp, { recursive: true, force: true });
    }
});

test("discoverConfigDirFiles: includes .yml files alongside .yaml files", () => {
    const tmp = makeTempDir("perm-dropin-yml-");
    try {
        writeFileSync(join(tmp, "aws.yaml"), "", "utf-8");
        writeFileSync(join(tmp, "bun.yml"), "", "utf-8");
        const sources = discoverConfigDirFiles(tmp, "~/.claude/permissions.d", "/base");
        const names = sources.map((source: IConfigFileSource) => source.filePath.split("/").pop());
        expect(names).toEqual(["aws.yaml", "bun.yml"]);
    }
    finally {
        rmSync(tmp, { recursive: true, force: true });
    }
});

test("discoverConfigDirFiles: orders results alphabetically", () => {
    const tmp = makeTempDir("perm-dropin-sort-");
    try {
        writeFileSync(join(tmp, "git.yaml"), "", "utf-8");
        writeFileSync(join(tmp, "aws.yaml"), "", "utf-8");
        writeFileSync(join(tmp, "bun.yaml"), "", "utf-8");
        const sources = discoverConfigDirFiles(tmp, "~/.claude/permissions.d", "/base");
        const names = sources.map((source: IConfigFileSource) => source.filePath.split("/").pop());
        expect(names).toEqual(["aws.yaml", "bun.yaml", "git.yaml"]);
    }
    finally {
        rmSync(tmp, { recursive: true, force: true });
    }
});

test("discoverConfigDirFiles: populates displayPath as prefix/name for each file", () => {
    const tmp = makeTempDir("perm-dropin-displaypath-");
    try {
        writeFileSync(join(tmp, "aws.yaml"), "", "utf-8");
        writeFileSync(join(tmp, "bun.yaml"), "", "utf-8");
        const sources = discoverConfigDirFiles(tmp, "~/.claude/permissions.d", "/base");
        expect(sources[0].displayPath).toBe("~/.claude/permissions.d/aws.yaml");
        expect(sources[1].displayPath).toBe("~/.claude/permissions.d/bun.yaml");
        expect(sources[0].baseDir).toBe("/base");
    }
    finally {
        rmSync(tmp, { recursive: true, force: true });
    }
});

test("discoverHomeConfigDirFiles: returns [] when HOME is unset", () => {
    const origHome = process.env["HOME"];
    delete process.env["HOME"];
    try {
        expect(discoverHomeConfigDirFiles()).toEqual([]);
    }
    finally {
        if (origHome !== undefined) {
            process.env["HOME"] = origHome;
        }
    }
});

test("discoverProjectConfigDirFiles: returns [] when CLAUDE_PROJECT_DIR is unset", () => {
    const origProjectDir = process.env["CLAUDE_PROJECT_DIR"];
    delete process.env["CLAUDE_PROJECT_DIR"];
    try {
        expect(discoverProjectConfigDirFiles()).toEqual([]);
    }
    finally {
        if (origProjectDir !== undefined) {
            process.env["CLAUDE_PROJECT_DIR"] = origProjectDir;
        }
    }
});

test("discoverProjectConfigDirFiles: returns one source per drop-in file under project dir", () => {
    const tmp = makeTempDir("perm-dropin-project-discover-");
    try {
        mkdirSync(join(tmp, ".claude", "permissions.d"), { recursive: true });
        writeFileSync(join(tmp, ".claude", "permissions.d", "git.yaml"), "bash:\n  git:\n    decide: deny\n", "utf-8");
        const origProjectDir = process.env["CLAUDE_PROJECT_DIR"];
        process.env["CLAUDE_PROJECT_DIR"] = tmp;
        try {
            const sources = discoverProjectConfigDirFiles();
            expect(sources.length).toBe(1);
            expect(sources[0].displayPath).toBe(".claude/permissions.d/git.yaml");
            expect(sources[0].baseDir).toBe(tmp);
        }
        finally {
            if (origProjectDir === undefined) {
                delete process.env["CLAUDE_PROJECT_DIR"];
            }
            else {
                process.env["CLAUDE_PROJECT_DIR"] = origProjectDir;
            }
        }
    }
    finally {
        rmSync(tmp, { recursive: true, force: true });
    }
});

test("makeConfigFileLoader: returns a closure that compiles the rules from the file", () => {
    const tmp = makeTempDir("perm-dropin-loader-");
    try {
        const filePath = join(tmp, "git.yaml");
        writeFileSync(filePath, "bash:\n  git:\n    decide: deny\n    reason: no git\n", "utf-8");
        const source: IConfigFileSource = {
            filePath,
            displayPath: ".claude/permissions.d/git.yaml",
            baseDir: tmp,
        };
        const loader = makeConfigFileLoader(source);
        const rules = loader();
        expect(rules.length).toBe(1);
        const gitNode = makeCommand("git", ["status"]);
        const outcome = rules[0](gitNode, makeEnv(), dummyCall);
        expect(outcome.decision.action).toBe("deny");
    }
    finally {
        rmSync(tmp, { recursive: true, force: true });
    }
});

test("withYamlFixtures: project drop-in source loader compiles into rules separate from main loadConfigRules", () => {
    const projectYaml = `
bash:
  ls:
    decide: allow
`;
    const dropInYaml = `
bash:
  git:
    decide: deny
    reason: no git
`;
    withYamlFixtures(null, projectYaml, (mainRules) => {
        // The main loadConfigRules() should not include drop-in rules.
        const gitNode = makeCommand("git", ["status"]);
        const mainActions = mainRules.map((rule) => rule(gitNode, makeEnv(), dummyCall).decision.action);
        expect(mainActions).not.toContain("deny");

        // The drop-in source loader does include them.
        const dropInSources = discoverProjectConfigDirFiles();
        expect(dropInSources.length).toBe(1);
        expect(dropInSources[0].displayPath).toBe(".claude/permissions.d/git.yaml");
        const dropInRules = makeConfigFileLoader(dropInSources[0])();
        const dropInActions = dropInRules.map((rule) => rule(gitNode, makeEnv(), dummyCall).decision.action);
        expect(dropInActions).toContain("deny");
    }, {
        projectDirFiles: {
            "git.yaml": dropInYaml,
        },
    });
});

// ---------------------------------------------------------------------------
// expandEntryEnvTokens / expandConfigEnvTokens
// ---------------------------------------------------------------------------

// String tokens used in YAML fixtures to avoid TypeScript template-literal parse errors.
const TOK_PROJECT_DIR = "${{PROJECT_DIR}}";
const TOK_HOME = "${{HOME}}";

// Helper: call expandEntryEnvTokens with projectDir and homeDir, return collected warnings.
function expandEntry(
    entry: IYamlEntry,
    projectDir: string | undefined,
    homeDir: string | undefined,
    options?: { isToolNameEntry: boolean }
): Set<string> {
    const warnings = new Set<string>();
    expandEntryEnvTokens(entry, projectDir, homeDir, "test.yaml", warnings, options);
    return warnings;
}

// --- expandEnvTokens behaviour (tested via expandEntryEnvTokens cmd field) ---

test("expandEnvTokens: ${{PROJECT_DIR}}/foo with projectDir /proj → /proj/foo", () => {
    const entry: IYamlEntry = { cmd: "${{PROJECT_DIR}}/foo", decide: "allow" };
    expandEntry(entry, "/proj", undefined);
    expect(entry.cmd).toBe("/proj/foo");
});

test("expandEnvTokens: ${{HOME}}/.config with homeDir /home/user → /home/user/.config", () => {
    const entry: IYamlEntry = { cwd: "${{HOME}}/.config", decide: "allow" };
    expandEntry(entry, undefined, "/home/user");
    expect(entry.cwd).toBe("/home/user/.config");
});

test("expandEnvTokens: both tokens in same string expand both", () => {
    const entry: IYamlEntry = { cmd: "${{PROJECT_DIR}}/${{HOME}}", decide: "allow" };
    expandEntry(entry, "/proj", "/home/user");
    expect(entry.cmd).toBe("/proj//home/user");
});

test("expandEnvTokens: string with no tokens returned unchanged", () => {
    const entry: IYamlEntry = { cmd: "foo-*", decide: "allow" };
    expandEntry(entry, "/proj", "/home/user");
    expect(entry.cmd).toBe("foo-*");
});

test("expandEnvTokens: regex pattern /.../  returned unchanged", () => {
    const entry: IYamlEntry = { cmd: "/^foo.*/", decide: "allow" };
    expandEntry(entry, "/proj", "/home/user");
    expect(entry.cmd).toBe("/^foo.*/");
});

test("expandEnvTokens: unresolved ${{PROJECT_DIR}} left in place and warning recorded", () => {
    const entry: IYamlEntry = { cmd: "${{PROJECT_DIR}}/x", decide: "allow" };
    const warnings = expandEntry(entry, undefined, "/home/user");
    expect(entry.cmd).toBe("${{PROJECT_DIR}}/x");
    const warningValues = Array.from(warnings);
    expect(warningValues.some((warningValue) => warningValue.includes("PROJECT_DIR"))).toBe(true);
});

// --- expandEntryEnvTokens field coverage ---

test("expandEntryEnvTokens: cmd (string) rewritten", () => {
    const entry: IYamlEntry = { cmd: "${{PROJECT_DIR}}/**", decide: "allow" };
    expandEntry(entry, "/proj", undefined);
    expect(entry.cmd).toBe("/proj/**");
});

test("expandEntryEnvTokens: cmd (array) each element rewritten", () => {
    const entry: IYamlEntry = { cmd: ["${{PROJECT_DIR}}/a", "${{HOME}}/b"], decide: "allow" };
    expandEntry(entry, "/proj", "/home/user");
    expect(entry.cmd).toEqual(["/proj/a", "/home/user/b"]);
});

test("expandEntryEnvTokens: cmd-in elements rewritten", () => {
    const entry: IYamlEntry = { "cmd-in": ["${{PROJECT_DIR}}/**", "other"], decide: "allow" };
    expandEntry(entry, "/proj", undefined);
    expect(entry["cmd-in"]).toEqual(["/proj/**", "other"]);
});

test("expandEntryEnvTokens: cwd rewritten", () => {
    const entry: IYamlEntry = { cwd: "${{PROJECT_DIR}}/**", decide: "allow" };
    expandEntry(entry, "/proj", undefined);
    expect(entry.cwd).toBe("/proj/**");
});

test("expandEntryEnvTokens: cwd-in elements rewritten", () => {
    const entry: IYamlEntry = { "cwd-in": ["${{HOME}}/**"], decide: "allow" };
    expandEntry(entry, undefined, "/home/user");
    expect(entry["cwd-in"]).toEqual(["/home/user/**"]);
});

test("expandEntryEnvTokens: path rewritten", () => {
    const entry: IYamlEntry = { path: "${{PROJECT_DIR}}/secrets/*", decide: "allow" };
    expandEntry(entry, "/proj", undefined);
    expect(entry.path).toBe("/proj/secrets/*");
});

test("expandEntryEnvTokens: path-in elements rewritten", () => {
    const entry: IYamlEntry = { "path-in": ["${{PROJECT_DIR}}/a", "${{HOME}}/b"], decide: "allow" };
    expandEntry(entry, "/proj", "/home/user");
    expect(entry["path-in"]).toEqual(["/proj/a", "/home/user/b"]);
});

test("expandEntryEnvTokens: env map values rewritten", () => {
    const entry: IYamlEntry = { env: { MY_VAR: "${{PROJECT_DIR}}/data" }, decide: "allow" };
    expandEntry(entry, "/proj", undefined);
    expect(entry.env).toEqual({ MY_VAR: "/proj/data" });
});

test("expandEntryEnvTokens: file map keys rewritten (map rebuilt)", () => {
    const entry: IYamlEntry = { file: { "${{PROJECT_DIR}}/lock": true }, decide: "allow" };
    expandEntry(entry, "/proj", undefined);
    expect(Object.keys(entry.file!)).toEqual(["/proj/lock"]);
    expect(entry.file!["/proj/lock"]).toBe(true);
});

test("expandEntryEnvTokens: not.cmd rewritten", () => {
    const entry: IYamlEntry = { not: { cmd: "${{PROJECT_DIR}}/**" }, decide: "allow" };
    expandEntry(entry, "/proj", undefined);
    expect(entry.not!.cmd).toBe("/proj/**");
});

test("expandEntryEnvTokens: not.cmd-in elements rewritten", () => {
    const entry: IYamlEntry = { not: { "cmd-in": ["${{HOME}}/**"] }, decide: "allow" };
    expandEntry(entry, undefined, "/home/user");
    expect(entry.not!["cmd-in"]).toEqual(["/home/user/**"]);
});

test("expandEntryEnvTokens: not.cwd rewritten", () => {
    const entry: IYamlEntry = { not: { cwd: "${{PROJECT_DIR}}/**" }, decide: "allow" };
    expandEntry(entry, "/proj", undefined);
    expect(entry.not!.cwd).toBe("/proj/**");
});

test("expandEntryEnvTokens: not.cwd-in elements rewritten", () => {
    const entry: IYamlEntry = { not: { "cwd-in": ["${{HOME}}/**"] }, decide: "allow" };
    expandEntry(entry, undefined, "/home/user");
    expect(entry.not!["cwd-in"]).toEqual(["/home/user/**"]);
});

test("expandEntryEnvTokens: not.path rewritten", () => {
    const entry: IYamlEntry = { not: { path: "${{PROJECT_DIR}}/secrets/*" }, decide: "allow" };
    expandEntry(entry, "/proj", undefined);
    expect(entry.not!.path).toBe("/proj/secrets/*");
});

test("expandEntryEnvTokens: not.env map values rewritten", () => {
    const entry: IYamlEntry = { not: { env: { MY_VAR: "${{PROJECT_DIR}}/data" } }, decide: "allow" };
    expandEntry(entry, "/proj", undefined);
    expect(entry.not!.env!["MY_VAR"]).toBe("/proj/data");
});

test("expandEntryEnvTokens: not.file map keys rewritten", () => {
    const entry: IYamlEntry = { not: { file: { "${{HOME}}/.config": true } }, decide: "allow" };
    expandEntry(entry, undefined, "/home/user");
    expect(Object.keys(entry.not!.file!)).toEqual(["/home/user/.config"]);
});

test("expandEntryEnvTokens: env map with non-string values (e.g. sourceLine number) passes through unchanged", () => {
    const entry: IYamlEntry = { env: { MY_VAR: "${{PROJECT_DIR}}/data", sourceLine: 42 as unknown as string }, decide: "allow" };
    expandEntry(entry, "/proj", undefined);
    expect(entry.env!["MY_VAR"]).toBe("/proj/data");
    expect(entry.env!["sourceLine"]).toBe(42 as unknown as string);
});

test("expandEntryEnvTokens: not.path-in elements rewritten", () => {
    const entry: IYamlEntry = { not: { "path-in": ["${{PROJECT_DIR}}/a"] }, decide: "allow" };
    expandEntry(entry, "/proj", undefined);
    expect(entry.not!["path-in"]).toEqual(["/proj/a"]);
});

test("expandEntryEnvTokens: rules sub-entries recursed", () => {
    const subEntry: IYamlEntry = { cmd: "${{PROJECT_DIR}}/foo", decide: "allow" };
    const entry: IYamlEntry = { rules: [subEntry] };
    expandEntry(entry, "/proj", undefined);
    expect(subEntry.cmd).toBe("/proj/foo");
});

test("expandEntryEnvTokens: subcommand children recursed when isToolNameEntry is false", () => {
    const childEntry: IYamlEntry = { cmd: "${{PROJECT_DIR}}/foo", decide: "allow" };
    const entry: IYamlEntry = { subdir: childEntry };
    expandEntry(entry, "/proj", undefined, { isToolNameEntry: false });
    expect(childEntry.cmd).toBe("/proj/foo");
});

test("expandEntryEnvTokens: subcommand children NOT recursed when isToolNameEntry is true", () => {
    const childEntry: IYamlEntry = { cmd: "${{PROJECT_DIR}}/foo", decide: "allow" };
    const entry: IYamlEntry = { subdir: childEntry };
    expandEntry(entry, "/proj", undefined, { isToolNameEntry: true });
    expect(childEntry.cmd).toBe("${{PROJECT_DIR}}/foo");
});

test("expandEntryEnvTokens: reason, decide, host, tool fields are not rewritten", () => {
    const entry: IYamlEntry = {
        reason: "${{PROJECT_DIR}} note",
        decide: "allow",
        host: "${{HOME}}.example.com",
        tool: "${{PROJECT_DIR}}-tool",
    };
    expandEntry(entry, "/proj", "/home/user");
    expect(entry.reason).toBe("${{PROJECT_DIR}} note");
    expect(entry.decide).toBe("allow");
    expect(entry.host).toBe("${{HOME}}.example.com");
    expect(entry.tool).toBe("${{PROJECT_DIR}}-tool");
});

// --- expandConfigEnvTokens ---

test("expandConfigEnvTokens: empty config is a no-op", () => {
    const config: IYamlConfig = {};
    expandConfigEnvTokens(config, "/proj", "/home/user", "test.yaml");
    expect(config).toEqual({});
});

test("expandConfigEnvTokens: rewrites bash section", () => {
    const config: IYamlConfig = {
        bash: { find: { cmd: "${{PROJECT_DIR}}/**", decide: "allow" } },
    };
    expandConfigEnvTokens(config, "/proj", "/home/user", "test.yaml");
    expect(config.bash!.find).toMatchObject({ cmd: "/proj/**" });
});

test("expandConfigEnvTokens: rewrites read, write, edit, multi_edit, webfetch sections", () => {
    const config: IYamlConfig = {
        read: { path: "${{PROJECT_DIR}}/src/*", decide: "allow" },
        write: { path: "${{HOME}}/data/*", decide: "allow" },
        edit: { cwd: "${{PROJECT_DIR}}/**", decide: "allow" },
        multi_edit: { cwd: "${{HOME}}/**", decide: "allow" },
        webfetch: { cwd: "${{PROJECT_DIR}}/**", decide: "allow" },
    };
    expandConfigEnvTokens(config, "/proj", "/home/user", "test.yaml");
    const readEntry = config.read as IYamlEntry;
    expect(readEntry.path).toBe("/proj/src/*");
    const writeEntry = config.write as IYamlEntry;
    expect(writeEntry.path).toBe("/home/user/data/*");
    const editEntry = config.edit as IYamlEntry;
    expect(editEntry.cwd).toBe("/proj/**");
    const multiEditEntry = config.multi_edit as IYamlEntry;
    expect(multiEditEntry.cwd).toBe("/home/user/**");
    const webfetchEntry = config.webfetch as IYamlEntry;
    expect(webfetchEntry.cwd).toBe("/proj/**");
});

test("expandConfigEnvTokens: rewrites top-level tool-name keys", () => {
    const toolEntry: IYamlEntry = { cwd: "${{PROJECT_DIR}}/**", decide: "allow" };
    const config: IYamlConfig = {};
    (config as Record<string, IYamlEntry>)["MyTool"] = toolEntry;
    expandConfigEnvTokens(config, "/proj", "/home/user", "test.yaml");
    expect(toolEntry.cwd).toBe("/proj/**");
});

test("expandConfigEnvTokens: emits one CONFIG WARN per unresolved token+file pair", () => {
    const stderrWrites: string[] = [];
    const stderrSpy = jest.spyOn(process.stderr, "write").mockImplementation((chunk) => {
        stderrWrites.push(String(chunk));
        return true;
    });
    try {
        const config: IYamlConfig = {
            bash: { find: { cmd: "${{PROJECT_DIR}}/**", decide: "allow" } },
        };
        expandConfigEnvTokens(config, undefined, undefined, "myfile.yaml");
        const combined = stderrWrites.join("");
        expect(combined).toContain("[CONFIG WARN]");
        expect(combined).toContain("myfile.yaml");
        expect(combined).toContain("PROJECT_DIR");
    }
    finally {
        stderrSpy.mockRestore();
    }
});

test("expandConfigEnvTokens: warning emitted only once per token+file even if token appears in multiple entries", () => {
    const stderrWrites: string[] = [];
    const stderrSpy = jest.spyOn(process.stderr, "write").mockImplementation((chunk) => {
        stderrWrites.push(String(chunk));
        return true;
    });
    try {
        const config: IYamlConfig = {
            bash: {
                find: { cmd: "${{PROJECT_DIR}}/**", decide: "allow" },
                ls: { cwd: "${{PROJECT_DIR}}/**", decide: "allow" },
            },
        };
        expandConfigEnvTokens(config, undefined, undefined, "myfile.yaml");
        const combined = stderrWrites.join("");
        const occurrences = (combined.match(/PROJECT_DIR/g) || []).length;
        expect(occurrences).toBe(1);
    }
    finally {
        stderrSpy.mockRestore();
    }
});

// --- Backward-compat regression ---

test("expandConfigEnvTokens: config with only ./** patterns produces identical compiled rules after pre-pass", () => {
    withYamlFixtures(null, `
bash:
  find:
    cmd: ./**
    decide: allow
`, (rules) => {
        expect(rules.length).toBe(1);
        const projectDir = process.env["CLAUDE_PROJECT_DIR"]!;
        const findNode = makeCommand("find", [`${projectDir}/src`]);
        const outcome = rules[0](findNode, makeEnv(projectDir, true), dummyCall);
        expect(outcome.decision.action).toBe("allow");
    });
});

// --- Cross-feature integration ---

test("${{PROJECT_DIR}}/** in cmd resolves and matches like ./**", () => {
    withYamlFixtures(null, `
bash:
  find:
    cmd: ${TOK_PROJECT_DIR}/**
    decide: allow
`, (rules) => {
        const projectDir = process.env["CLAUDE_PROJECT_DIR"]!;
        const findNode = makeCommand("find", [`${projectDir}/src`]);
        const outcome = rules[0](findNode, makeEnv(projectDir, true), dummyCall);
        expect(outcome.decision.action).toBe("allow");
    });
});

test("${{HOME}}/** in cwd resolves and matches a cwd under home", () => {
    withYamlFixtures(null, `
bash:
  ls:
    cwd: ${TOK_HOME}/**
    decide: allow
`, (rules) => {
        const homeDir = process.env["HOME"]!;
        const lsNode = makeCommand("ls", []);
        const outcome = rules[0](lsNode, makeEnv(`${homeDir}/projects`, true), dummyCall);
        expect(outcome.decision.action).toBe("allow");
    });
});

test("${{PROJECT_DIR}}/secrets/* in path matches a read file under project", () => {
    withYamlFixtures(null, `
read:
  path: ${TOK_PROJECT_DIR}/secrets/*
  decide: deny
`, (rules) => {
        const projectDir = process.env["CLAUDE_PROJECT_DIR"]!;
        const readNode = { type: "read" as const, file_path: `${projectDir}/secrets/key.pem` };
        const outcome = rules[0](readNode as AstNode, makeEnv(projectDir, true), dummyCall);
        expect(outcome.decision.action).toBe("deny");
    });
});

test("cmd-in mixing ${{PROJECT_DIR}} and ./** resolves both patterns", () => {
    withYamlFixtures(null, `
bash:
  find:
    cmd-in:
      - ${TOK_PROJECT_DIR}/src/**
      - ./test/**
    decide: allow
`, (rules) => {
        const projectDir = process.env["CLAUDE_PROJECT_DIR"]!;
        const nodeInSrc = makeCommand("find", [`${projectDir}/src/main.ts`]);
        const nodeInTest = makeCommand("find", [`${projectDir}/test/foo.ts`]);
        const outcomeInSrc = rules[0](nodeInSrc, makeEnv(projectDir, true), dummyCall);
        const outcomeInTest = rules[0](nodeInTest, makeEnv(projectDir, true), dummyCall);
        expect(outcomeInSrc.decision.action).toBe("allow");
        expect(outcomeInTest.decision.action).toBe("allow");
    });
});
