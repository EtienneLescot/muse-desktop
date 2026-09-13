/**
 * US-15 persistent approval allowlist.
 *
 * - Matching: substring or `*` glob, case-insensitive, over tool name,
 *   summary, and choice scopes.
 * - Conflicts: most-restrictive-wins (forbidden > prompt > allow).
 * - Network scopes without a matching allow rule are effectively denied.
 * - Rules persist in localStorage (survive restarts); scope is stored.
 *
 * Runs on the built-in node:test runner, no extra framework:
 *   npm test
 */
import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  addAllowRule,
  defaultPatternFor,
  isNetworkScope,
  matchingRules,
  patternMatches,
  removeAllowRule,
  resolveApproval,
  setAllowRuleDecision,
  type AllowRule,
  type ApprovalCandidate,
} from "../src/lib/allowlist.ts";
import { loadAllowlist, saveAllowlist } from "../src/lib/persist.ts";

function fakeStorage(): void {
  const m = new Map<string, string>();
  (globalThis as Record<string, unknown>).localStorage = {
    getItem: (k: string): string | null => (m.has(k) ? (m.get(k) as string) : null),
    setItem: (k: string, v: string): void => {
      m.set(k, String(v));
    },
    removeItem: (k: string): void => {
      m.delete(k);
    },
  };
}

function rule(
  pattern: string,
  decision: AllowRule["decision"],
  scope = "",
): AllowRule {
  return { id: `id-${pattern}-${decision}`, pattern, scope, decision, createdAt: 1 };
}

function candidate(
  toolName = "exec",
  summary = "exec: npm test",
  scopes: string[] = ["workspace"],
): ApprovalCandidate {
  return { toolName, summary, scopes };
}

describe("allowlist matching", () => {
  it("matches a substring of tool name or summary, case-insensitively", () => {
    assert.equal(patternMatches("NPM", "exec: npm test"), true);
    assert.equal(patternMatches("exec", "EXEC: npm test"), true);
    assert.equal(patternMatches("cargo", "exec: npm test"), false);
  });

  it("supports * globs", () => {
    assert.equal(patternMatches("npm *", "exec: npm test"), true);
    assert.equal(patternMatches("npm *", "exec: npmtest"), false);
    assert.equal(patternMatches("*test", "exec: npm test"), true);
    assert.equal(patternMatches("*", "anything at all"), true);
  });

  it("never matches an empty pattern", () => {
    assert.equal(patternMatches("   ", "exec: npm test"), false);
  });

  it("matches against scope as well as tool and summary", () => {
    const rules = [rule("workspace", "allow")];
    assert.equal(matchingRules(rules, candidate()).length, 1);
    assert.equal(
      matchingRules(rules, candidate("exec", "exec: x", ["other"])).length,
      0,
    );
  });
});

describe("allowlist conflicts (most-restrictive-wins)", () => {
  it("forbidden beats allow on the same command", () => {
    const rules = [rule("npm", "allow"), rule("npm test", "forbidden")];
    const r = resolveApproval(rules, candidate());
    assert.equal(r.decision, "forbidden");
    assert.equal(r.rule?.pattern, "npm test");
  });

  it("prompt beats allow", () => {
    const rules = [rule("npm", "allow"), rule("npm *", "prompt")];
    const r = resolveApproval(rules, candidate());
    assert.equal(r.decision, "prompt");
  });

  it("allow wins when it is the only match", () => {
    const r = resolveApproval([rule("npm", "allow")], candidate());
    assert.equal(r.decision, "allow");
    assert.equal(r.rule?.decision, "allow");
    assert.equal(r.networkDefaultDeny, false);
  });

  it("defaults to prompt with no matching rule", () => {
    const r = resolveApproval([rule("cargo", "allow")], candidate());
    assert.equal(r.decision, "prompt");
    assert.equal(r.rule, null);
  });
});

describe("allowlist network default-deny", () => {
  it("denies a network scope with no allow rule", () => {
    const c = candidate("fetch", "fetch: https://example.com", ["network"]);
    const r = resolveApproval([], c);
    assert.equal(r.decision, "forbidden");
    assert.equal(r.networkDefaultDeny, true);
  });

  it("denies a URL/domain scope with no allow rule", () => {
    for (const scope of ["https://example.com", "example.com"]) {
      const r = resolveApproval([], candidate("fetch", "fetch", [scope]));
      assert.equal(r.decision, "forbidden", `scope ${scope}`);
    }
  });

  it("allows a network scope covered by a matching allow rule", () => {
    const rules = [rule("fetch", "allow", "network")];
    const c = candidate("fetch", "fetch: https://example.com", ["network"]);
    const r = resolveApproval(rules, c);
    assert.equal(r.decision, "allow");
    assert.equal(r.networkDefaultDeny, false);
  });

  it("still denies network scope matched only by a prompt rule (no allow)", () => {
    const rules = [rule("fetch", "prompt", "network")];
    const c = candidate("fetch", "fetch", ["network"]);
    const r = resolveApproval(rules, c);
    assert.equal(r.decision, "forbidden");
    assert.equal(r.networkDefaultDeny, true);
  });

  it("does not treat plain command scopes as network", () => {
    assert.equal(isNetworkScope("workspace"), false);
    assert.equal(isNetworkScope(""), false);
    assert.equal(isNetworkScope("network"), true);
  });
});

describe("allowlist rule management", () => {
  it("upserts on identical pattern + scope instead of duplicating", () => {
    let rules = addAllowRule([], { pattern: "npm", scope: "workspace", decision: "allow" });
    assert.equal(rules.length, 1);
    const id = rules[0].id;
    rules = addAllowRule(rules, { pattern: "npm", scope: "workspace", decision: "forbidden" });
    assert.equal(rules.length, 1);
    assert.equal(rules[0].id, id);
    assert.equal(rules[0].decision, "forbidden");
  });

  it("keeps distinct scopes as distinct rules", () => {
    let rules: AllowRule[] = [];
    rules = addAllowRule(rules, { pattern: "npm", scope: "a", decision: "allow" });
    rules = addAllowRule(rules, { pattern: "npm", scope: "b", decision: "allow" });
    assert.equal(rules.length, 2);
  });

  it("ignores empty patterns", () => {
    assert.deepEqual(addAllowRule([], { pattern: "  ", scope: "", decision: "allow" }), []);
  });

  it("removes a rule by id (revoke)", () => {
    const rules = addAllowRule([], { pattern: "npm", scope: "", decision: "allow" });
    assert.deepEqual(removeAllowRule(rules, rules[0].id), []);
  });

  it("switches a rule decision (allow/prompt/forbidden)", () => {
    const rules = addAllowRule([], { pattern: "npm", scope: "", decision: "allow" });
    const next = setAllowRuleDecision(rules, rules[0].id, "forbidden");
    assert.equal(next[0].decision, "forbidden");
  });

  it("derives a default pattern from the tool name, else the summary", () => {
    assert.equal(defaultPatternFor("exec", "exec: npm test"), "exec");
    assert.equal(defaultPatternFor("tool", "rm -rf /tmp/x"), "rm");
  });
});

describe("allowlist persistence", () => {
  beforeEach(() => {
    fakeStorage();
  });

  it("returns [] when nothing was memorized", () => {
    assert.deepEqual(loadAllowlist(), []);
  });

  it("round-trips rules with pattern, scope, and decision", () => {
    const rules = addAllowRule([], {
      pattern: "npm",
      scope: "workspace",
      decision: "allow",
    });
    saveAllowlist(rules);
    const back = loadAllowlist();
    assert.equal(back.length, 1);
    assert.equal(back[0].pattern, "npm");
    assert.equal(back[0].scope, "workspace");
    assert.equal(back[0].decision, "allow");
  });

  it("survives a restart-shaped reload (save then fresh load)", () => {
    saveAllowlist([
      { id: "a", pattern: "npm *", scope: "network", decision: "forbidden", createdAt: 7 },
    ]);
    const back = loadAllowlist();
    assert.equal(back.length, 1);
    const r = resolveApproval(back, candidate("npm", "npm publish", ["network"]));
    assert.equal(r.decision, "forbidden");
  });

  it("filters out invalid entries and corrupt payloads", () => {
    (globalThis as Record<string, unknown>).localStorage = {
      getItem: () =>
        JSON.stringify([
          { id: "ok", pattern: "npm", scope: "", decision: "allow", createdAt: 1 },
          { id: "bad", pattern: "", scope: "", decision: "allow", createdAt: 1 },
          { id: "evil", pattern: "x", scope: "", decision: "yes", createdAt: 1 },
        ]),
      setItem: () => {},
      removeItem: () => {},
    };
    const back = loadAllowlist();
    assert.deepEqual(back.map((r) => r.id), ["ok"]);
  });

  it("caps persisted rules to the newest 200", () => {
    const rules: AllowRule[] = Array.from({ length: 250 }, (_, i) => ({
      id: `r-${i}`,
      pattern: `cmd-${i}`,
      scope: "",
      decision: "allow" as const,
      createdAt: i,
    }));
    saveAllowlist(rules);
    const back = loadAllowlist();
    assert.equal(back.length, 200);
    assert.equal(back[0].id, "r-50");
    assert.equal(back[199].id, "r-249");
  });
});
