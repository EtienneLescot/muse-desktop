import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  loadSetupProfiles,
  removeSetupProfile,
  SETUP_PROFILES_KEY,
  upsertSetupProfile,
} from "../src/lib/setupProfiles.ts";

function fakeStorage() {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, String(value)),
    removeItem: (key: string) => values.delete(key),
    key: (index: number) => [...values.keys()][index] ?? null,
    get length() { return values.size; },
  };
  (globalThis as Record<string, unknown>).localStorage = storage;
  return values;
}

describe("M2-04 setup profiles", () => {
  beforeEach(() => fakeStorage());

  it("scopes profiles to a workspace and round-trips them", () => {
    const workspace = "C:/Repo/App";
    const created = upsertSetupProfile(workspace, [], { name: "Node", command: "npm ci" }, 100);
    assert.ok(created.profile);
    assert.equal(loadSetupProfiles(workspace)[0]?.command, "npm ci");
    assert.deepEqual(loadSetupProfiles("C:/Repo/Other"), []);
  });

  it("updates by name without creating duplicates", () => {
    const workspace = "/repo";
    const first = upsertSetupProfile(workspace, [], { name: "Node", command: "npm ci" }, 100);
    const second = upsertSetupProfile(workspace, first.profiles, { name: "node", command: "npm install" }, 200);
    assert.equal(second.profiles.length, 1);
    assert.equal(second.profile?.id, first.profile?.id);
    assert.equal(loadSetupProfiles(workspace)[0]?.command, "npm install");
  });

  it("persists extra environment names per profile", () => {
    const workspace = "/repo";
    const created = upsertSetupProfile(workspace, [], {
      name: "Node",
      command: "npm ci",
      envAllowlist: ["NODE_ENV", "PATH", "node_env", "BAD-NAME"],
    }, 100);
    assert.deepEqual(created.profile?.envAllowlist, ["NODE_ENV", "PATH"]);
    assert.deepEqual(loadSetupProfiles(workspace)[0]?.envAllowlist, ["NODE_ENV", "PATH"]);
  });

  it("rejects blank input and removes one profile", () => {
    const workspace = "/repo";
    assert.equal(upsertSetupProfile(workspace, [], { name: " ", command: "npm ci" }).profile, null);
    const created = upsertSetupProfile(workspace, [], { name: "Node", command: "npm ci" }, 100);
    const next = removeSetupProfile(workspace, created.profiles, created.profile!.id);
    assert.deepEqual(next, []);
    assert.deepEqual(loadSetupProfiles(workspace), []);
  });

  it("keeps the storage key namespaced", () => {
    const values = fakeStorage();
    upsertSetupProfile("/repo", [], { name: "Node", command: "npm ci" });
    assert.ok(values.has(SETUP_PROFILES_KEY));
    assert.equal([...values.keys()].some((key) => !key.startsWith("muse-desktop.")), false);
  });
});
