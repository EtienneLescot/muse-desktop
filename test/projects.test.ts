/**
 * US-3 + US-30 Projects: pure logic (create/quota/attach/prepend/settings
 * override + diff) plus the `muse-desktop.*` persistence round-trip.
 *
 * Runs on the built-in node:test runner, no extra framework:
 *   npm test
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  attachThread,
  buildProjectInput,
  createProject,
  DEFAULT_PROJECT_SETTINGS,
  deleteProject,
  diffProjectSettings,
  MAX_PROJECTS,
  PROJECT_LIMIT_MESSAGE,
  projectOfThread,
  resolveProjectSettings,
  settingsForThread,
  sanitizeProjects,
  setProjectOverride,
  threadsInProject,
  updateProject,
  type Project,
} from "../src/lib/projects.ts";
import {
  loadGlobalSettings,
  loadProjects,
  loadThreadProjects,
  saveGlobalSettings,
  saveProjects,
  saveThreadProjects,
} from "../src/lib/persist.ts";

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

function fill(n: number): Project[] {
  let list: Project[] = [];
  for (let i = 0; i < n; i++) {
    const res = createProject(list, { name: `P${i}`, id: `p${i}` });
    assert.equal(res.error, null);
    list = res.projects;
  }
  return list;
}

describe("US-3 project creation", () => {
  it("creates a project with id, name and instructions", () => {
    const res = createProject([], { name: "  Web  ", instructions: "  be terse " });
    assert.equal(res.error, null);
    assert.ok(res.project !== null);
    assert.equal(res.project.name, "Web");
    assert.equal(res.project.instructions, "be terse");
    assert.ok(res.project.id.length > 0);
    assert.equal(res.projects.length, 1);
  });

  it("keeps a trimmed workspace folder when provided", () => {
    const res = createProject([], {
      name: "Docs",
      workspace: "  C:\\work\\docs  ",
    });
    assert.equal(res.error, null);
    assert.equal(res.project?.workspace, "C:\\work\\docs");
  });

  it("refuses a blank name", () => {
    const res = createProject([], { name: "   " });
    assert.equal(res.project, null);
    assert.match(res.error ?? "", /must not be empty/);
    assert.deepEqual(res.projects, []);
  });

  it("enforces max 5 projects client-side with an explicit message", () => {
    assert.equal(MAX_PROJECTS, 5);
    const full = fill(5);
    const res = createProject(full, { name: "Sixth" });
    assert.equal(res.project, null);
    assert.equal(res.error, PROJECT_LIMIT_MESSAGE);
    assert.match(res.error ?? "", /5/);
    assert.equal(res.projects.length, 5);
  });
});

describe("US-3 thread attach / detach", () => {
  it("attaches and detaches threads", () => {
    const projects = fill(2);
    let map = attachThread({}, projects, "s1", "p0");
    assert.equal(projectOfThread(map, "s1"), "p0");
    assert.deepEqual(threadsInProject(map, "p0"), ["s1"]);
    map = attachThread(map, projects, "s1", null);
    assert.equal(projectOfThread(map, "s1"), null);
    assert.deepEqual(threadsInProject(map, "p0"), []);
  });

  it("treats an unknown project id as a detach (no dangling link)", () => {
    const projects = fill(1);
    const map = attachThread({ s1: "p0" }, projects, "s1", "ghost");
    assert.equal(projectOfThread(map, "s1"), null);
  });

  it("deleting a project ungroups its threads", () => {
    const projects = fill(2);
    const attached = { s1: "p0", s2: "p1" };
    const res = deleteProject(projects, attached, "p0");
    assert.equal(res.projects.length, 1);
    assert.deepEqual(res.attached, { s2: "p1" });
  });

  it("updates name and instructions, ignoring blank renames", () => {
    const projects = fill(1);
    const renamed = updateProject(projects, "p0", {
      name: "  Site  ",
      instructions: "ci strict",
    });
    assert.equal(renamed[0].name, "Site");
    assert.equal(renamed[0].instructions, "ci strict");
    const kept = updateProject(renamed, "p0", { name: "   " });
    assert.equal(kept[0].name, "Site");
  });

  it("updates and clears the project workspace folder", () => {
    const projects = fill(1);
    const set = updateProject(projects, "p0", { workspace: "  C:\\work\\site  " });
    assert.equal(set[0].workspace, "C:\\work\\site");
    const cleared = updateProject(set, "p0", { workspace: "   " });
    assert.equal(cleared[0].workspace, undefined);
  });
});

describe("US-3 instruction prepending", () => {
  it("prepends project instructions before the raw sent input", () => {
    const projects = fill(1);
    const withInstr = updateProject(projects, "p0", { instructions: "be terse" });
    const out = buildProjectInput("  hello  ", withInstr[0]);
    assert.ok(out.includes("be terse"));
    assert.ok(out.endsWith("hello"));
    assert.ok(out.indexOf("be terse") < out.indexOf("hello"));
  });

  it("sends input untouched without a project or with blank instructions", () => {
    const projects = fill(1);
    assert.equal(buildProjectInput("  hi ", null), "hi");
    assert.equal(buildProjectInput("  hi ", undefined), "hi");
    assert.equal(buildProjectInput("  hi ", projects[0]), "hi");
  });
});

describe("US-30 settings override + diff", () => {
  it("inherits global defaults when nothing is overridden", () => {
    const projects = fill(1);
    const eff = resolveProjectSettings(DEFAULT_PROJECT_SETTINGS, projects[0].settings);
    assert.deepEqual(eff, DEFAULT_PROJECT_SETTINGS);
    assert.deepEqual(diffProjectSettings(DEFAULT_PROJECT_SETTINGS, projects[0].settings), []);
  });

  it("applies overrides and shows the global-vs-project diff", () => {
    let projects = fill(1);
    projects = setProjectOverride(projects, "p0", "sandbox", "read-only");
    projects = setProjectOverride(projects, "p0", "model", DEFAULT_PROJECT_SETTINGS.model);
    const eff = resolveProjectSettings(DEFAULT_PROJECT_SETTINGS, projects[0].settings);
    assert.equal(eff.sandbox, "read-only");
    assert.equal(eff.model, DEFAULT_PROJECT_SETTINGS.model);
    // Same-as-global writes inherit: no diff entry for model.
    const diff = diffProjectSettings(DEFAULT_PROJECT_SETTINGS, projects[0].settings);
    assert.equal(diff.length, 1);
    assert.equal(diff[0].key, "sandbox");
    assert.equal(diff[0].global, DEFAULT_PROJECT_SETTINGS.sandbox);
    assert.equal(diff[0].project, "read-only");
  });

  it("clearing an override restores inheritance", () => {
    let projects = fill(1);
    projects = setProjectOverride(projects, "p0", "networkDefault", "deny");
    assert.equal(
      resolveProjectSettings(DEFAULT_PROJECT_SETTINGS, projects[0].settings).networkDefault,
      "deny",
    );
    projects = setProjectOverride(projects, "p0", "networkDefault", undefined);
    assert.deepEqual(diffProjectSettings(DEFAULT_PROJECT_SETTINGS, projects[0].settings), []);
  });

  it("resolves one conversation from its attached project", () => {
    let projects = fill(2);
    projects = setProjectOverride(projects, "p1", "model", "gpt-5.6");
    assert.equal(
      settingsForThread(DEFAULT_PROJECT_SETTINGS, projects, { s1: "p1" }, "s1").model,
      "gpt-5.6",
    );
    assert.deepEqual(
      settingsForThread(DEFAULT_PROJECT_SETTINGS, projects, { s1: "p1" }, "unattached"),
      DEFAULT_PROJECT_SETTINGS,
    );
    assert.deepEqual(
      settingsForThread(DEFAULT_PROJECT_SETTINGS, projects, { s1: "missing" }, "s1"),
      DEFAULT_PROJECT_SETTINGS,
    );
  });
});

describe("US-3/US-30 sanitize + persistence", () => {
  it("drops corrupt rows and caps at the quota", () => {
    const rows: unknown[] = [
      { id: "a", name: "A", instructions: "", createdAt: 1 },
      { id: "", name: "bad", instructions: "", createdAt: 2 },
      "junk",
      null,
    ];
    for (let i = 0; i < 10; i++) {
      rows.push({ id: `x${i}`, name: `X${i}`, instructions: "", createdAt: i });
    }
    const clean = sanitizeProjects(rows);
    assert.ok(clean.length <= MAX_PROJECTS);
    assert.ok(clean.every((p) => p.id.length > 0));
    assert.deepEqual(sanitizeProjects("nope"), []);
  });

  it("round-trips projects, thread map and global settings under muse-desktop.* keys", () => {
    fakeStorage();
    const seen: string[] = [];
    const store = (globalThis as Record<string, Record<string, (k: string, v: string) => void>>)
      .localStorage;
    const rawSet = store.setItem;
    store.setItem = (k: string, v: string): void => {
      seen.push(k);
      rawSet(k, v);
    };
    const projects = fill(2);
    saveProjects(
      updateProject(projects, "p0", {
        instructions: "ship it",
        workspace: "C:\\work\\site",
      }),
    );
    saveThreadProjects({ s1: "p0" });
    saveGlobalSettings({ ...DEFAULT_PROJECT_SETTINGS, sandbox: "full" });
    assert.ok(seen.length > 0);
    assert.ok(seen.every((k) => k.startsWith("muse-desktop.")));
    const back = loadProjects();
    assert.equal(back.find((p) => p.id === "p0")?.instructions, "ship it");
    assert.equal(back.find((p) => p.id === "p0")?.workspace, "C:\\work\\site");
    assert.deepEqual(loadThreadProjects(), { s1: "p0" });
    assert.equal(loadGlobalSettings(DEFAULT_PROJECT_SETTINGS).sandbox, "full");
    // Corrupt payloads fall back safely.
    store.setItem("muse-desktop.projects.v1", "not-json");
    store.setItem("muse-desktop.settings.v1", "{bad");
    assert.deepEqual(loadProjects(), []);
    assert.deepEqual(loadGlobalSettings(DEFAULT_PROJECT_SETTINGS), DEFAULT_PROJECT_SETTINGS);
  });
});
