import { decide, expandToken, expandCommandOptions, rank, isLeaf, aggregateChildren, combine, describeNode } from "../interpret";
import { NullAuditLogger, IAuditLogEntry, IAuditLogger, IRuleMatchEntry } from "../audit-log";
import { rules } from "../rules";
import { cdRule } from "../rules/builtin/cd";
import { envPrefixRule } from "../rules/builtin/env-prefix";
import { envSetRule } from "../rules/builtin/env-set";
import { AstNode, Environment, Rule, RuleOutcome, ToolCall, ABSTAIN } from "../types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// makeBashCall builds a minimal ToolCall for a Bash command string.
function makeBashCall(command: string, cwd: string = "/start"): ToolCall {
    return { tool_name: "Bash", tool_input: { command }, cwd };
}

// makeToolCall builds a minimal ToolCall for a non-Bash tool.
function makeToolCall(toolName: string, input: Record<string, string>, cwd: string = "/start"): ToolCall {
    return { tool_name: toolName, tool_input: input, cwd };
}

// spyRule returns a Rule that always returns the given outcome and captures each env it sees.
function spyRule(
    outcome: RuleOutcome,
    capturedEnvs?: Environment[]
): Rule {
    return function spy(node: AstNode, env: Environment): RuleOutcome {
        if (capturedEnvs) {
            capturedEnvs.push(env);
        }
        return outcome;
    };
}

// nodeMatchRule returns a Rule that returns matchOutcome for nodes matching the predicate
// and abstains otherwise.
function nodeMatchRule(
    predicate: (node: AstNode) => boolean,
    matchOutcome: RuleOutcome
): Rule {
    return function matchRule(node: AstNode, env: Environment): RuleOutcome {
        if (predicate(node)) {
            return matchOutcome;
        }
        return ABSTAIN;
    };
}

beforeEach(() => {
    rules.length = 0;
});

// ---------------------------------------------------------------------------
// Leaf default
// ---------------------------------------------------------------------------

test("leaf default: all rules abstain → ask", () => {
    rules.push(spyRule(ABSTAIN));
    const result = decide(makeBashCall("ls"), new NullAuditLogger());
    expect(result.action).toBe("ask");
});

test("leaf default: no rules → ask", () => {
    const result = decide(makeBashCall("ls"), new NullAuditLogger());
    expect(result.action).toBe("ask");
});

test("leaf default: allow rule → allow", () => {
    rules.push(spyRule({ decision: { action: "allow" } }));
    const result = decide(makeBashCall("ls"), new NullAuditLogger());
    expect(result.action).toBe("allow");
});

test("leaf default: ask rule → ask", () => {
    rules.push(spyRule({ decision: { action: "ask" } }));
    const result = decide(makeBashCall("ls"), new NullAuditLogger());
    expect(result.action).toBe("ask");
});

test("leaf default: deny rule → deny", () => {
    rules.push(spyRule({ decision: { action: "deny", reason: "blocked" } }));
    const result = decide(makeBashCall("ls"), new NullAuditLogger());
    expect(result.action).toBe("deny");
});

// ---------------------------------------------------------------------------
// Intermediate aggregation
// ---------------------------------------------------------------------------

test("intermediate aggregation: any child deny wins", () => {
    rules.push(nodeMatchRule(
        (node: AstNode) => node.type === "command" && (node as { binary?: string }).binary === "rm",
        { decision: { action: "deny", reason: "no rm" } }
    ));
    const result = decide(makeBashCall("ls && rm -rf /"), new NullAuditLogger());
    expect(result.action).toBe("deny");
});

test("intermediate aggregation: all children allow → allow", () => {
    rules.push(spyRule({ decision: { action: "allow" } }));
    const result = decide(makeBashCall("ls && pwd"), new NullAuditLogger());
    expect(result.action).toBe("allow");
});

test("intermediate aggregation: all allow + abstain own rule → allow", () => {
    rules.push(nodeMatchRule(
        (node: AstNode) => node.type === "command",
        { decision: { action: "allow" } }
    ));
    // No rule for the bash root or binop node → abstain on own → keep children's allow
    const result = decide(makeBashCall("ls && pwd"), new NullAuditLogger());
    expect(result.action).toBe("allow");
});

test("intermediate aggregation: all allow + ask own rule → ask", () => {
    rules.push(nodeMatchRule(
        (node: AstNode) => node.type === "command",
        { decision: { action: "allow" } }
    ));
    rules.push(nodeMatchRule(
        (node: AstNode) => node.type === "bash",
        { decision: { action: "ask" } }
    ));
    const result = decide(makeBashCall("ls && pwd"), new NullAuditLogger());
    expect(result.action).toBe("ask");
});

test("intermediate aggregation: mixed children + abstain own → ask", () => {
    rules.push(nodeMatchRule(
        (node: AstNode) => node.type === "command" && (node as { binary?: string }).binary === "ls",
        { decision: { action: "allow" } }
    ));
    // pwd falls through to ask (default)
    const result = decide(makeBashCall("ls && pwd"), new NullAuditLogger());
    expect(result.action).toBe("ask");
});

test("intermediate aggregation: mixed children + allow own → allow", () => {
    rules.push(nodeMatchRule(
        (node: AstNode) => node.type === "command" && (node as { binary?: string }).binary === "ls",
        { decision: { action: "allow" } }
    ));
    rules.push(nodeMatchRule(
        (node: AstNode) => node.type === "bash",
        { decision: { action: "allow" } }
    ));
    // ls allow, pwd ask → children mixed → bash root own rule allow overrides → allow
    const result = decide(makeBashCall("ls && pwd"), new NullAuditLogger());
    expect(result.action).toBe("allow");
});

// ---------------------------------------------------------------------------
// Deny short-circuit propagation upward
// ---------------------------------------------------------------------------

test("deny short-circuit: child deny propagates to root", () => {
    rules.push(nodeMatchRule(
        (node: AstNode) => node.type === "command" && (node as { binary?: string }).binary === "rm",
        { decision: { action: "deny", reason: "blocked rm" } }
    ));
    // Even with an allow at the bash root, child deny wins
    rules.push(nodeMatchRule(
        (node: AstNode) => node.type === "bash",
        { decision: { action: "allow" } }
    ));
    const result = decide(makeBashCall("ls && rm foo"), new NullAuditLogger());
    expect(result.action).toBe("deny");
});

// ---------------------------------------------------------------------------
// Rule iteration: strictest-wins
// ---------------------------------------------------------------------------

test("rule iteration: allow then ask → ask (strictest-wins)", () => {
    rules.push(spyRule({ decision: { action: "allow" } }));
    rules.push(spyRule({ decision: { action: "ask" } }));
    const result = decide(makeBashCall("ls"), new NullAuditLogger());
    expect(result.action).toBe("ask");
});

test("rule iteration: ask then allow → ask (ask not downgraded)", () => {
    rules.push(spyRule({ decision: { action: "ask" } }));
    rules.push(spyRule({ decision: { action: "allow" } }));
    const result = decide(makeBashCall("ls"), new NullAuditLogger());
    expect(result.action).toBe("ask");
});

test("rule iteration: deny short-circuits remaining rules", () => {
    let secondRuleCalled = false;
    rules.push(spyRule({ decision: { action: "deny", reason: "first" } }));
    rules.push(function laterRule(_node: AstNode, _env: Environment): RuleOutcome {
        secondRuleCalled = true;
        return { decision: { action: "allow" } };
    });
    const result = decide(makeBashCall("ls"), new NullAuditLogger());
    expect(result.action).toBe("deny");
    expect(secondRuleCalled).toBe(false);
});

test("rule iteration: same-rank ties go to latest rule", () => {
    rules.push(spyRule({ decision: { action: "allow" } }));
    rules.push(spyRule({ decision: { action: "allow" } }));
    // Both allow → allow wins (last one recorded since rank is equal and >=)
    const result = decide(makeBashCall("ls"), new NullAuditLogger());
    expect(result.action).toBe("allow");
});

// ---------------------------------------------------------------------------
// Persistent env composition
// ---------------------------------------------------------------------------

test("persistent env composition: env update applied even if later rule denies", () => {
    const capturedEnvs: Environment[] = [];
    rules.push(function envInstaller(_node: AstNode, env: Environment): RuleOutcome {
        return {
            decision: { action: "abstain" },
            env: { ...env, env: { ...env.env, INSTALLED: "yes" } },
        };
    });
    rules.push(spyRule({ decision: { action: "deny", reason: "blocked" } }, capturedEnvs));
    decide(makeBashCall("ls"), new NullAuditLogger());
    // The spy rule ran after envInstaller, so it should see INSTALLED
    expect(capturedEnvs.length).toBeGreaterThan(0);
    expect(capturedEnvs[0].env.INSTALLED).toBe("yes");
});

// ---------------------------------------------------------------------------
// Scoped env visibility
// ---------------------------------------------------------------------------

test("scoped env: visible to subsequent rules at same node but not siblings", () => {
    const capturedAtSameNode: Environment[] = [];
    const capturedAtSibling: Environment[] = [];

    rules.push(function scopeInstaller(node: AstNode, env: Environment): RuleOutcome {
        if (node.type === "command" && (node as { binary?: string }).binary === "ls") {
            return {
                decision: { action: "abstain" },
                scopedEnv: { ...env, env: { ...env.env, SCOPED: "yes" } },
            };
        }
        return ABSTAIN;
    });

    // Second rule at same node (ls) should see SCOPED
    rules.push(function checkSameNode(node: AstNode, env: Environment): RuleOutcome {
        if (node.type === "command" && (node as { binary?: string }).binary === "ls") {
            capturedAtSameNode.push(env);
        }
        return ABSTAIN;
    });

    // Rule at sibling node (pwd) should NOT see SCOPED
    rules.push(function checkSibling(node: AstNode, env: Environment): RuleOutcome {
        if (node.type === "command" && (node as { binary?: string }).binary === "pwd") {
            capturedAtSibling.push(env);
        }
        return ABSTAIN;
    });

    decide(makeBashCall("ls && pwd"), new NullAuditLogger());

    expect(capturedAtSameNode.length).toBeGreaterThan(0);
    expect(capturedAtSameNode[0].env.SCOPED).toBe("yes");
    expect(capturedAtSibling.length).toBeGreaterThan(0);
    expect(capturedAtSibling[0].env.SCOPED).toBeUndefined();
});

test("scoped env with persistent env: scopedEnv visible at same node, persistent env propagates to siblings", () => {
    const capturedAtSameNode: Environment[] = [];
    const capturedAtSibling: Environment[] = [];

    rules.push(function dualEnvInstaller(node: AstNode, env: Environment): RuleOutcome {
        if (node.type === "command" && (node as { binary?: string }).binary === "ls") {
            return {
                decision: { action: "abstain" },
                env: { ...env, env: { ...env.env, PERSISTENT: "yes" } },
                scopedEnv: { ...env, env: { ...env.env, PERSISTENT: "yes", SCOPED: "yes" } },
            };
        }
        return ABSTAIN;
    });

    rules.push(function checkAtSameNode(node: AstNode, env: Environment): RuleOutcome {
        if (node.type === "command" && (node as { binary?: string }).binary === "ls") {
            capturedAtSameNode.push(env);
        }
        return ABSTAIN;
    });

    rules.push(function checkAtSibling(node: AstNode, env: Environment): RuleOutcome {
        if (node.type === "command" && (node as { binary?: string }).binary === "pwd") {
            capturedAtSibling.push(env);
        }
        return ABSTAIN;
    });

    decide(makeBashCall("ls; pwd"), new NullAuditLogger());

    expect(capturedAtSameNode[0].env.SCOPED).toBe("yes");
    expect(capturedAtSameNode[0].env.PERSISTENT).toBe("yes");
    expect(capturedAtSibling[0].env.PERSISTENT).toBe("yes");
    expect(capturedAtSibling[0].env.SCOPED).toBeUndefined();
});

// ---------------------------------------------------------------------------
// $VAR expansion
// ---------------------------------------------------------------------------

test("$VAR expansion: FOO=bar; git add $FOO — rules at git add see cmd === 'bar'", () => {
    const capturedNodes: AstNode[] = [];
    rules.push(envSetRule);
    rules.push(function captureGitAdd(node: AstNode, _env: Environment): RuleOutcome {
        if (node.type === "command" && (node as { binary?: string }).binary === "git") {
            capturedNodes.push(node);
        }
        return ABSTAIN;
    });

    decide(makeBashCall("FOO=bar; git add $FOO"), new NullAuditLogger());

    expect(capturedNodes.length).toBeGreaterThan(0);
    const gitNode = capturedNodes[0] as { cmd?: string | string[] };
    // After expansion, cmd[1] should be "bar" (cmd[0] is "add")
    const cmdVal = gitNode.cmd;
    const cmdArray = typeof cmdVal === "string" ? [cmdVal] : cmdVal as string[];
    expect(cmdArray).toContain("bar");
});

test("$VAR reversed: git add $FOO; FOO=bar — $FOO stays literal at git add time", () => {
    const capturedNodes: AstNode[] = [];
    rules.push(envSetRule);
    rules.push(function captureGitAdd(node: AstNode, _env: Environment): RuleOutcome {
        if (node.type === "command" && (node as { binary?: string }).binary === "git") {
            capturedNodes.push(node);
        }
        return ABSTAIN;
    });

    decide(makeBashCall("git add $FOO; FOO=bar"), new NullAuditLogger());

    expect(capturedNodes.length).toBeGreaterThan(0);
    const gitNode = capturedNodes[0] as { cmd?: string | string[] };
    const cmdVal = gitNode.cmd;
    const cmdArray = typeof cmdVal === "string" ? [cmdVal] : cmdVal as string[];
    expect(cmdArray).toContain("$FOO");
});

test("${VAR} brace syntax expanded: BAR=main; git checkout ${BAR}", () => {
    const capturedNodes: AstNode[] = [];
    rules.push(envSetRule);
    rules.push(function captureGit(node: AstNode, _env: Environment): RuleOutcome {
        if (node.type === "command" && (node as { binary?: string }).binary === "git") {
            capturedNodes.push(node);
        }
        return ABSTAIN;
    });

    decide(makeBashCall("BAR=main; git checkout ${BAR}"), new NullAuditLogger());

    expect(capturedNodes.length).toBeGreaterThan(0);
    const gitNode = capturedNodes[0] as { cmd?: string | string[] };
    const cmdVal = gitNode.cmd;
    const cmdArray = typeof cmdVal === "string" ? [cmdVal] : cmdVal as string[];
    expect(cmdArray).toContain("main");
});

test("OS-level vars not expanded: git add $HOME — rules see cmd '$HOME'", () => {
    const capturedNodes: AstNode[] = [];
    rules.push(function captureGit(node: AstNode, _env: Environment): RuleOutcome {
        if (node.type === "command" && (node as { binary?: string }).binary === "git") {
            capturedNodes.push(node);
        }
        return ABSTAIN;
    });

    decide(makeBashCall("git add $HOME"), new NullAuditLogger());

    expect(capturedNodes.length).toBeGreaterThan(0);
    const gitNode = capturedNodes[0] as { cmd?: string | string[] };
    const cmdVal = gitNode.cmd;
    const cmdArray = typeof cmdVal === "string" ? [cmdVal] : cmdVal as string[];
    expect(cmdArray).toContain("$HOME");
});

// ---------------------------------------------------------------------------
// Env threading: seq/and propagate; or/pipe discard
// ---------------------------------------------------------------------------

test("env threading seq: left env propagates to right", () => {
    const capturedEnvs: Environment[] = [];
    rules.push(cdRule);
    rules.push(function captureRm(node: AstNode, env: Environment): RuleOutcome {
        if (node.type === "command" && (node as { binary?: string }).binary === "rm") {
            capturedEnvs.push(env);
        }
        return ABSTAIN;
    });

    decide(makeBashCall("cd /etc; rm x", "/start"), new NullAuditLogger());

    expect(capturedEnvs.length).toBeGreaterThan(0);
    expect(capturedEnvs[0].cwd).toBe("/etc");
});

test("env threading and: left env propagates to right", () => {
    const capturedEnvs: Environment[] = [];
    rules.push(cdRule);
    rules.push(function captureRm(node: AstNode, env: Environment): RuleOutcome {
        if (node.type === "command" && (node as { binary?: string }).binary === "rm") {
            capturedEnvs.push(env);
        }
        return ABSTAIN;
    });

    decide(makeBashCall("cd /etc && rm x", "/start"), new NullAuditLogger());

    expect(capturedEnvs.length).toBeGreaterThan(0);
    expect(capturedEnvs[0].cwd).toBe("/etc");
});

test("env threading pipe: right side does NOT see cd from left side", () => {
    const capturedEnvs: Environment[] = [];
    rules.push(cdRule);
    rules.push(function captureEcho(node: AstNode, env: Environment): RuleOutcome {
        if (node.type === "command" && (node as { binary?: string }).binary === "echo") {
            capturedEnvs.push(env);
        }
        return ABSTAIN;
    });

    decide(makeBashCall("cd /etc | echo", "/start"), new NullAuditLogger());

    expect(capturedEnvs.length).toBeGreaterThan(0);
    expect(capturedEnvs[0].cwd).toBe("/start");
});

test("env threading or: right side does NOT see cd from left side", () => {
    const capturedEnvs: Environment[] = [];
    rules.push(cdRule);
    rules.push(function captureEcho(node: AstNode, env: Environment): RuleOutcome {
        if (node.type === "command" && (node as { binary?: string }).binary === "echo") {
            capturedEnvs.push(env);
        }
        return ABSTAIN;
    });

    decide(makeBashCall("cd /etc || echo", "/start"), new NullAuditLogger());

    expect(capturedEnvs.length).toBeGreaterThan(0);
    expect(capturedEnvs[0].cwd).toBe("/start");
});

// ---------------------------------------------------------------------------
// cwd propagation through operators (real cdRule)
// ---------------------------------------------------------------------------

test("cwd propagation: absolute cd through &&", () => {
    const capturedEnvs: Environment[] = [];
    rules.push(cdRule);
    rules.push(function captureRm(node: AstNode, env: Environment): RuleOutcome {
        if (node.type === "command" && (node as { binary?: string }).binary === "rm") {
            capturedEnvs.push(env);
        }
        return ABSTAIN;
    });

    decide(makeBashCall("cd /etc && rm x", "/home/u"), new NullAuditLogger());

    expect(capturedEnvs[0].cwd).toBe("/etc");
    expect(capturedEnvs[0].cwdResolved).toBe(true);
});

test("cwd propagation: relative cd from /home/u", () => {
    const capturedEnvs: Environment[] = [];
    rules.push(cdRule);
    rules.push(function captureRm(node: AstNode, env: Environment): RuleOutcome {
        if (node.type === "command" && (node as { binary?: string }).binary === "ls") {
            capturedEnvs.push(env);
        }
        return ABSTAIN;
    });

    decide(makeBashCall("cd src && ls", "/home/u"), new NullAuditLogger());

    expect(capturedEnvs[0].cwd).toBe("/home/u/src");
});

test("cwd propagation: parent cd from /home/u", () => {
    const capturedEnvs: Environment[] = [];
    rules.push(cdRule);
    rules.push(function captureLs(node: AstNode, env: Environment): RuleOutcome {
        if (node.type === "command" && (node as { binary?: string }).binary === "ls") {
            capturedEnvs.push(env);
        }
        return ABSTAIN;
    });

    decide(makeBashCall("cd .. && ls", "/home/u"), new NullAuditLogger());

    expect(capturedEnvs[0].cwd).toBe("/home");
});

test("cwd propagation: cd reset at pipe — echo sees original cwd", () => {
    const capturedEnvs: Environment[] = [];
    rules.push(cdRule);
    rules.push(function captureEcho(node: AstNode, env: Environment): RuleOutcome {
        if (node.type === "command" && (node as { binary?: string }).binary === "echo") {
            capturedEnvs.push(env);
        }
        return ABSTAIN;
    });

    decide(makeBashCall("cd /etc | echo", "/start"), new NullAuditLogger());

    expect(capturedEnvs[0].cwd).toBe("/start");
});

test("cwd propagation: cd conservative across || — ls sees original cwd", () => {
    const capturedEnvs: Environment[] = [];
    rules.push(cdRule);
    rules.push(function captureLs(node: AstNode, env: Environment): RuleOutcome {
        if (node.type === "command" && (node as { binary?: string }).binary === "ls") {
            capturedEnvs.push(env);
        }
        return ABSTAIN;
    });

    // cd /etc || cd /tmp; ls — the || discards env, so ; passes original cwd to ls
    decide(makeBashCall("cd /etc || cd /tmp; ls", "/start"), new NullAuditLogger());

    expect(capturedEnvs[0].cwd).toBe("/start");
});

test("cwd propagation: unresolvable cd — ls sees cwdResolved false", () => {
    const capturedEnvs: Environment[] = [];
    rules.push(cdRule);
    rules.push(function captureLs(node: AstNode, env: Environment): RuleOutcome {
        if (node.type === "command" && (node as { binary?: string }).binary === "ls") {
            capturedEnvs.push(env);
        }
        return ABSTAIN;
    });

    decide(makeBashCall("cd $HOME && ls", "/start"), new NullAuditLogger());

    expect(capturedEnvs[0].cwdResolved).toBe(false);
    expect(capturedEnvs[0].cwd).toBe("/start");
});

test("cwd propagation: cd no-arg → unresolved", () => {
    const capturedEnvs: Environment[] = [];
    rules.push(cdRule);
    rules.push(function captureLs(node: AstNode, env: Environment): RuleOutcome {
        if (node.type === "command" && (node as { binary?: string }).binary === "ls") {
            capturedEnvs.push(env);
        }
        return ABSTAIN;
    });

    decide(makeBashCall("cd && ls", "/start"), new NullAuditLogger());

    expect(capturedEnvs[0].cwdResolved).toBe(false);
});

test("cwd propagation: chained cds resolve correctly", () => {
    const capturedEnvs: Environment[] = [];
    rules.push(cdRule);
    rules.push(function captureLs(node: AstNode, env: Environment): RuleOutcome {
        if (node.type === "command" && (node as { binary?: string }).binary === "ls") {
            capturedEnvs.push(env);
        }
        return ABSTAIN;
    });

    decide(makeBashCall("cd a && cd b && ls", "/orig"), new NullAuditLogger());

    expect(capturedEnvs[0].cwd).toBe("/orig/a/b");
});

// ---------------------------------------------------------------------------
// EnvPrefix transience (real envPrefixRule)
// ---------------------------------------------------------------------------

test("envPrefix: FOO=bar npm test — subsequent rules at same leaf see FOO", () => {
    const capturedEnvs: Environment[] = [];
    rules.push(envPrefixRule);
    rules.push(function captureNpm(node: AstNode, env: Environment): RuleOutcome {
        if (node.type === "command" && (node as { binary?: string }).binary === "npm") {
            capturedEnvs.push(env);
        }
        return ABSTAIN;
    });

    decide(makeBashCall("FOO=bar npm test"), new NullAuditLogger());

    expect(capturedEnvs[0].env.FOO).toBe("bar");
});

test("envPrefix: FOO=bar npm test && echo $FOO — echo does NOT see FOO", () => {
    const capturedEnvs: Environment[] = [];
    rules.push(envPrefixRule);
    rules.push(function captureEcho(node: AstNode, env: Environment): RuleOutcome {
        if (node.type === "command" && (node as { binary?: string }).binary === "echo") {
            capturedEnvs.push(env);
        }
        return ABSTAIN;
    });

    decide(makeBashCall("FOO=bar npm test && echo $FOO"), new NullAuditLogger());

    expect(capturedEnvs[0].env.FOO).toBeUndefined();
});

// ---------------------------------------------------------------------------
// Status aggregation end-to-end
// ---------------------------------------------------------------------------

test("status aggregation: cd /etc && rm -rf / → deny", () => {
    rules.push(cdRule);
    rules.push(nodeMatchRule(
        (node: AstNode) => {
            if (node.type !== "command") {
                return false;
            }
            const cmd = node as { binary?: string; options?: Record<string, string | boolean>; cmd?: string | string[] };
            if (cmd.binary !== "rm") {
                return false;
            }
            const cmdArray = typeof cmd.cmd === "string" ? [cmd.cmd] : cmd.cmd as string[];
            return (cmd.options?.r === true || cmd.options?.R === true) && cmdArray.includes("/");
        },
        { decision: { action: "deny", reason: "rm -rf / blocked" } }
    ));

    const result = decide(makeBashCall("cd /etc && rm -rf /"), new NullAuditLogger());
    expect(result.action).toBe("deny");
});

test("status aggregation: git status → allow", () => {
    rules.push(nodeMatchRule(
        (node: AstNode) => {
            if (node.type !== "command") {
                return false;
            }
            const cmd = node as { binary?: string; cmd?: string | string[] };
            if (cmd.binary !== "git") {
                return false;
            }
            const cmdArray = typeof cmd.cmd === "string" ? [cmd.cmd] : cmd.cmd as string[];
            return cmdArray[0] === "status";
        },
        { decision: { action: "allow" } }
    ));

    const result = decide(makeBashCall("git status"), new NullAuditLogger());
    expect(result.action).toBe("allow");
});

test("status aggregation: git status | wc -l → ask", () => {
    rules.push(nodeMatchRule(
        (node: AstNode) => {
            if (node.type !== "command") {
                return false;
            }
            const cmd = node as { binary?: string; cmd?: string | string[] };
            if (cmd.binary !== "git") {
                return false;
            }
            const cmdArray = typeof cmd.cmd === "string" ? [cmd.cmd] : cmd.cmd as string[];
            return cmdArray[0] === "status";
        },
        { decision: { action: "allow" } }
    ));
    // wc has no matching rule → ask (default)

    const result = decide(makeBashCall("git status | wc -l"), new NullAuditLogger());
    expect(result.action).toBe("ask");
});

// ---------------------------------------------------------------------------
// Allow override and ask-overrides-allow
// ---------------------------------------------------------------------------

test("allow override: parent bash-root rule allows, overrides mixed-status children ask", () => {
    rules.push(nodeMatchRule(
        (node: AstNode) => node.type === "bash",
        { decision: { action: "allow" } }
    ));
    // children default to ask since no leaf rules match

    const result = decide(makeBashCall("ls && pwd"), new NullAuditLogger());
    expect(result.action).toBe("allow");
});

test("ask overrides allow: ask at node blocks a later allow", () => {
    rules.push(spyRule({ decision: { action: "ask" } }));
    rules.push(spyRule({ decision: { action: "allow" } }));
    const result = decide(makeBashCall("ls"), new NullAuditLogger());
    expect(result.action).toBe("ask");
});

// ---------------------------------------------------------------------------
// Non-Bash leaf decisions
// ---------------------------------------------------------------------------

test("non-bash leaf: Edit of .env denies", () => {
    rules.push(nodeMatchRule(
        (node: AstNode) => node.type === "edit" && (node as { file_path?: string }).file_path?.endsWith(".env") === true,
        { decision: { action: "deny", reason: ".env files are protected" } }
    ));

    const result = decide(makeToolCall("Edit", {
        file_path: "/project/.env",
        old_string: "FOO=old",
        new_string: "FOO=new",
    }), new NullAuditLogger());
    expect(result.action).toBe("deny");
});

test("non-bash leaf: Read of normal file falls through to ask", () => {
    const result = decide(makeToolCall("Read", { file_path: "/project/src/main.ts" }), new NullAuditLogger());
    expect(result.action).toBe("ask");
});

// ---------------------------------------------------------------------------
// Combined / canonical
// ---------------------------------------------------------------------------

test("combined: cd blah && env_var=X cmd-1 | cmd-2 — cmd-1 sees cwd and env_var", () => {
    const capturedCmd1Envs: Environment[] = [];
    const capturedCmd2Envs: Environment[] = [];

    rules.push(cdRule);
    rules.push(envPrefixRule);
    rules.push(function captureCmd1(node: AstNode, env: Environment): RuleOutcome {
        if (node.type === "command" && (node as { binary?: string }).binary === "cmd-1") {
            capturedCmd1Envs.push(env);
        }
        return ABSTAIN;
    });
    rules.push(function captureCmd2(node: AstNode, env: Environment): RuleOutcome {
        if (node.type === "command" && (node as { binary?: string }).binary === "cmd-2") {
            capturedCmd2Envs.push(env);
        }
        return ABSTAIN;
    });

    decide(makeBashCall("cd blah && env_var=X cmd-1 | cmd-2", "/orig"), new NullAuditLogger());

    expect(capturedCmd1Envs[0].cwd).toBe("/orig/blah");
    expect(capturedCmd1Envs[0].env.env_var).toBe("X");
    // cmd-2 is in a pipe with cmd-1, so it sees the env before the pipe (cwd = /orig/blah,
    // but env_var is scoped to cmd-1's leaf so not visible to cmd-2)
    expect(capturedCmd2Envs[0].cwd).toBe("/orig/blah");
    expect(capturedCmd2Envs[0].env.env_var).toBeUndefined();
});

// ---------------------------------------------------------------------------
// expandToken — direct unit tests
// ---------------------------------------------------------------------------

test("expandToken: $VAR substituted when var exists", () => {
    expect(expandToken("$FOO", { FOO: "bar" })).toBe("bar");
});

test("expandToken: ${VAR} brace syntax substituted", () => {
    expect(expandToken("${FOO}", { FOO: "bar" })).toBe("bar");
});

test("expandToken: unknown var left as-is", () => {
    expect(expandToken("$UNKNOWN", {})).toBe("$UNKNOWN");
});

test("expandToken: unknown braced var left as-is", () => {
    expect(expandToken("${UNKNOWN}", {})).toBe("${UNKNOWN}");
});

test("expandToken: multiple vars in one string", () => {
    expect(expandToken("$A/$B", { A: "foo", B: "bar" })).toBe("foo/bar");
});

test("expandToken: known and unknown vars in same string", () => {
    expect(expandToken("$KNOWN/$UNKNOWN", { KNOWN: "x" })).toBe("x/$UNKNOWN");
});

test("expandToken: empty string returned unchanged", () => {
    expect(expandToken("", {})).toBe("");
});

test("expandToken: string with no vars returned unchanged", () => {
    expect(expandToken("hello world", {})).toBe("hello world");
});

// ---------------------------------------------------------------------------
// expandCommandOptions — direct unit tests
// ---------------------------------------------------------------------------

// makeCommand builds a minimal Command node for expandCommandOptions tests.
function makeCommand(
    binary: string,
    options: Record<string, string | boolean>,
    cmd: string | string[]
): import("../types").Command {
    return { type: "command", binary, options, cmd, envPrefix: {}, redirects: [], raw: binary };
}

test("expandCommandOptions: binary expanded", () => {
    const result = expandCommandOptions(makeCommand("$CMD", {}, []), { CMD: "git" });
    expect(result.binary).toBe("git");
});

test("expandCommandOptions: string flag value expanded", () => {
    const result = expandCommandOptions(makeCommand("cmd", { flag: "$VAR" }, []), { VAR: "val" });
    expect(result.options.flag).toBe("val");
});

test("expandCommandOptions: boolean flag unchanged", () => {
    const result = expandCommandOptions(makeCommand("cmd", { verbose: true }, []), { verbose: "x" });
    expect(result.options.verbose).toBe(true);
});

test("expandCommandOptions: positional string expanded", () => {
    const result = expandCommandOptions(makeCommand("git", {}, "$BRANCH"), { BRANCH: "main" });
    expect(result.cmd).toBe("main");
});

test("expandCommandOptions: positional array expanded", () => {
    const result = expandCommandOptions(makeCommand("git", {}, ["add", "$FILE"]), { FILE: "foo.ts" });
    expect(result.cmd).toEqual(["add", "foo.ts"]);
});

test("expandCommandOptions: raw field preserved unchanged", () => {
    const node = makeCommand("$CMD", {}, []);
    node.raw = "original $CMD raw";
    const result = expandCommandOptions(node, { CMD: "git" });
    expect(result.raw).toBe("original $CMD raw");
});

test("expandCommandOptions: unknown var in positional left as-is", () => {
    const result = expandCommandOptions(makeCommand("git", {}, "$UNKNOWN"), {});
    expect(result.cmd).toBe("$UNKNOWN");
});

// ---------------------------------------------------------------------------
// rank — direct unit tests
// ---------------------------------------------------------------------------

test("rank: abstain returns 0", () => {
    expect(rank({ action: "abstain" })).toBe(0);
});

test("rank: allow returns 1", () => {
    expect(rank({ action: "allow" })).toBe(1);
});

test("rank: ask returns 2", () => {
    expect(rank({ action: "ask" })).toBe(2);
});

test("rank: deny returns 3", () => {
    expect(rank({ action: "deny" })).toBe(3);
});

// ---------------------------------------------------------------------------
// isLeaf — direct unit tests
// ---------------------------------------------------------------------------

test("isLeaf: command node is a leaf", () => {
    expect(isLeaf({ type: "command", binary: "ls", options: {}, cmd: [], envPrefix: {}, redirects: [], raw: "ls" })).toBe(true);
});

test("isLeaf: binop node is not a leaf", () => {
    const left = { type: "command" as const, binary: "a", options: {}, cmd: [], envPrefix: {}, redirects: [], raw: "a" };
    const right = { type: "command" as const, binary: "b", options: {}, cmd: [], envPrefix: {}, redirects: [], raw: "b" };
    expect(isLeaf({ type: "binop", op: "&&", left, right })).toBe(false);
});

test("isLeaf: bash node is not a leaf", () => {
    const cmd = { type: "command" as const, binary: "ls", options: {}, cmd: [], envPrefix: {}, redirects: [], raw: "ls" };
    expect(isLeaf({ type: "bash", ast: cmd, raw: "ls" })).toBe(false);
});

test("isLeaf: read node is a leaf", () => {
    expect(isLeaf({ type: "read", file_path: "/etc/hosts" })).toBe(true);
});

test("isLeaf: write node is a leaf", () => {
    expect(isLeaf({ type: "write", file_path: "/tmp/f", content: "" })).toBe(true);
});

test("isLeaf: edit node is a leaf", () => {
    expect(isLeaf({ type: "edit", file_path: "/tmp/f", old_string: "a", new_string: "b" })).toBe(true);
});

test("isLeaf: multiedit node is a leaf", () => {
    expect(isLeaf({ type: "multiedit", file_path: "/tmp/f", edits: [] })).toBe(true);
});

test("isLeaf: other node is a leaf", () => {
    expect(isLeaf({ type: "other", tool_name: "Grep", tool_input: {} })).toBe(true);
});

// ---------------------------------------------------------------------------
// aggregateChildren — direct unit tests
// ---------------------------------------------------------------------------

test("aggregateChildren: single deny → deny", () => {
    const result = aggregateChildren([{ decision: { action: "deny", reason: "blocked" } }]);
    expect(result.decision.action).toBe("deny");
});

test("aggregateChildren: deny among allows → deny", () => {
    const result = aggregateChildren([
        { decision: { action: "allow" } },
        { decision: { action: "deny" } },
        { decision: { action: "allow" } },
    ]);
    expect(result.decision.action).toBe("deny");
});

test("aggregateChildren: all allow → allow (returns last annotation)", () => {
    const last = { decision: { action: "allow" as const }, ruleName: "last" };
    const result = aggregateChildren([
        { decision: { action: "allow" } },
        last,
    ]);
    expect(result.decision.action).toBe("allow");
    expect(result.ruleName).toBe("last");
});

test("aggregateChildren: allow + ask → ask", () => {
    const result = aggregateChildren([
        { decision: { action: "allow" } },
        { decision: { action: "ask" } },
    ]);
    expect(result.decision.action).toBe("ask");
});

test("aggregateChildren: all ask → ask", () => {
    const result = aggregateChildren([
        { decision: { action: "ask" } },
        { decision: { action: "ask" } },
    ]);
    expect(result.decision.action).toBe("ask");
});

test("aggregateChildren: single allow → allow", () => {
    const result = aggregateChildren([{ decision: { action: "allow" } }]);
    expect(result.decision.action).toBe("allow");
});

// ---------------------------------------------------------------------------
// combine — direct unit tests
// ---------------------------------------------------------------------------

test("combine: own abstain → returns children annotation unchanged", () => {
    const children = { decision: { action: "allow" as const }, ruleName: "child" };
    const result = combine(children, { decision: { action: "abstain" } });
    expect(result).toBe(children);
});

test("combine: own allow → returns own annotation", () => {
    const children = { decision: { action: "ask" as const } };
    const own = { decision: { action: "allow" as const }, ruleName: "override" };
    const result = combine(children, own);
    expect(result).toBe(own);
});

test("combine: own ask → returns own annotation", () => {
    const children = { decision: { action: "allow" as const } };
    const own = { decision: { action: "ask" as const }, ruleName: "conservative" };
    const result = combine(children, own);
    expect(result).toBe(own);
});

test("combine: own deny → returns own annotation", () => {
    const children = { decision: { action: "allow" as const } };
    const own = { decision: { action: "deny" as const, reason: "blocked" }, ruleName: "blocker" };
    const result = combine(children, own);
    expect(result).toBe(own);
});

// ---------------------------------------------------------------------------
// describeNode — direct unit tests
// ---------------------------------------------------------------------------

test("describeNode: command node returns raw string", () => {
    const node: import("../types").Command = {
        type: "command", binary: "wc", options: { l: true },
        cmd: [], envPrefix: {}, redirects: [], raw: "wc -l foo.txt",
    };
    expect(describeNode(node)).toBe("wc -l foo.txt");
});

test("describeNode: bash node returns raw string", () => {
    const inner: import("../types").Command = {
        type: "command", binary: "ls", options: {}, cmd: [], envPrefix: {}, redirects: [], raw: "ls",
    };
    const node: import("../types").Bash = { type: "bash", ast: inner, raw: "ls" };
    expect(describeNode(node)).toBe("ls");
});

test("describeNode: binop node rebuilds left op right recursively", () => {
    const left: import("../types").Command = {
        type: "command", binary: "wc", options: {}, cmd: [], envPrefix: {}, redirects: [], raw: "wc -l foo.csv",
    };
    const right: import("../types").Command = {
        type: "command", binary: "head", options: {}, cmd: [], envPrefix: {}, redirects: [], raw: "head -5 foo.csv",
    };
    const node: import("../types").BinOp = { type: "binop", op: "&&", left, right };
    expect(describeNode(node)).toBe("wc -l foo.csv && head -5 foo.csv");
});

test("describeNode: nested binop rebuilds recursively", () => {
    const cmd1: import("../types").Command = {
        type: "command", binary: "a", options: {}, cmd: [], envPrefix: {}, redirects: [], raw: "a",
    };
    const cmd2: import("../types").Command = {
        type: "command", binary: "b", options: {}, cmd: [], envPrefix: {}, redirects: [], raw: "b",
    };
    const cmd3: import("../types").Command = {
        type: "command", binary: "c", options: {}, cmd: [], envPrefix: {}, redirects: [], raw: "c",
    };
    const inner: import("../types").BinOp = { type: "binop", op: ";", left: cmd1, right: cmd2 };
    const outer: import("../types").BinOp = { type: "binop", op: "&&", left: inner, right: cmd3 };
    expect(describeNode(outer)).toBe("a ; b && c");
});

test("describeNode: read node returns file_path", () => {
    const node: import("../types").Read = { type: "read", file_path: "/etc/hosts" };
    expect(describeNode(node)).toBe("/etc/hosts");
});

test("describeNode: write node returns file_path", () => {
    const node: import("../types").Write = { type: "write", file_path: "/tmp/out.txt", content: "" };
    expect(describeNode(node)).toBe("/tmp/out.txt");
});

test("describeNode: edit node returns file_path", () => {
    const node: import("../types").Edit = {
        type: "edit", file_path: "/src/main.ts", old_string: "a", new_string: "b",
    };
    expect(describeNode(node)).toBe("/src/main.ts");
});

test("describeNode: multiedit node returns file_path", () => {
    const node: import("../types").MultiEdit = { type: "multiedit", file_path: "/src/lib.ts", edits: [] };
    expect(describeNode(node)).toBe("/src/lib.ts");
});

test("describeNode: other node returns tool_name", () => {
    const node: import("../types").OtherTool = { type: "other", tool_name: "Grep", tool_input: {} };
    expect(describeNode(node)).toBe("Grep");
});

// ---------------------------------------------------------------------------
// cmd field in logged rule_match entries
// ---------------------------------------------------------------------------

// SpyAuditLogger captures every entry logged during a decide() call.
class SpyAuditLogger implements IAuditLogger {
    // All entries received via log().
    readonly entries: IAuditLogEntry[] = [];

    log(entry: IAuditLogEntry): void {
        this.entries.push(entry);
    }
}

test("rule_match log entry includes cmd matching the command raw string", () => {
    const spy = new SpyAuditLogger();
    rules.push(spyRule({ decision: { action: "allow" } }));
    decide(makeBashCall("head -5 foo.csv"), spy);
    const ruleMatches = spy.entries.filter(
        (entry: IAuditLogEntry) => entry.type === "rule_match"
    ) as IRuleMatchEntry[];
    expect(ruleMatches.length).toBeGreaterThan(0);
    expect(ruleMatches[0].cmd).toBe("head -5 foo.csv");
});

test("rule_match log entries for compound command include per-subcommand raw strings", () => {
    const spy = new SpyAuditLogger();
    rules.push(spyRule({ decision: { action: "allow" } }));
    decide(makeBashCall("wc -l foo.csv && head -5 foo.csv"), spy);
    const ruleMatches = spy.entries.filter(
        (entry: IAuditLogEntry) => entry.type === "rule_match"
    ) as IRuleMatchEntry[];
    const cmds = ruleMatches.map((entry: IRuleMatchEntry) => entry.cmd);
    expect(cmds).toContain("wc -l foo.csv");
    expect(cmds).toContain("head -5 foo.csv");
});
