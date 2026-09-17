import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseApprovalResolution } from "../src/lib/approvalResolution.ts";

describe("approval resolution payloads", () => {
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
});
