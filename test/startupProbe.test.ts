import assert from "node:assert/strict";
import test from "node:test";
import {
  startupCheckStatusLabel,
  startupProbeNeedsAttention,
  startupProbeRows,
  startupProbeSummary,
  sanitizeStartupText,
  type StartupProbe,
} from "../src/lib/startupProbe.ts";

const check = (status: StartupProbe["sidecar"]["status"], detail: string) => ({
  status,
  detail,
});

test("startup probe statuses have explicit accessible labels", () => {
  assert.deepEqual(
    (["ready", "missing", "blocked", "unknown"] as const).map(startupCheckStatusLabel),
    ["Ready", "Needs attention", "Blocked", "Not verified"],
  );
});

test("startup probe rows keep a stable runtime order and omit unavailable checks", () => {
  const probe: StartupProbe = {
    platform: "windows",
    sidecar: check("ready", "Sidecar ready"),
    museCli: null,
    workspace: check("ready", "Workspace is reachable"),
    checkedAt: 1,
  };

  assert.deepEqual(
    startupProbeRows(probe).map(({ label, check: row }) => [label, row.status]),
    [
      ["Sidecar", "ready"],
      ["Workspace", "ready"],
    ],
  );
});


test("startup probe summaries keep first-launch guidance textual", () => {
  const needsAttention: StartupProbe = {
    platform: "windows",
    sidecar: check("ready", "Sidecar ready"),
    museCli: check("missing", "Muse CLI missing"),
    workspace: check("blocked", "Workspace is not a folder"),
    checkedAt: 1,
  };
  assert.equal(startupProbeNeedsAttention(needsAttention), true);
  assert.equal(startupProbeSummary(needsAttention), "1/3 checks ready · attention needed");
  const ready: StartupProbe = {
    ...needsAttention,
    museCli: check("ready", "Muse CLI ready"),
    workspace: check("ready", "Workspace folder is accessible"),
  };
  assert.equal(startupProbeNeedsAttention(ready), false);
  assert.equal(startupProbeSummary(ready), "3/3 checks ready");
});

test("startup probe display text removes invisible and replacement characters", () => {
  assert.equal(
    sanitizeStartupText("Muse\u{feff} CLI\u{200b} ready\u{fffd}"),
    "Muse CLI ready",
  );
  const probe: StartupProbe = {
    platform: "windows",
    sidecar: check("blocked", "WSL\u{0} output\u{fffd}"),
    museCli: null,
    workspace: null,
    checkedAt: 1,
  };
  assert.equal(startupProbeRows(probe)[0]?.check.detail, "WSL output");
});

test("M0-07: startup text never ends on half of an emoji split by the bound", () => {
  assert.equal(sanitizeStartupText(`${"x".repeat(3_999)}😀tail`, 4_000), "x".repeat(3_999));
  assert.equal(sanitizeStartupText(`${"x".repeat(3_998)}😀tail`, 4_000), `${"x".repeat(3_998)}😀`);
});

test("startup probe display text repairs legacy interleaved UTF-16 NULs", () => {
  assert.equal(
    sanitizeStartupText("D\u0000e\u0000f\u0000a\u0000u\u0000l\u0000t\u0000: Ubuntu"),
    "Default: Ubuntu",
  );
});
