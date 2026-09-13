/**
 * w-settings (US-16 sandbox + US-31 providers): pure settings logic.
 *
 * - Sandbox defaults to workspace-confined; network/elevated need their
 *   explicit persisted permission or the effective mode falls back.
 * - Provider registry is a local sample list (never a live backend list);
 *   selection validates per project.
 * - Out-of-scope containment check fails closed.
 *
 * Runs on the built-in node:test runner, no extra framework:
 *   npm test
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CONFIGURED_PROVIDERS,
  DEFAULT_PROVIDER_ID,
  DEFAULT_SANDBOX,
  PROVIDER_MAP_KEY,
  SETTINGS_KEY,
  WEB_SEARCH_DEFAULT_NOTE,
  canSelectMode,
  effectiveSandboxMode,
  isOutsideWorkspace,
  isRelaxedSandbox,
  isSandboxMode,
  liveProviderEntries,
  parseModelList,
  parseLiveModel,
  parseProviderId,
  parseProviderMap,
  parseSandboxSettings,
  providerById,
  providerForProject,
  type SandboxSettings,
} from "../src/lib/settings.ts";

describe("sandbox settings", () => {
  it("defaults to workspace-confined with no permissions", () => {
    assert.deepEqual(DEFAULT_SANDBOX, {
      mode: "workspace",
      networkAllowed: false,
      elevatedAllowed: false,
    });
    assert.equal(effectiveSandboxMode(DEFAULT_SANDBOX), "workspace");
    assert.equal(isRelaxedSandbox(DEFAULT_SANDBOX), false);
  });

  it("storage keys live under muse-desktop.*", () => {
    assert.match(SETTINGS_KEY, /^muse-desktop\./);
    assert.match(PROVIDER_MAP_KEY, /^muse-desktop\./);
  });

  it("parses stored settings, falling back per field", () => {
    assert.deepEqual(parseSandboxSettings(null), DEFAULT_SANDBOX);
    assert.deepEqual(parseSandboxSettings(undefined), DEFAULT_SANDBOX);
    assert.deepEqual(parseSandboxSettings("workspace"), DEFAULT_SANDBOX);
    assert.deepEqual(
      parseSandboxSettings({ mode: "network", networkAllowed: true }),
      { mode: "network", networkAllowed: true, elevatedAllowed: false },
    );
    // Unknown mode falls back; valid toggles are preserved.
    assert.deepEqual(
      parseSandboxSettings({ mode: "root", elevatedAllowed: true }),
      { mode: "workspace", networkAllowed: false, elevatedAllowed: true },
    );
    // Non-boolean toggles fall back.
    assert.deepEqual(
      parseSandboxSettings({ mode: "workspace", networkAllowed: "yes" }),
      DEFAULT_SANDBOX,
    );
  });

  it("fails closed: selected mode needs its explicit permission", () => {
    const net: SandboxSettings = {
      mode: "network",
      networkAllowed: false,
      elevatedAllowed: false,
    };
    assert.equal(effectiveSandboxMode(net), "workspace");
    assert.equal(isRelaxedSandbox(net), false);
    assert.equal(
      effectiveSandboxMode({ ...net, networkAllowed: true }),
      "network",
    );
    const elev: SandboxSettings = {
      mode: "elevated",
      networkAllowed: true,
      elevatedAllowed: false,
    };
    assert.equal(effectiveSandboxMode(elev), "workspace");
    assert.equal(
      effectiveSandboxMode({ ...elev, elevatedAllowed: true }),
      "elevated",
    );
  });

  it("canSelectMode gates network/elevated on permission", () => {
    assert.equal(canSelectMode(DEFAULT_SANDBOX, "workspace"), true);
    assert.equal(canSelectMode(DEFAULT_SANDBOX, "network"), false);
    assert.equal(canSelectMode(DEFAULT_SANDBOX, "elevated"), false);
    assert.equal(
      canSelectMode({ ...DEFAULT_SANDBOX, networkAllowed: true }, "network"),
      true,
    );
    assert.equal(
      canSelectMode({ ...DEFAULT_SANDBOX, elevatedAllowed: true }, "elevated"),
      true,
    );
  });

  it("isSandboxMode accepts only the three known modes", () => {
    assert.equal(isSandboxMode("workspace"), true);
    assert.equal(isSandboxMode("network"), true);
    assert.equal(isSandboxMode("elevated"), true);
    assert.equal(isSandboxMode("root"), false);
    assert.equal(isSandboxMode(null), false);
  });

  it("web-search default note says off by default", () => {
    assert.match(WEB_SEARCH_DEFAULT_NOTE, /off by default/);
  });
});

describe("provider registry", () => {
  it("holds 2-3 entries, all marked sample", () => {
    assert.ok(
      CONFIGURED_PROVIDERS.length >= 2 && CONFIGURED_PROVIDERS.length <= 3,
    );
    for (const p of CONFIGURED_PROVIDERS) {
      assert.equal(p.sample, true);
      assert.ok(p.id.length > 0 && p.label.length > 0 && p.model.length > 0);
    }
    assert.equal(DEFAULT_PROVIDER_ID, CONFIGURED_PROVIDERS[0].id);
  });

  it("providerById resolves known ids, null otherwise", () => {
    assert.deepEqual(providerById(DEFAULT_PROVIDER_ID), CONFIGURED_PROVIDERS[0]);
    assert.equal(providerById("nope"), null);
  });

  it("parseProviderId falls back to the default on unknown", () => {
    assert.equal(parseProviderId(DEFAULT_PROVIDER_ID), DEFAULT_PROVIDER_ID);
    assert.equal(parseProviderId("nope"), DEFAULT_PROVIDER_ID);
    assert.equal(parseProviderId(null), DEFAULT_PROVIDER_ID);
    assert.equal(parseProviderId(""), DEFAULT_PROVIDER_ID);
  });

  it("parseProviderMap keeps only valid project -> known-provider pairs", () => {
    assert.deepEqual(parseProviderMap(null), {});
    assert.deepEqual(parseProviderMap([]), {});
    assert.deepEqual(
      parseProviderMap({
        "/ws/a": CONFIGURED_PROVIDERS[1].id,
        "/ws/b": "nope",
        "": CONFIGURED_PROVIDERS[0].id,
        "/ws/c": 42,
      }),
      { "/ws/a": CONFIGURED_PROVIDERS[1].id },
    );
  });

  it("providerForProject resolves per project, default otherwise", () => {
    const map = { "/ws/a": CONFIGURED_PROVIDERS[1].id };
    assert.equal(
      providerForProject(map, "/ws/a"),
      CONFIGURED_PROVIDERS[1].id,
    );
    assert.equal(providerForProject(map, "/ws/other"), DEFAULT_PROVIDER_ID);
    assert.equal(providerForProject(map, null), DEFAULT_PROVIDER_ID);
    assert.equal(
      providerForProject({ "/ws/a": "stale-unknown" }, "/ws/a"),
      DEFAULT_PROVIDER_ID,
    );
  });
});

describe("workspace containment", () => {
  it("inside paths are not outside", () => {
    assert.equal(isOutsideWorkspace("/ws", "/ws"), false);
    assert.equal(isOutsideWorkspace("/ws", "/ws/src/a.ts"), false);
    assert.equal(isOutsideWorkspace("/ws/", "/ws/src/a.ts"), false);
  });

  it("outside paths are outside", () => {
    assert.equal(isOutsideWorkspace("/ws", "/etc/passwd"), true);
    assert.equal(isOutsideWorkspace("/ws", "/ws-other/a.ts"), true);
    assert.equal(isOutsideWorkspace("/ws", "/workspace/a.ts"), true);
  });

  it("fails closed on missing root or path", () => {
    assert.equal(isOutsideWorkspace(null, "/ws/a.ts"), true);
    assert.equal(isOutsideWorkspace("", "/ws/a.ts"), true);
    assert.equal(isOutsideWorkspace("/ws", ""), true);
    assert.equal(isOutsideWorkspace("/ws", "   "), true);
  });
});

describe("live model catalog (US-31)", () => {
  const liveRow = {
    modelId: "muse-spark-1.3-contributor",
    displayLabel: "muse-spark-1.3-contributor",
    providerId: "meta",
    profileId: "tbh",
    isActive: false,
    isDefault: true,
    contextLimit: 1007997,
  };

  it("parses a full live row, keeps host flags", () => {
    const m = parseLiveModel(liveRow);
    assert.ok(m !== null);
    assert.equal(m.modelId, "muse-spark-1.3-contributor");
    assert.equal(m.providerId, "meta");
    assert.equal(m.profileId, "tbh");
    assert.equal(m.isActive, false);
    assert.equal(m.isDefault, true);
  });

  it("drops rows without a usable id, defaults the rest", () => {
    assert.equal(parseLiveModel(null), null);
    assert.equal(parseLiveModel({}), null);
    assert.equal(parseLiveModel({ modelId: "" }), null);
    const sparse = parseLiveModel({ id: "legacy-1" });
    assert.ok(sparse !== null);
    assert.equal(sparse.displayLabel, "legacy-1");
    assert.equal(sparse.providerId, "");
    assert.equal(sparse.profileId, null);
    assert.equal(sparse.isActive, false);
  });

  it("parseModelList keeps valid rows, drops the rest", () => {
    assert.deepEqual(parseModelList("nope"), []);
    assert.deepEqual(parseModelList(null), []);
    const out = parseModelList([liveRow, {}, { modelId: "m-2" }]);
    assert.equal(out.length, 2);
    assert.equal(out[1].modelId, "m-2");
  });

  it("live entries are never samples", () => {
    const entries = liveProviderEntries(parseModelList([liveRow]));
    assert.equal(entries.length, 1);
    assert.equal(entries[0].sample, false);
    assert.equal(entries[0].model, "muse-spark-1.3-contributor");
  });
});
