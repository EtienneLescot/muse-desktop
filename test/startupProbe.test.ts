import assert from "node:assert/strict";
import test from "node:test";
import {
  startupCheckStatusLabel,
  startupProbeRows,
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

