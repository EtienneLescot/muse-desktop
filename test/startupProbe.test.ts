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
    wsl: check("blocked", "WSL needs attention"),
    museCli: null,
    workspace: check("ready", "Workspace is reachable"),
    checkedAt: 1,
  };

  assert.deepEqual(
    startupProbeRows(probe).map(({ label, check: row }) => [label, row.status]),
    [
      ["Sidecar", "ready"],
      ["WSL", "blocked"],
      ["Workspace", "ready"],
    ],
  );
});


test("startup probe summaries keep first-launch guidance textual", () => {
  const needsAttention: StartupProbe = {
    platform: "windows",
    sidecar: check("ready", "Sidecar ready"),
    wsl: check("blocked", "WSL is not ready"),
    museCli: check("missing", "Muse CLI missing"),
    workspace: null,
    checkedAt: 1,
  };
  assert.equal(startupProbeNeedsAttention(needsAttention), true);
  assert.equal(startupProbeSummary(needsAttention), "1/3 checks ready · attention needed");
  const ready: StartupProbe = {
    ...needsAttention,
    wsl: check("ready", "WSL ready"),
    museCli: check("ready", "Muse CLI ready"),
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
    wsl: null,
    museCli: null,
    workspace: null,
    checkedAt: 1,
  };
  assert.equal(startupProbeRows(probe)[0]?.check.detail, "WSL output");
});
