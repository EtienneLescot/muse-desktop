import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  AUTHORIZATION_MODE_KEY,
  DEFAULT_AUTHORIZATION_MODE,
  authorizationModeDescription,
  authorizationModeLabel,
  connectorCallRequiresApproval,
  hostApprovalMode,
  parseAuthorizationMode,
  productAuthorizationMode,
  projectApprovalMode,
  type AuthorizationMode,
} from "../src/lib/authorization.ts";

describe("global authorization posture", () => {
  it("falls back to ask and keeps a namespaced storage key", () => {
    assert.equal(parseAuthorizationMode(null), DEFAULT_AUTHORIZATION_MODE);
    assert.equal(parseAuthorizationMode("invalid"), DEFAULT_AUTHORIZATION_MODE);
    assert.match(AUTHORIZATION_MODE_KEY, /^muse-desktop\./);
  });

  it("exposes calm, product-facing labels", () => {
    assert.equal(authorizationModeLabel("yolo"), "YOLO");
    // The app approves nothing itself: the label says what the engine does.
    assert.equal(authorizationModeLabel("workspace"), "Ask only for more access");
    // Measured on Windows 1.4.2: `promptUnmatched` and `onRequest` asked for
    // every shell action, none ran unprompted, and `allowAll` never asked
    // while the sandbox still applied. No text may promise more.
    const middle = authorizationModeDescription("workspace");
    assert.equal(middle, "The engine's sandbox decides when Muse asks. On Windows it asks for shell commands.");
    for (const mode of ["ask", "workspace", "yolo"] as const) {
      assert.doesNotMatch(authorizationModeDescription(mode), /without asking|runs what|\bmost\b|its rules/i);
    }
    assert.match(authorizationModeDescription("ask"), /asks before any action the engine's own rules do not allow/);
    assert.match(authorizationModeDescription("yolo"), /Isolation setting still limits/);
  });

  it("maps product postures to the host's own mode semantics", () => {
    assert.equal(hostApprovalMode("ask"), "promptUnmatched");
    assert.equal(hostApprovalMode("workspace"), "onRequest");
    assert.equal(hostApprovalMode("yolo"), "allowAll");
  });

  it("maps the host projection back without inventing a product mode", () => {
    assert.equal(productAuthorizationMode("promptUnmatched"), "ask");
    assert.equal(productAuthorizationMode("onRequest"), "workspace");
    assert.equal(productAuthorizationMode("allowAll"), "yolo");
    assert.equal(productAuthorizationMode("denyUnmatched"), null);
  });

  it("re-projects a posture picked while the host call was in flight", async () => {
    let selector: AuthorizationMode = "yolo";
    const sent: AuthorizationMode[] = [];
    await projectApprovalMode(() => selector, async (mode) => {
      sent.push(mode);
      if (sent.length === 1) selector = "ask";
      return { status: "accepted", effectiveMode: { mode: hostApprovalMode(mode) } };
    }, "onRequest");
    assert.deepEqual(sent, ["yolo", "ask"]);
  });

  it("reports a host that keeps another posture", async () => {
    await assert.rejects(projectApprovalMode(() => "ask", async () => ({
      status: "accepted",
      effectiveMode: { mode: "onRequest" },
    })));
  });

  it("keeps connector calls aligned with the global posture", () => {
    assert.equal(connectorCallRequiresApproval("ask", "local"), true);
    assert.equal(connectorCallRequiresApproval("ask", "remote"), true);
    assert.equal(connectorCallRequiresApproval("workspace", "local"), false);
    assert.equal(connectorCallRequiresApproval("workspace", "remote"), true);
    assert.equal(connectorCallRequiresApproval("yolo", "local"), false);
    assert.equal(connectorCallRequiresApproval("yolo", "remote"), false);
  });
});
