/**
 * US-22 scope guard client: `checkScope` relays the backend `check_scope`
 * verdict and fails closed (deny with an explicit reason) whenever the
 * verdict cannot be established.
 *
 * Runs on the built-in node:test runner, no extra framework:
 *   npm test
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { checkScope, type ScopeInvoke } from "../src/lib/scope.ts";

describe("scope guard client", () => {
  it("passes through an in-scope backend verdict", async () => {
    const seen: Array<{ cmd: string; args?: Record<string, unknown> }> = [];
    const fake: ScopeInvoke = async (cmd, args) => {
      seen.push({ cmd, args });
      return { in_scope: true, reason: "path is inside the workspace" };
    };
    const v = await checkScope("/ws/src/a.ts", fake);
    assert.equal(v.in_scope, true);
    assert.equal(v.reason, "path is inside the workspace");
    assert.deepEqual(seen, [{ cmd: "check_scope", args: { path: "/ws/src/a.ts" } }]);
  });

  it("passes through an out-of-scope backend verdict with its reason", async () => {
    const fake: ScopeInvoke = async () =>
      ({ in_scope: false, reason: "path is outside the workspace root /ws: /etc/passwd" });
    const v = await checkScope("/etc/passwd", fake);
    assert.equal(v.in_scope, false);
    assert.match(v.reason, /outside/);
  });

  it("fails closed when the backend call throws", async () => {
    const fake: ScopeInvoke = async () => {
      throw new Error("no workspace selected");
    };
    const v = await checkScope("/ws/a.ts", fake);
    assert.equal(v.in_scope, false);
    assert.match(v.reason, /no workspace selected/);
  });

  it("fails closed on a malformed backend reply", async () => {
    const fake: ScopeInvoke = async () => ({ nope: 1 });
    const v = await checkScope("/ws/a.ts", fake);
    assert.equal(v.in_scope, false);
    assert.match(v.reason, /malformed/);
  });

  it("fails closed with no backend (plain node has no Tauri webview)", async () => {
    const v = await checkScope("/ws/a.ts");
    assert.equal(v.in_scope, false);
    assert.match(v.reason, /no backend/);
  });
});
