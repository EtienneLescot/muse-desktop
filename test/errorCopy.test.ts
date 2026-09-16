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
});
