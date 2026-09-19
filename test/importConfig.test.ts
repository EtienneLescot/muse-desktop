import assert from "node:assert/strict";
import test from "node:test";
import {
  dismissImportedSession,
  isKnownConfigPath,
  mergeImportedSessions,
  parseImportPayload,
  type ResumableSession,
} from "../src/lib/importConfig.ts";

function session(id: string, title = id): ResumableSession {
  return { id, title, source: "test" };
}

test("isKnownConfigPath matches files, directory prefixes, and project slots", () => {
  assert.equal(isKnownConfigPath("~/.muse/config.json"), true);
  assert.equal(isKnownConfigPath("~/.muse/sessions/abc123.jsonl"), true);
  assert.equal(isKnownConfigPath("<project>/.muse/settings.json"), true);
  assert.equal(isKnownConfigPath("~/.config/Code/User/prompts/explain.md"), true);
  // The JetBrains entry is a display template: only the literal template
  // string validates, concrete product paths do not.
  assert.equal(isKnownConfigPath("~/.config/JetBrains/<product>/options/"), true);
  assert.equal(isKnownConfigPath("~/.config/JetBrains/IntelliJ/options/other.xml"), false);
  assert.equal(isKnownConfigPath("~/.config/zed/settings.json"), true);
});

test("isKnownConfigPath rejects unknown and degenerate paths", () => {
  assert.equal(isKnownConfigPath("~/.ssh/config"), false);
  assert.equal(isKnownConfigPath("~/.muse/other.json"), false);
  assert.equal(isKnownConfigPath(""), false);
  assert.equal(isKnownConfigPath("   "), false);
});

test("parseImportPayload reports empty files without sessions", () => {
  const summary = parseImportPayload("empty.json", "  \n ");
  assert.deepEqual(summary.sessions, []);
  assert.equal(summary.notes.length, 1);
  assert.match(summary.notes[0], /empty file/);
});

test("parseImportPayload reads JSON sessions with ids, titles, and workspace", () => {
  const summary = parseImportPayload(
    "sessions.json",
    JSON.stringify({
      sessions: [
        { session_id: "abc123", title: "First", workspace: "/repo", lastActive: 42 },
        { id: "def456", name: "Second" },
      ],
    }),
  );
  assert.equal(summary.sessions.length, 2);
  assert.equal(summary.sessions[0].id, "abc123");
  assert.equal(summary.sessions[0].title, "First");
  assert.equal(summary.sessions[0].workspace, "/repo");
  assert.equal(summary.sessions[0].lastActive, 42);
  assert.equal(summary.sessions[1].id, "def456");
  assert.equal(summary.sessions[1].title, "Second");
});

test("parseImportPayload scans session ids from non-JSON formats without throwing", () => {
  const summary = parseImportPayload(
    "config.toml",
    'session_id = "rollout-1"\nsessionId: "rollout-1"\nid="rollout-2"',
  );
  assert.deepEqual(summary.sessions.map((s) => s.id), ["rollout-1", "rollout-2"]);
  assert.match(summary.notes[0], /scanned/);
  const garbage = parseImportPayload("notes.txt", "just some prose, no ids here!!!");
  assert.deepEqual(garbage.sessions, []);
  assert.match(garbage.notes[0], /no importable sessions/);
});

test("parseImportPayload falls back to scanning when JSON is malformed", () => {
  const summary = parseImportPayload("broken.json", '{"oops": true, session_id: "x9y8"}');
  assert.deepEqual(summary.sessions.map((s) => s.id), ["x9y8"]);
  assert.equal(summary.notes.length, 1);
});

test("mergeImportedSessions appends new rows but never overwrites", () => {
  const current = [session("a", "Local title")];
  const merged = mergeImportedSessions(
    current,
    [session("a", "Imported title"), session("b", "New")],
    ["c"],
  );
  assert.deepEqual(merged.map((s) => s.id), ["a", "b"]);
  assert.equal(merged[0].title, "Local title");
  // Live sessions are skipped even when absent from the stored list.
  const withLive = mergeImportedSessions([], [session("c")], ["c"]);
  assert.deepEqual(withLive, []);
});

test("dismissImportedSession drops the id and ignores unknown ids", () => {
  const current = [session("a"), session("b")];
  assert.deepEqual(dismissImportedSession(current, "a").map((s) => s.id), ["b"]);
  assert.strictEqual(dismissImportedSession(current, "missing"), current);
});
