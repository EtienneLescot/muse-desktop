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
} from "../src/lib/authorization.ts";

describe("global authorization posture", () => {
  it("falls back to ask and keeps a namespaced storage key", () => {
    assert.equal(parseAuthorizationMode(null), DEFAULT_AUTHORIZATION_MODE);
    assert.equal(parseAuthorizationMode("invalid"), DEFAULT_AUTHORIZATION_MODE);
    assert.match(AUTHORIZATION_MODE_KEY, /^muse-desktop\./);
  });

  it("exposes calm, product-facing labels", () => {
    assert.equal(authorizationModeLabel("yolo"), "YOLO");
    assert.match(authorizationModeDescription("workspace"), /network/i);
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

  it("keeps connector calls aligned with the global posture", () => {
    assert.equal(connectorCallRequiresApproval("ask", "local"), true);
    assert.equal(connectorCallRequiresApproval("ask", "remote"), true);
    assert.equal(connectorCallRequiresApproval("workspace", "local"), false);
    assert.equal(connectorCallRequiresApproval("workspace", "remote"), true);
    assert.equal(connectorCallRequiresApproval("yolo", "local"), false);
    assert.equal(connectorCallRequiresApproval("yolo", "remote"), false);
  });
});
