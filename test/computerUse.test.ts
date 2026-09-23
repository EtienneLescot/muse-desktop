import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  COMPUTER_LEVELS,
  DRIVER_INSTALL_COMMAND,
  describeComputerUse,
  failedProbes,
  GRANT_STATES,
  LEVEL_INFO,
  levelToolCount,
  parseComputerStatus,
  type ComputerStatus,
} from "../src/lib/computerUse.ts";

function payload(overrides: Record<string, unknown> = {}) {
  return {
    driverPath: "C:\\Users\\u\\AppData\\Local\\Programs\\Cua\\cua-driver\\bin\\cua-driver.exe",
    driverVersion: "cua-driver 0.28.2",
    available: true,
    levelCounts: { observe: 19, act: 57 },
    unclassified: [],
    grantState: "stopped",
    manifest: null,
    manifestDigest: null,
    doctor: {
      ok: true,
      probes: [
        { label: "binary", status: "ok", message: "cua-driver 0.28.2 (x86_64-windows)" },
        {
          label: "interactive session",
          status: "ok",
          message: "session 1 has an attached interactive desktop",
        },
      ],
    },
    ...overrides,
  };
}

describe("computer use", () => {
  it("reads the native payload", () => {
    const status = parseComputerStatus(payload());
    assert.ok(status);
    assert.equal(status.available, true);
    assert.equal(status.grantState, "stopped");
    assert.equal(status.levelCounts.act, 57);
    assert.equal(status.doctor?.probes?.length, 2);
  });

  it("refuses a payload it cannot trust", () => {
    assert.equal(parseComputerStatus(null), null);
    assert.equal(parseComputerStatus("cua-driver"), null);
    assert.equal(parseComputerStatus(payload({ grantState: "on" })), null);
    assert.equal(parseComputerStatus(payload({ available: "yes" })), null);
    // Unknown probe rows are dropped rather than rendered as empty labels.
    const partial = parseComputerStatus(
      payload({ doctor: { ok: false, probes: [{ label: "binary" }, 7, null] } }),
    );
    assert.ok(partial);
    assert.deepEqual(partial.doctor?.probes, []);
  });

  it("never invents a tool count", () => {
    const status = parseComputerStatus(payload({ levelCounts: { act: 57 } }));
    assert.ok(status);
    assert.equal(levelToolCount(status, "act"), 57);
    assert.equal(levelToolCount(status, "observe"), 0);
    assert.equal(levelToolCount(null, "act"), 0);
  });

  it("tells the truth when the driver is missing", () => {
    const missing = parseComputerStatus(
      payload({ available: false, driverPath: null, driverVersion: null, levelCounts: {} }),
    );
    assert.ok(missing);
    assert.equal(
      describeComputerUse(missing),
      "The CUA driver is not installed. Muse cannot see or control this computer.",
    );
    assert.match(DRIVER_INSTALL_COMMAND, /^irm https:\/\/cua\.ai\/driver\/install\.ps1 \| iex$/);
  });

  it("distinguishes a lapsed grant from a stopped one", () => {
    // A service that is up can hold a grant that is over. Saying "enabled" there
    // is the failure this feature exists to avoid.
    const expired = parseComputerStatus(payload({ grantState: "expired" }));
    assert.ok(expired);
    assert.match(describeComputerUse(expired), /lapsed/);
    const stopped = parseComputerStatus(payload({ grantState: "stopped" }));
    assert.ok(stopped);
    assert.equal(describeComputerUse(stopped), "Muse cannot control this computer.");
  });

  it("reports the driver's failing probes and not ours", () => {
    const status = parseComputerStatus(
      payload({
        doctor: {
          ok: false,
          probes: [
            { label: "binary", status: "ok", message: "fine" },
            { label: "interactive session", status: "fail", message: "no interactive desktop" },
          ],
        },
      }),
    );
    assert.ok(status);
    const failed = failedProbes(status);
    assert.equal(failed.length, 1);
    assert.equal(failed[0].label, "interactive session");
  });

  it("describes every level in one sentence and in order", () => {
    assert.deepEqual([...COMPUTER_LEVELS], ["observe", "act"]);
    for (const level of COMPUTER_LEVELS) {
      const info = LEVEL_INFO[level];
      assert.equal(info.level, level);
      assert.ok(info.label.length > 0);
      assert.ok(info.summary.length > 20);
    }
    assert.deepEqual([...GRANT_STATES], ["stopped", "active", "expired", "permissions"]);
  });

  it("survives a round trip through JSON, as the bridge does", () => {
    const status: ComputerStatus = parseComputerStatus(JSON.parse(JSON.stringify(payload())))!;
    assert.equal(status.driverVersion, "cua-driver 0.28.2");
    assert.deepEqual(status.unclassified, []);
  });
});

describe("macOS permissions for CuaDriver", () => {
  it("keeps only the two grants, in the order the user gives them", async () => {
    const { parseComputerStatus, PRIVACY_STEPS } = await import("../src/lib/computerUse.ts");
    const base = { available: true, grantState: "permissions", levelCounts: {}, unclassified: [] };
    const status = parseComputerStatus({ ...base, permissions: { accessibility: true, screenRecording: false, extra: 1 } });
    assert.deepEqual(status?.permissions, { accessibility: true, screenRecording: false });
    assert.equal(parseComputerStatus({ ...base, permissions: { accessibility: "yes" } })?.permissions, null);
    assert.deepEqual(PRIVACY_STEPS.map((step) => step.pane), ["accessibility", "screenRecording"]);
  });
});
