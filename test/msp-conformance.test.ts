import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
    assert.ok(unique(MSP_METHODS_SENT));
    for (const m of [
      "initialize",
      "session/start",
      "session/read",
      "view/page",
      "session/resume",
      "session/list",
      "model/list",
      "session/compact",
      "session/setModel",
      "session/setReasoningEffort",
      "item/readOutput",
      "session/rename",
      "session/userShell",
      "session/fork",
      "session/setApprovalMode",
      "turn/start",
      "turn/interrupt",
      "turn/steer",
      "approval/decide",
      "userInput/answer",
      "userInput/cancel",
      "subagent/interrupt",
      "subagent/stop",
      "subagent/resume",
      "subagent/followupTask",
      "subagent/readResult",
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

  it("keeps every registered method anchored in the Rust implementation", () => {
    const main = readFileSync(new URL("../src-tauri/src/main.rs", import.meta.url), "utf8");
    for (const method of MSP_METHODS_SENT) {
      assert.ok(main.includes(`"${method}"`), `registry method is not implemented: ${method}`);
    }
  });

  it("handles a fixed set of SDK-known notifications, no duplicates", () => {
    assert.ok(MSP_NOTIFICATIONS_HANDLED.length > 0);
    assert.ok(unique(MSP_NOTIFICATIONS_HANDLED));
    for (const n of [
      "item/delta",
      "approval/requested",
      "userInput/requested",
      "turn/completed",
      "turn/stopped",
      "session/contextUsage",
      "session/approvalModeChanged",
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
