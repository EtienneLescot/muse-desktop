import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { userFacingError } from "../src/lib/errorCopy.ts";

describe("M0-11 generated error copy", () => {
  it("replaces protocol verbs with calm English while retaining bounded detail", () => {
    assert.equal(
      userFacingError("send_input failed: bearer token=secret-value"),
      "Your message could not be sent. — Bearer [redacted]",
    );
  });

  it("handles Error objects and unknown values without exposing Error:", () => {
    assert.equal(userFacingError(new Error("terminal_read failed: disconnected")), "The terminal action could not be completed. — disconnected");
    assert.equal(userFacingError(null), "Something went wrong.");
  });

  it("leaves already user-facing copy unchanged", () => {
    assert.equal(userFacingError("Choose a workspace folder first."), "Choose a workspace folder first.");
  });

  it("covers secondary panel actions without exposing protocol prefixes", () => {
    assert.equal(
      userFacingError("skills scan failed: permission denied"),
      "The skills scan could not be completed. — permission denied",
    );
    assert.equal(
      userFacingError("model catalog unavailable: host disconnected"),
      "The model list is unavailable. — host disconnected",
    );
    assert.equal(
      userFacingError("window action failed: native window unavailable"),
      "The window action could not be completed. — native window unavailable",
    );
    assert.equal(
      userFacingError("native browser open failed: invalid URL"),
      "The native browser could not be opened. — invalid URL",
    );
  });
});
