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
  MAX_SETUP_COMMAND_CHARS,
  planWorktrees,
  validateSetupCommand,
  WORKTREE_BASE,
  worktreeShellSnippet,
} from "../src/lib/worktrees.ts";
import { loadWorktrees, saveWorktrees } from "../src/lib/persist.ts";

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
