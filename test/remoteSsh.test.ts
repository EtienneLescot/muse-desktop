import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_REMOTE_MUSE,
  REMOTE_ENGINE_STORAGE_KEY,
  describeRemoteEngine,
  isRemoteWorkspace,
  loadRemoteEngine,
  remoteSignInHint,
  remoteWorkspaceUri,
  saveRemoteEngine,
  validateRemoteEngine,
  worktreeUnavailableReason,
} from "../src/lib/remoteSsh.ts";
import { projectOptionLabels } from "../src/lib/projects.ts";

describe("remote engine target (M4-07)", () => {
  const form = { user: "ops", host: "127.0.0.1", port: 2222, musePath: DEFAULT_REMOTE_MUSE, workspacePath: "/home/ops/proj/" };

  it("builds the same workspace key as remote_ssh.rs", () => {
    const target = validateRemoteEngine(form);
    assert.ok(target);
    assert.equal(target.workspacePath, "/home/ops/proj", "the trailing slash the host drops is dropped");
    assert.equal(remoteWorkspaceUri(target), "ssh://ops@127.0.0.1:2222/home/ops/proj");
    assert.equal(
      remoteWorkspaceUri({ ...target, user: "", host: "box", port: 22, workspacePath: "/srv/app", musePath: "/opt/muse/bin/muse" }),
      "ssh://box:22/srv/app?muse=/opt/muse/bin/muse",
    );
    assert.ok(isRemoteWorkspace(remoteWorkspaceUri(target)));
    assert.ok(!isRemoteWorkspace("C:\\work\\proj"));
  });

  it("lists the target in the picker as user@host and its folder", () => {
    const target = validateRemoteEngine({ ...form, musePath: "/opt/muse/bin/muse" });
    assert.ok(target);
    assert.deepEqual(
      projectOptionLabels([{ projectName: describeRemoteEngine(target), workspace: remoteWorkspaceUri(target) }]),
      ["Remote: ops@127.0.0.1 · proj"],
      "the ?muse= suffix is not taken for the folder",
    );
  });

  it("refuses values the remote shell or ssh would read as syntax", () => {
    for (const hostile of [
      { host: "-oProxyCommand=evil" },
      { user: "-Elog" },
      { port: 0 },
      { workspacePath: "relative/proj" },
      { workspacePath: "/srv/a b" },
      { workspacePath: "/srv;reboot" },
      { musePath: "$(reboot)" },
      { musePath: "~/bin/muse;reboot" },
      { musePath: "" },
    ]) {
      assert.equal(validateRemoteEngine({ ...form, ...hostile }), null, JSON.stringify(hostile));
    }
  });

  it("refuses an invalid user instead of connecting as the default one", () => {
    for (const user of ["u".repeat(65), "ops\nroot", "ops\0x"]) {
      assert.equal(validateRemoteEngine({ ...form, user }), null, JSON.stringify(user));
    }
    assert.equal(validateRemoteEngine({ ...form, user: "" })?.user, "");
  });

  it("sends a remote sign-in to the remote host, not to this computer", () => {
    assert.equal(
      remoteSignInHint("ssh://ops@127.0.0.1:2222/home/ops/proj"),
      "Muse on 127.0.0.1 is not signed in, and signing in on this computer does not reach it. From a terminal, run ssh -p 2222 ops@127.0.0.1, then ~/.local/bin/muse login.",
    );
    assert.ok(remoteSignInHint("ssh://box:22/srv/app?muse=/opt/muse/bin/muse")?.endsWith("run ssh box, then /opt/muse/bin/muse login."));
    assert.equal(remoteSignInHint("C:/work/proj"), null);
    assert.equal(remoteSignInHint("ssh://box:22/srv/app?muse=$(reboot)"), null, "a tampered key is not echoed");
  });

  it("offers no worktree for a remote conversation", () => {
    assert.ok(worktreeUnavailableReason("ssh://box:22/srv/app")?.startsWith("Not available for remote conversations"));
    assert.equal(worktreeUnavailableReason("C:/work/proj"), null);
  });

  it("persists one validated target under a versioned key", () => {
    const store = new Map<string, string>();
    (globalThis as Record<string, unknown>).localStorage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    };
    try {
      const target = validateRemoteEngine(form);
      assert.ok(target && saveRemoteEngine(target));
      assert.deepEqual(loadRemoteEngine(), target);
      store.set(REMOTE_ENGINE_STORAGE_KEY, JSON.stringify({ ...target, host: "bad host" }));
      assert.equal(loadRemoteEngine(), null, "a tampered copy is not trusted");
      assert.ok(saveRemoteEngine(null));
      assert.equal(store.has(REMOTE_ENGINE_STORAGE_KEY), false);
    } finally {
      delete (globalThis as Record<string, unknown>).localStorage;
    }
  });
});
