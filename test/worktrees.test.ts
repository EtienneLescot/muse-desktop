/**
 * US-8 worktree helper: per-agent plan, shell snippet, HEAD compare.
 *
 * Runs on the built-in node:test runner, no extra framework:
 *   npm test
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  compareHeadHashes,
  parseSetupEnvAllowlist,
  MAX_SETUP_ENV_NAMES,
  MAX_SETUP_COMMAND_CHARS,
  planWorktrees,
  summarizeWorktreeInspections,
  validateSetupCommand,
  WORKTREE_BASE,
  worktreeShellSnippet,
} from "../src/lib/worktrees.ts";
import { loadWorktrees, saveWorktrees } from "../src/lib/persist.ts";
import {
  loadWorktreeRetention,
  normalizeRetentionDays,
  retentionDecision,
  saveWorktreeRetention,
} from "../src/lib/worktreeRetention.ts";

function fakeStorage(): void {
  const values = new Map<string, string>();
  (globalThis as Record<string, unknown>).localStorage = {
    getItem: (key: string): string | null => values.get(key) ?? null,
    setItem: (key: string, value: string): void => {
      values.set(key, value);
    },
    removeItem: (key: string): void => {
      values.delete(key);
    },
  };
}

describe("planWorktrees", () => {
  it("plans one worktree per agent with path/branch/base shape", () => {
    assert.deepEqual(planWorktrees(["agent-1", "agent-2"]), [
      {
        agent: "agent-1",
        path: ".muse/worktrees/agent-1",
        branch: "task1-branch",
        base: WORKTREE_BASE,
      },
      {
        agent: "agent-2",
        path: ".muse/worktrees/agent-2",
        branch: "task2-branch",
        base: WORKTREE_BASE,
      },
    ]);
  });

  it("skips blanks and duplicates, keeps order", () => {
    const plans = planWorktrees(["a", "  ", "a", "b"]);
    assert.deepEqual(
      plans.map((p) => p.branch),
      ["task1-branch", "task2-branch"],
    );
  });

  it("honours a custom base ref", () => {
    assert.equal(planWorktrees(["a"], "origin/main")[0]?.base, "origin/main");
  });

  it("keeps generated paths inside the worktree root for unsafe or colliding ids", () => {
    const plans = planWorktrees(["../outside", "a/b", "a-b", ".."]);
    assert.deepEqual(
      plans.map((p) => p.path),
      [
        ".muse/worktrees/..-outside",
        ".muse/worktrees/a-b",
        ".muse/worktrees/a-b-2",
        ".muse/worktrees/agent",
      ],
    );
    assert.ok(plans.every((p) => p.path.startsWith(`${".muse/worktrees"}/`)));
  });
});

describe("worktreeShellSnippet", () => {
  it("renders one git worktree add per plan", () => {
    const snippet = worktreeShellSnippet(planWorktrees(["agent-1"]));
    assert.equal(
      snippet,
      "git worktree add .muse/worktrees/agent-1 -b task1-branch HEAD",
    );
  });

  it("is empty for an empty plan list", () => {
    assert.equal(worktreeShellSnippet([]), "");
  });
});

describe("compareHeadHashes", () => {
  it("matches identical hashes", () => {
    const r = compareHeadHashes("abc123", "abc123");
    assert.equal(r.match, true);
    assert.match(r.report, /matches baseline/);
  });

  it("warns report-only on a moved HEAD", () => {
    const r = compareHeadHashes("abc123", "def456");
    assert.equal(r.match, false);
    assert.match(r.report, /HEAD moved/);
    assert.match(r.report, /report-only/);
  });

  it("checks nothing when a hash is missing", () => {
    const r = compareHeadHashes("", "def456");
    assert.equal(r.match, false);
    assert.match(r.report, /nothing checked/);
  });
});

describe("multi-worktree inspection summary", () => {
  it("counts inspected, clean, changed and conflicted records without probing", () => {
    const records = [
      { repoRoot: "C:/repo", path: "C:/repo/.muse/worktrees/a", branch: "task-a", base: "HEAD", createdAt: 1 },
      { repoRoot: "C:/repo", path: "C:/repo/.muse/worktrees/b", branch: "task-b", base: "HEAD", createdAt: 1 },
      { repoRoot: "C:/repo", path: "C:/repo/.muse/worktrees/c", branch: "task-c", base: "HEAD", createdAt: 1 },
    ];
    const summary = summarizeWorktreeInspections(records, {
      "task-a": { repoRoot: "C:/repo", path: records[0].path, branch: "task-a", head: "a", clean: true, conflicted: false, fileCount: 0, observedAt: 2 },
      "task-b": { repoRoot: "C:/repo", path: records[1].path, branch: "task-b", head: "b", clean: false, conflicted: false, fileCount: 2, observedAt: 2 },
      "task-c": { repoRoot: "C:/repo", path: records[2].path, branch: "task-c", head: "c", clean: false, conflicted: true, fileCount: 1, observedAt: 2 },
    });
    assert.deepEqual(summary, { total: 3, inspected: 3, clean: 1, changed: 2, conflicted: 1 });
  });
});

describe("worktree setup command validation", () => {
  it("requires a non-empty command and trims valid input", () => {
    assert.match(validateSetupCommand("   ") ?? "", /must not be empty/);
    assert.equal(validateSetupCommand("  npm install  "), null);
  });

  it("bounds command length", () => {
    assert.match(
      validateSetupCommand("x".repeat(MAX_SETUP_COMMAND_CHARS + 1)) ?? "",
      /limited/,
    );
  });

  it("parses a bounded, de-duplicated environment allowlist", () => {
    assert.deepEqual(parseSetupEnvAllowlist("NODE_ENV, PATH node_env").names, ["NODE_ENV", "PATH"]);
    assert.match(parseSetupEnvAllowlist("BAD-NAME").error ?? "", /Invalid/);
    assert.match(
      parseSetupEnvAllowlist(Array.from({ length: MAX_SETUP_ENV_NAMES + 1 }, (_, i) => `VAR_${i}`).join(",")).error ?? "",
      /limited/,
    );
  });
});

describe("worktree persistence", () => {
  it("round-trips records under the namespaced key and caps old rows", () => {
    fakeStorage();
    const records = Array.from({ length: 105 }, (_, index) => ({
      repoRoot: `C:/repo-${index}`,
      path: `C:/repo-${index}/.muse/worktrees/a`,
      branch: `task-${index}`,
      base: "HEAD",
      createdAt: index,
    }));
    saveWorktrees(records);
    const loaded = loadWorktrees();
    assert.equal(loaded.length, 100);
    assert.equal(loaded[0]?.branch, "task-5");
    assert.equal(loaded.at(-1)?.branch, "task-104");
  });
});

describe("M2-06 retention policy", () => {
  it("persists a repository policy and evaluates only clean inspected records", () => {
    fakeStorage();
    const record = { repoRoot: "C:/repo", path: "C:/repo/.muse/worktrees/a", branch: "task-a", base: "HEAD", createdAt: 0 };
    saveWorktreeRetention(record.repoRoot, { maxAgeDays: 7 });
    assert.deepEqual(loadWorktreeRetention(record.repoRoot), { maxAgeDays: 7 });
    const missing = retentionDecision(record, undefined, { maxAgeDays: 7 }, 8 * 86_400_000);
    assert.equal(missing.eligible, false);
    const dirty = retentionDecision(record, { repoRoot: record.repoRoot, path: record.path, branch: record.branch, head: "abc", clean: false, conflicted: false, fileCount: 1, observedAt: 1 }, { maxAgeDays: 7 }, 8 * 86_400_000);
    assert.match(dirty.reason, /Protected/);
    const active = retentionDecision(record, { repoRoot: record.repoRoot, path: record.path, branch: record.branch, head: "abc", clean: true, conflicted: false, fileCount: 0, activeSignals: ["index lock"], observedAt: 1 }, { maxAgeDays: 7 }, 8 * 86_400_000);
    assert.match(active.reason, /active operation/);
    const eligible = retentionDecision(record, { repoRoot: record.repoRoot, path: record.path, branch: record.branch, head: "abc", clean: true, conflicted: false, fileCount: 0, observedAt: 1 }, { maxAgeDays: 7 }, 8 * 86_400_000);
    assert.equal(eligible.eligible, true);
    assert.equal(normalizeRetentionDays("0"), null);
    assert.equal(normalizeRetentionDays("30"), 30);
  });
});
