import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { streamEntryA11y, streamWindowAnnouncement } from "../src/lib/streamA11y.ts";

describe("bounded transcript accessibility metadata", () => {
  it("keeps visible entries positioned in the full conversation", () => {
    assert.deepEqual(streamEntryA11y("Muse", 1840, 2000), {
      role: "article",
      position: 1841,
      setSize: 2000,
      label: "Muse, message 1841 of 2000",
    });
  });

  it("clamps invalid positions and keeps a useful fallback label", () => {
    assert.equal(streamEntryA11y("", -4, 12).position, 1);
    assert.equal(streamEntryA11y("Muse", 99, 12).position, 12);
    assert.equal(streamEntryA11y("", Number.NaN, Number.NaN).label, "Message, message 1 of 0");
  });

  it("announces a bounded window without exposing renderer details", () => {
    assert.equal(streamWindowAnnouncement(1720, 1880, 2000), "Showing messages 1721 to 1880 of 2000.");
    assert.equal(streamWindowAnnouncement(-2, 99, 12), "Showing messages 1 to 12 of 12.");
    assert.equal(streamWindowAnnouncement(0, 0, 0), "Conversation is empty.");
  });
});
