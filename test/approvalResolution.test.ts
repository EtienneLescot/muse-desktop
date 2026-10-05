import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  STALE_APPROVAL_NOTICE,
  isApprovalDecisionAccepted,
  isApprovalRequirementStale,
  isSelectedApprovalAccepted,
  parseApprovalResolution,
  shouldCloseApprovalLane,
} from "../src/lib/approvalResolution.ts";
import { userFacingError } from "../src/lib/errorCopy.ts";

describe("approval resolution payloads", () => {
  it("classifies accepted decisions without treating rejects as resumed work", () => {
    assert.equal(isApprovalDecisionAccepted("allow once"), true);
    assert.equal(isApprovalDecisionAccepted("approved"), true);
    assert.equal(isApprovalDecisionAccepted("rejected"), false);
    assert.equal(isApprovalDecisionAccepted("deny"), false);
    assert.equal(isApprovalDecisionAccepted(""), false);
    // The 1.4.2 decision vocabulary (ApprovalDecision).
    assert.equal(isApprovalDecisionAccepted("approvedForSession"), true);
    assert.equal(isApprovalDecisionAccepted("approvedPolicyAmendment"), true);
    assert.equal(isApprovalDecisionAccepted("abort"), false);
    assert.equal(isApprovalDecisionAccepted("deniedPolicyAmendment"), false);
    assert.equal(isApprovalDecisionAccepted("timedOut"), false);
  });
  it("recognizes accepted decisions and all supported id spellings", () => {
    assert.deepEqual(
      parseApprovalResolution('{"approvalId":"a1","decision":"Approved"}'),
      { approvalId: "a1", decision: "approved", accepted: true },
    );
    assert.equal(parseApprovalResolution('{"request_id":"a2","outcome":"allow once"}').accepted, true);
    assert.equal(parseApprovalResolution('{"approval_id":"a3","resolution":{"decision":"granted"}}').approvalId, "a3");
  });

  it("keeps a bounded resumed turn id when the host provides one", () => {
    assert.deepEqual(
      parseApprovalResolution('{"approvalId":"a1","decision":"allow once","turnId":"turn-7"}'),
      { approvalId: "a1", decision: "allow_once", accepted: true, turnId: "turn-7" },
    );
    assert.deepEqual(
      parseApprovalResolution('{"approvalId":"a1","decision":"rejected","turn_id":"turn-8"}'),
      { approvalId: "a1", decision: "rejected", accepted: false, turnId: "turn-8" },
    );
    assert.equal(parseApprovalResolution(`{"approvalId":"a1","decision":"allow","turnId":"${"x".repeat(300)}"}`).turnId?.length, 160);
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

  it("says calmly that a decision refused as stale (-32053) decided nothing", () => {
    // The 1.4.2 text the banner used to show as is (M0-05 proof).
    const wire = "MSP error -32053: approval 01a10c37 requirement is stale [approvalRequirementStale] [retryable=false]";
    assert.equal(isApprovalRequirementStale(wire), true);
    assert.equal(isApprovalRequirementStale(new Error(wire)), true);
    assert.equal(isApprovalRequirementStale("MSP error -32051: approval already resolved [approvalAlreadyResolved]"), false);
    assert.equal(isApprovalRequirementStale("unknown or stale approval: a1"), false);
    assert.equal(userFacingError(STALE_APPROVAL_NOTICE), STALE_APPROVAL_NOTICE);
  });

  it("keeps a resumed lane open for legacy approval stage updates", () => {
    assert.equal(shouldCloseApprovalLane(false, false), true);
    assert.equal(shouldCloseApprovalLane(true, false), false);
    assert.equal(shouldCloseApprovalLane(false, true), false);
  });
});
