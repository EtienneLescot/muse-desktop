/**
 * US-33: sidecar startup errors must surface explicitly (message + expected
 * paths + actions), never as a blank screen.
 *
 * Runs on the built-in node:test runner, no extra framework:
 *   npm test
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  classifySidecarError,
  extractTriedPaths,
  isSidecarError,
  startupRecoverySteps,
} from "../src/lib/sidecarError.ts";

const MISSING =
  "start_session failed: sidecar binary not found: expected `binaries/muse-x86_64-unknown-linux-gnu` (file name carries the target triple). Tried (1) bundled layout next to the app executable, then (2) dev tree src-tauri/binaries (tried /app/binaries/muse-x86_64-unknown-linux-gnu, /src/src-tauri/binaries/muse-x86_64-unknown-linux-gnu). Place the binary matching your target triple at one of those locations (see src-tauri/binaries/README.md).";

describe("sidecar error classification", () => {
  it("detects a missing binary, even wrapped in the hook prefix", () => {
    assert.equal(classifySidecarError(MISSING), "missing");
    assert.equal(isSidecarError(MISSING), true);
  });

  it("detects spawn and handshake failures as start-failed", () => {
    assert.equal(
      classifySidecarError("start_session failed: could not spawn sidecar `muse serve` in /w: boom"),
      "start-failed",
    );
    assert.equal(
      classifySidecarError("sidecar command failed for /b: denied"),
      "start-failed",
    );
    assert.equal(
      classifySidecarError("MSP handshake failed (nope). Host stderr: x"),
      "start-failed",
    );
    assert.equal(
      classifySidecarError("send_input failed: no sidecar host — start a session first"),
      "start-failed",
    );
  });

  it("ignores unrelated errors and empty input", () => {
    assert.equal(classifySidecarError("start_session failed: boom"), null);
    assert.equal(classifySidecarError("event poll failed: x"), null);
    assert.equal(classifySidecarError(null), null);
    assert.equal(classifySidecarError(""), null);
    assert.equal(isSidecarError(undefined), false);
  });

  it("never throws on garbage", () => {
    assert.equal(classifySidecarError("{oops"), null);
  });
});

describe("tried-path extraction", () => {
  it("parses both probed paths from the missing-binary message", () => {
    assert.deepEqual(extractTriedPaths(MISSING), [
      "/app/binaries/muse-x86_64-unknown-linux-gnu",
      "/src/src-tauri/binaries/muse-x86_64-unknown-linux-gnu",
    ]);
  });

  it("returns [] when the message carries no tried list", () => {
    assert.deepEqual(extractTriedPaths("sidecar binary not found"), []);
    assert.deepEqual(extractTriedPaths(""), []);
  });
});

describe("startup recovery guidance", () => {
  it("explains the WSL and Muse checks from bridge evidence", () => {
    const steps = startupRecoverySteps(
      "start-failed",
      "Muse WSL adapter: Install Muse in WSL (~/.local/bin/muse) first; WSL cannot open this workspace",
      "windows",
    );
    const titles = steps.map((step) => step.title);
    assert.deepEqual(titles, [
      "Check WSL",
      "Check Muse in WSL",
      "Choose an accessible folder",
      "Retry the connection",
    ]);
    assert.match(steps[1]?.detail ?? "", /--version/);
  });

  it("gives a concrete sidecar step for a missing binary", () => {
    const steps = startupRecoverySteps("missing", MISSING, "windows");
    assert.equal(steps[0]?.title, "Provide the matching sidecar");
    assert.equal(steps.at(-1)?.title, "Retry the connection");
  });

  it("keeps authentication guidance explicit and local to WSL", () => {
    const steps = startupRecoverySteps(
      "start-failed",
      "MSP handshake failed: Muse authentication credentials are missing",
      "windows",
    );
    const auth = steps.find((step) => step.title === "Sign in to Muse");
    assert.ok(auth);
    assert.match(auth.detail, /inside WSL/);
    assert.match(auth.detail, /never bundled/);
  });

  it("does not expose an installation success claim for unknown errors", () => {
    const steps = startupRecoverySteps("start-failed", "handshake failed");
    assert.match(steps[0]?.detail ?? "", /Check that the sidecar/);
    assert.doesNotMatch(steps[0]?.detail ?? "", /installed|authenticated/i);
  });

  it("gives native macOS guidance without WSL steps", () => {
    const missing = startupRecoverySteps("missing", MISSING, "macos");
    assert.equal(missing[0]?.title, "Install the Muse CLI");
    assert.match(missing[0]?.detail ?? "", /dev\.meta\.ai\/install\.sh/);
    const steps = startupRecoverySteps(
      "start-failed",
      "muse command not found; workspace: Operation not permitted",
      "macos",
    );
    const titles = steps.map((step) => step.title);
    assert.deepEqual(titles, ["Check the Muse CLI", "Choose an accessible folder", "Retry the connection"]);
    assert.ok(steps.every((step) => !/WSL|PowerShell/.test(step.detail)));
  });
});
