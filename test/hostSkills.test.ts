import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { findHostSkill, parseHostSkills } from "../src/lib/hostSkills.ts";

describe("host skill catalogue", () => {
  it("parses bounded metadata and removes duplicate selectors", () => {
    const skills = parseHostSkills({
      skills: [
        { selector: "plan", displayName: "Plan", description: "Make a plan", source: "builtin" },
        { selector: "PLAN", displayName: "duplicate", description: "ignored" },
        { selector: "", displayName: "invalid" },
        { selector: "review", description: "Review changes", argumentHint: "focus" },
      ],
    });
    assert.deepEqual(skills.map((skill) => skill.selector), ["plan", "review"]);
    assert.equal(skills[1].displayName, "review");
    assert.equal(skills[1].argumentHint, "focus");
  });

  it("matches slash names case-insensitively", () => {
    const skills = parseHostSkills({ skills: [{ selector: "threejs:threejs", displayName: "Three.js" }] });
    assert.equal(findHostSkill(skills, "THREEJS:THREEJS")?.displayName, "Three.js");
    assert.equal(findHostSkill(skills, "missing"), null);
  });

  it("fails closed for malformed responses", () => {
    assert.deepEqual(parseHostSkills(null), []);
    assert.deepEqual(parseHostSkills({ skills: "nope" }), []);
  });
});
