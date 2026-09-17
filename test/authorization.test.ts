import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  AUTHORIZATION_MODE_KEY,
  DEFAULT_AUTHORIZATION_MODE,
  automaticApprovalChoice,
  authorizationModeDescription,
  authorizationModeLabel,
  connectorCallRequiresApproval,
  hostApprovalMode,
  parseAuthorizationMode,
  productAuthorizationMode,
} from "../src/lib/authorization.ts";

const local = { choiceId: "allow-local", decision: "allow", scope: "localPersistent" };
const network = { choiceId: "allow-network", decision: "allow", scope: "network" };
const denied = { choiceId: "deny", decision: "denied", scope: "local" };

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

  it("never auto-approves in ask mode", () => {
    assert.equal(automaticApprovalChoice("ask", [local]), null);
  });

  it("auto-approves local actions but keeps risky scopes explicit", () => {
    assert.deepEqual(automaticApprovalChoice("workspace", [local]), local);
    assert.equal(automaticApprovalChoice("workspace", [network]), null);
  });

  it("YOLO chooses the first non-denied host choice", () => {
    assert.deepEqual(automaticApprovalChoice("yolo", [denied, network]), network);
    assert.equal(automaticApprovalChoice("yolo", [denied]), null);
  });

  it("maps product postures to the closed MSP modes", () => {
    assert.equal(hostApprovalMode("ask"), "onRequest");
    assert.equal(hostApprovalMode("workspace"), "promptUnmatched");
    assert.equal(hostApprovalMode("yolo"), "allowAll");
  });

  it("maps the host projection back without inventing a product mode", () => {
    assert.equal(productAuthorizationMode("onRequest"), "ask");
    assert.equal(productAuthorizationMode("promptUnmatched"), "workspace");
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
