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
