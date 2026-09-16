/**
 * US-24 connectors + US-26 remote guard: 1-click local install from the
 * curated directory, hot-list tools without restart, single-remote guard
 * with explicit public-internet/allowlist messaging.
 *
 * Runs on the built-in node:test runner, no extra framework (npm test).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CURATED_CONNECTORS,
  diffTools,
  findCurated,
  installConnector,
  isPublicHttpUrl,
  listConnectorTools,
  loadConnectors,
  REMOTE_LIMIT_MESSAGE,
  requestRemoteConnector,
  registerLocalConnector,
  setConnectorEnabled,
  uninstallConnector,
  VPN_FAILURE_MESSAGE,
  type ConnectorEntry,
} from "../src/lib/connectors.ts";

function installed(id: string): ConnectorEntry[] {
  const r = installConnector([], id, 1000);
  assert.ok(r);
  return r.registry;
}

describe("curated directory", () => {
  it("ships reviewed entries with at least one tool each", () => {
    assert.ok(CURATED_CONNECTORS.length >= 3);
    for (const c of CURATED_CONNECTORS) {
      assert.ok(c.id.length > 0);
      assert.ok(c.tools.length > 0);
    }
  });

  it("findCurated returns null for unknown ids", () => {
    assert.equal(findCurated("nope"), null);
  });
});

describe("installConnector (1-click local, no JSON)", () => {
  it("installs a curated connector with its tools", () => {
    const r = installConnector([], "local-git", 1000);
    assert.ok(r);
    assert.equal(r.already, false);
    assert.equal(r.registry.length, 1);
    assert.equal(r.entry.kind, "local");
    assert.equal(r.entry.status, "installed");
    assert.deepEqual(
      r.entry.tools.map((t) => t.name),
      ["git.status", "git.log", "git.diff"],
    );
  });

  it("is idempotent: reinstall returns the existing entry", () => {
    const first = installConnector([], "local-fetch", 1000);
    assert.ok(first);
    const second = installConnector(first.registry, "local-fetch", 2000);
    assert.ok(second);
    assert.equal(second.already, true);
    assert.equal(second.registry.length, 1);
  });

  it("refuses unknown ids (no manual JSON path)", () => {
    assert.equal(installConnector([], "evil-custom", 1000), null);
  });
});

describe("verified local MCP connector registration", () => {
  it("stores the command and real tools after a successful probe", () => {
    const result = registerLocalConnector(
      [],
      {
        id: "local-mcp-demo",
        name: "Demo",
        command: "node server.js",
        tools: [{ name: "demo.read", description: "Read demo data" }],
      },
      1234,
    );
    assert.ok(result);
    assert.equal(result.entry.command, "node server.js");
    assert.equal(result.entry.lastProbeAt, 1234);
    assert.deepEqual(listConnectorTools(result.registry).map((tool) => tool.name), ["demo.read"]);
  });

  it("updates an existing connector without re-enabling a disabled entry", () => {
    const first = registerLocalConnector([], {
      id: "local-mcp-demo",
      name: "Demo",
      command: "demo",
      tools: [{ name: "one", description: "" }],
    });
    assert.ok(first);
    const disabled = setConnectorEnabled(first.registry, "local-mcp-demo", false).registry;
    const refreshed = registerLocalConnector(disabled, {
      id: "local-mcp-demo",
      name: "Demo",
      command: "demo --new",
      tools: [{ name: "two", description: "" }],
    });
    assert.ok(refreshed);
    assert.equal(refreshed.entry.status, "disabled");
    assert.equal(refreshed.entry.command, "demo --new");
  });
});

describe("uninstall + enable", () => {
  it("uninstall removes the entry; missing id is a no-op", () => {
    const reg = installed("local-fetch");
    assert.deepEqual(uninstallConnector(reg, "local-fetch"), {
      registry: [],
      removed: true,
    });
    assert.deepEqual(uninstallConnector(reg, "missing"), {
      registry: reg,
      removed: false,
    });
  });

  it("disabling hides tools; re-enabling restores them", () => {
    let reg = installed("local-fetch");
    assert.equal(listConnectorTools(reg).length, 1);
    const off = setConnectorEnabled(reg, "local-fetch", false);
    assert.equal(off.changed, true);
    assert.equal(listConnectorTools(off.registry).length, 0);
    reg = off.registry;
    const on = setConnectorEnabled(reg, "local-fetch", true);
    assert.equal(on.changed, true);
    assert.equal(listConnectorTools(on.registry).length, 1);
  });

  it("toggling a missing id changes nothing", () => {
    const reg = installed("local-fetch");
    assert.deepEqual(setConnectorEnabled(reg, "missing", false), {
      registry: reg,
      changed: false,
    });
  });
});

describe("hot-list tools without restart (list_changed)", () => {
  it("re-reads the registry: a fresh install shows up immediately", () => {
    let reg: ConnectorEntry[] = [];
    assert.deepEqual(listConnectorTools(reg), []);
    const r = installConnector(reg, "local-sqlite", 1000);
    assert.ok(r);
    reg = r.registry;
    assert.deepEqual(
      listConnectorTools(reg).map((t) => t.name),
      ["sqlite.query", "sqlite.schema"],
    );
  });

  it("diffTools reports added/removed tool names", () => {
    const before = listConnectorTools(installed("local-fetch"));
    const after = listConnectorTools([
      ...installed("local-fetch"),
      ...installed("local-git"),
    ]);
    const d = diffTools(before, after);
    assert.deepEqual(d.added, ["git.status", "git.log", "git.diff"]);
    assert.deepEqual(d.removed, []);
    assert.deepEqual(diffTools(after, before).removed, [
      "git.status",
      "git.log",
      "git.diff",
    ]);
  });
});

describe("remote guard (US-26: single remote + public internet)", () => {
  it("accepts one public https remote as a bookkeeping entry", () => {
    const r = requestRemoteConnector(
      installed("local-fetch"),
      { id: "remote-acme", name: "Acme", url: "https://mcp.acme.com/rpc" },
      1000,
    );
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.entry.kind, "remote");
      assert.equal(r.registry.length, 2);
    }
  });

  it("blocks a second remote with the explicit single-remote message", () => {
    const first = requestRemoteConnector([], {
      id: "r1",
      name: "R1",
      url: "https://mcp.one.com/x",
    });
    assert.equal(first.ok, true);
    const second = requestRemoteConnector(first.registry, {
      id: "r2",
      name: "R2",
      url: "https://mcp.two.com/x",
    });
    assert.equal(second.ok, false);
    if (!second.ok) {
      assert.equal(second.code, "remote-limit");
      assert.equal(second.message, REMOTE_LIMIT_MESSAGE);
      assert.ok(second.message.includes("public-internet"));
    }
  });

  it("refuses private/VPN hosts with the documented failure message", () => {
    for (const url of [
      "http://mcp.acme.com/rpc",
      "https://localhost:8443/x",
      "https://10.1.2.3/x",
      "https://192.168.0.9/x",
      "https://172.20.4.1/x",
      "https://printer.local/x",
    ]) {
      const r = requestRemoteConnector([], { id: "r", name: "R", url });
      assert.equal(r.ok, false, url);
      if (!r.ok) {
        assert.equal(r.code, "private-network");
        assert.equal(r.message, VPN_FAILURE_MESSAGE);
      }
    }
  });

  it("isPublicHttpUrl accepts public https and rejects the rest", () => {
    assert.equal(isPublicHttpUrl("https://mcp.acme.com/rpc"), true);
    assert.equal(isPublicHttpUrl("http://mcp.acme.com/rpc"), false);
    assert.equal(isPublicHttpUrl("https://127.0.0.1/x"), false);
    assert.equal(isPublicHttpUrl("not a url"), false);
  });
});

describe("persistence", () => {
  it("loads [] without localStorage (node:test has none)", () => {
    assert.deepEqual(loadConnectors(), []);
  });
});
