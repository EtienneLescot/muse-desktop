import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isApprovalDecisionAccepted,
  isSelectedApprovalAccepted,
  parseApprovalResolution,
} from "../src/lib/approvalResolution.ts";

describe("approval resolution payloads", () => {
  it("classifies accepted decisions without treating rejects as resumed work", () => {
    assert.equal(isApprovalDecisionAccepted("allow once"), true);
    assert.equal(isApprovalDecisionAccepted("approved"), true);
    assert.equal(isApprovalDecisionAccepted("rejected"), false);
    assert.equal(isApprovalDecisionAccepted("deny"), false);
    assert.equal(isApprovalDecisionAccepted(""), false);
  });
  it("recognizes accepted decisions and all supported id spellings", () => {
    assert.deepEqual(
      parseApprovalResolution('{"approvalId":"a1","decision":"Approved"}'),
      { approvalId: "a1", decision: "approved", accepted: true },
    );
    assert.equal(parseApprovalResolution('{"request_id":"a2","outcome":"allow once"}').accepted, true);
    assert.equal(parseApprovalResolution('{"approval_id":"a3","resolution":{"decision":"granted"}}').approvalId, "a3");
  });

  it("keeps rejected or cancelled resolutions out of the resume bridge", () => {
    assert.equal(parseApprovalResolution('{"approvalId":"a1","decision":"rejected"}').accepted, false);
    assert.equal(parseApprovalResolution('{"approvalId":"a2","decision":"cancelled"}').accepted, false);
  });

  it("fails closed for malformed or uninformative payloads", () => {
    assert.deepEqual(parseApprovalResolution("not json"), {
      approvalId: null,
      decision: null,
      accepted: false,
    });
    assert.equal(parseApprovalResolution('{"approvalId":"a1"}').accepted, false);
  });

  it("classifies the clicked choice in the current session only", () => {
    const approvals = [
      {
        session_id: "session-a",
        request_id: "request-1",
        choices: [
          { choiceId: "deny", decision: "rejected" },
          { choiceId: "allow", decision: "allow once" },
        ],
      },
      {
        session_id: "session-b",
        request_id: "request-1",
        choices: [{ choiceId: "allow", decision: "allow once" }],
      },
    ];
    assert.equal(isSelectedApprovalAccepted(approvals, "session-a", "request-1", "deny"), false);
    assert.equal(isSelectedApprovalAccepted(approvals, "session-a", "request-1", "allow"), true);
    assert.equal(isSelectedApprovalAccepted(approvals, "session-b", "request-1", "allow"), true);
    assert.equal(isSelectedApprovalAccepted(approvals, "session-a", "missing", "allow"), true);
  });
});
