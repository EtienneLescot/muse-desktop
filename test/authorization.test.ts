import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  AUTHORIZATION_MODE_KEY,
  DEFAULT_AUTHORIZATION_MODE,
  automaticApprovalChoice,
  authorizationModeDescription,
  authorizationModeLabel,
  parseAuthorizationMode,
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
});
