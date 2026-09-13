/**
 * US-32 a11y pure logic: approval arrow/enter navigation, focus-trap Tab
 * cycling, and polite live-region announcements.
 *
 * Runs on the built-in node:test runner, no extra framework:
 *   npm test
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  approvalAnnouncement,
  choiceIndexForKey,
  COMPOSER_SHORTCUT_TITLES,
  inputAnnouncement,
  isChoiceConfirmKey,
  statusAnnouncement,
  streamStatusMessage,
  trapTabIndex,
} from "../src/lib/a11y.ts";

describe("choiceIndexForKey", () => {
  it("moves right/down forward with wrap-around", () => {
    assert.equal(choiceIndexForKey("ArrowRight", 0, 3), 1);
    assert.equal(choiceIndexForKey("ArrowDown", 2, 3), 0);
  });

  it("moves left/up backward with wrap-around", () => {
    assert.equal(choiceIndexForKey("ArrowLeft", 0, 3), 2);
    assert.equal(choiceIndexForKey("ArrowUp", 1, 3), 0);
  });

  it("supports Home/End and ignores other keys", () => {
    assert.equal(choiceIndexForKey("Home", 2, 3), 0);
    assert.equal(choiceIndexForKey("End", 0, 3), 2);
    assert.equal(choiceIndexForKey("Tab", 0, 3), null);
    assert.equal(choiceIndexForKey("a", 0, 3), null);
  });

  it("returns null when there are no choices", () => {
    assert.equal(choiceIndexForKey("ArrowRight", 0, 0), null);
  });

  it("clamps an out-of-range current index", () => {
    assert.equal(choiceIndexForKey("ArrowRight", 9, 3), 0);
  });
});

describe("isChoiceConfirmKey", () => {
  it("accepts Enter and Space only", () => {
    assert.equal(isChoiceConfirmKey("Enter"), true);
    assert.equal(isChoiceConfirmKey(" "), true);
    assert.equal(isChoiceConfirmKey("Tab"), false);
    assert.equal(isChoiceConfirmKey("Escape"), false);
  });
});

describe("trapTabIndex", () => {
  it("cycles Tab forward and Shift+Tab backward", () => {
    assert.equal(trapTabIndex(0, 3, false), 1);
    assert.equal(trapTabIndex(2, 3, false), 0);
    assert.equal(trapTabIndex(0, 3, true), 2);
    assert.equal(trapTabIndex(1, 3, true), 0);
  });

  it("returns null with no focusables", () => {
    assert.equal(trapTabIndex(0, 0, false), null);
  });
});

describe("announcements", () => {
  it("describes stream running/stopped", () => {
    assert.equal(streamStatusMessage(true), "Agent running.");
    assert.equal(streamStatusMessage(false), "Agent stopped.");
  });

  it("announces approval arrivals, singular and plural", () => {
    assert.match(approvalAnnouncement(1), /Approval needed/);
    assert.match(approvalAnnouncement(1, "bash"), /bash/);
    assert.match(approvalAnnouncement(2), /2 approvals/);
    assert.equal(approvalAnnouncement(0), "");
  });

  it("announces input arrivals, singular and plural", () => {
    assert.match(inputAnnouncement(1), /Input requested/);
    assert.match(inputAnnouncement(3), /3 inputs/);
    assert.equal(inputAnnouncement(0), "");
  });

  it("statusAnnouncement stays silent without changes", () => {
    assert.equal(statusAnnouncement(true, true, 1, 1), "");
    assert.equal(statusAnnouncement(null, false, 0, 0), "");
  });

  it("statusAnnouncement reports running transitions and new pendings", () => {
    assert.equal(statusAnnouncement(false, true, 0, 0), "Agent running.");
    assert.match(statusAnnouncement(true, true, 0, 2), /2 decisions pending/);
  });
});

describe("COMPOSER_SHORTCUT_TITLES", () => {
  it("documents Enter/Shift+Enter/Escape in title text", () => {
    assert.match(COMPOSER_SHORTCUT_TITLES.textarea, /Enter to send/);
    assert.match(COMPOSER_SHORTCUT_TITLES.textarea, /Shift\+Enter/);
    assert.match(COMPOSER_SHORTCUT_TITLES.textarea, /Escape/);
  });
});
