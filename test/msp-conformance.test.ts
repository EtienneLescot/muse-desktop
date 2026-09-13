import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  MSP_ERROR_APPROVAL_REQUIREMENT_STALE,
  MSP_ERROR_USER_INPUT_ANSWER_INVALID,
  MSP_METHODS_SENT,
  MSP_NOTIFICATIONS_HANDLED,
} from "../src/lib/msp.ts";

const unique = (xs: readonly string[]): boolean =>
  new Set(xs).size === xs.length;

describe("msp conformance surface", () => {
  it("sends a fixed set of SDK-known methods, no duplicates", () => {
    assert.equal(MSP_METHODS_SENT.length, 8);
    assert.ok(unique(MSP_METHODS_SENT));
    for (const m of [
      "initialize",
      "session/start",
      "session/list",
      "turn/start",
      "turn/interrupt",
      "approval/decide",
      "userInput/answer",
      "userInput/cancel",
    ] as const) {
      assert.ok(
        (MSP_METHODS_SENT as readonly string[]).includes(m),
        `missing ${m}`,
      );
    }
  });

  it("never claims an IPC-spawn method (none exists in the SDK schema)", () => {
    const names = MSP_METHODS_SENT as readonly string[];
    assert.ok(!names.some((m) => m.includes("spawn")));
    assert.ok(!names.some((m) => m.startsWith("workflow/")));
  });

  it("handles a fixed set of SDK-known notifications, no duplicates", () => {
    assert.ok(MSP_NOTIFICATIONS_HANDLED.length > 0);
    assert.ok(unique(MSP_NOTIFICATIONS_HANDLED));
    for (const n of [
      "item/delta",
      "approval/requested",
      "userInput/requested",
      "turn/completed",
    ] as const) {
      assert.ok(
        (MSP_NOTIFICATIONS_HANDLED as readonly string[]).includes(n),
        `missing ${n}`,
      );
    }
  });

  it("pins the interpreted host error codes", () => {
    assert.equal(MSP_ERROR_APPROVAL_REQUIREMENT_STALE, -32053);
    assert.equal(MSP_ERROR_USER_INPUT_ANSWER_INVALID, -32057);
  });
});
