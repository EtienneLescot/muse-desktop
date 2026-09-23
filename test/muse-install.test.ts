import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { installHeadline, parseInstallStatus } from "../src/lib/museInstall.ts";

describe("Muse CLI install status", () => {
  it("rejects payloads that are not an install status", () => {
    assert.equal(parseInstallStatus(null), null);
    assert.equal(parseInstallStatus({ state: "hacked" }), null);
  });

  it("normalizes a running installer waiting for sign-in", () => {
    const status = parseInstallStatus({ state: "running", log: "Press Enter", awaitingEnter: true, exitCode: "x" });
    assert.ok(status);
    assert.equal(status.exitCode, null);
    assert.match(installHeadline(status), /Sign in to Meta/);
  });

  it("explains failures with the exit code", () => {
    const status = parseInstallStatus({ state: "failed", exitCode: 22, log: "" });
    assert.match(installHeadline(status), /exit code 22/);
    assert.match(installHeadline(null), /not installed/);
  });

  it("keeps only a well-formed sign-in code for muse login", () => {
    const ok = parseInstallStatus({ kind: "login", state: "running", signInCode: "AB12-CD34" });
    assert.equal(ok?.kind, "login");
    assert.equal(ok?.signInCode, "AB12-CD34");
    assert.match(installHeadline(ok), /Confirm this code/);
    const bad = parseInstallStatus({ kind: "login", state: "running", signInCode: "<img src=x>" });
    assert.equal(bad?.signInCode, null);
  });
});
