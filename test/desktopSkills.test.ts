import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDesktopSkillArguments,
  findDesktopSkill,
  isAdvertisedDesktopSkill,
} from "../src/lib/desktopSkills.ts";
import type { DesktopWindow } from "../src/lib/desktopControl.ts";
import type { HostSkill } from "../src/lib/hostSkills.ts";

function skill(selector: string): HostSkill {
  return { selector, displayName: selector, description: "test skill" };
}

function window(title = "Muse-Desktop"): DesktopWindow {
  return { id: "hwnd-123", title, bounds: { x: 0, y: 0, width: 1280, height: 720 } };
}

test("findDesktopSkill matches dot, slash, and dash spellings", () => {
  const skills = [skill("computer/click"), skill("computer-screenshot")];
  assert.equal(findDesktopSkill(skills, "click")?.selector, "computer/click");
  assert.equal(findDesktopSkill(skills, "screenshot")?.selector, "computer-screenshot");
  assert.equal(findDesktopSkill(skills, "type"), null);
});

test("findDesktopSkill normalizes case and separators", () => {
  const skills = [skill("  Computer_Click  ")];
  assert.equal(findDesktopSkill(skills, "click")?.selector, "  Computer_Click  ");
  assert.equal(findDesktopSkill([skill("COMPUTER.PRESS")], "key")?.selector, "COMPUTER.PRESS");
});

test("isAdvertisedDesktopSkill requires a known alias and an advertised row", () => {
  const skills = [skill("computer/type")];
  assert.equal(isAdvertisedDesktopSkill(skills, "computer/type"), true);
  // Identity stays spelling-sensitive (unlike findDesktopSkill): the host
  // must advertise the same normalized spelling that is queried. Aliases
  // only establish that the query names a known desktop skill.
  assert.equal(isAdvertisedDesktopSkill(skills, "computer.type"), false);
  // Known alias shape but not advertised: fail closed.
  assert.equal(isAdvertisedDesktopSkill([], "computer.type"), false);
  // Advertised but not a desktop alias: fail closed.
  assert.equal(isAdvertisedDesktopSkill([skill("mcp.call")], "mcp.call"), false);
  assert.equal(isAdvertisedDesktopSkill(skills, "mcp.call"), false);
});

test("buildDesktopSkillArguments includes a point only for integer pairs", () => {
  const withPoint = JSON.parse(buildDesktopSkillArguments("click", window(), undefined, 10, 20));
  assert.deepEqual(withPoint.point, { x: 10, y: 20 });
  const halfPoint = JSON.parse(buildDesktopSkillArguments("click", window(), undefined, 10, undefined));
  assert.equal("point" in halfPoint, false);
  const floatPoint = JSON.parse(buildDesktopSkillArguments("click", window(), undefined, 1.5, 20));
  assert.equal("point" in floatPoint, false);
});

test("buildDesktopSkillArguments bounds identifiers, titles, and values", () => {
  const parsed = JSON.parse(
    buildDesktopSkillArguments("type", window("t".repeat(500)), "v".repeat(5_000)),
  );
  assert.equal(parsed.window.title.length, 240);
  assert.equal(parsed.value.length, 2_000);
  const blank = JSON.parse(buildDesktopSkillArguments("observe", window("   ")));
  assert.equal(blank.window.title, "");
  assert.equal("value" in blank, false);
});

test("buildDesktopSkillArguments keeps the largest bounded payload under the cap", () => {
  const parsed = JSON.parse(
    buildDesktopSkillArguments("key", window("t".repeat(500)), "v".repeat(5_000)),
  );
  // Bounds (240-char title, 2000-char value) keep every payload far below
  // the 8000-char fallback threshold, so nothing is silently dropped.
  assert.equal(parsed.window.title.length, 240);
  assert.equal(parsed.value.length, 2_000);
  assert.ok(buildDesktopSkillArguments("key", window("t".repeat(500)), "v".repeat(5_000)).length <= 8_000);
});
