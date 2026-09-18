import assert from "node:assert/strict";
import test from "node:test";
import {
  buildBrowserSkillArguments,
  findBrowserSkill,
  isAdvertisedBrowserSkill,
} from "../src/lib/browserSkills.ts";

const skills = [
  { selector: "browser.observe", displayName: "Observe", description: "Observe a page" },
  { selector: "browser/open-tab", displayName: "Open tab", description: "Open a tab" },
  { selector: "other", displayName: "Other", description: "Other" },
];

test("browser host skills are used only when advertised", () => {
  assert.equal(findBrowserSkill(skills, "observe")?.selector, "browser.observe");
  assert.equal(findBrowserSkill(skills, "openTab")?.selector, "browser/open-tab");
  assert.equal(findBrowserSkill(skills, "click"), null);
  assert.equal(isAdvertisedBrowserSkill(skills, "browser.observe"), true);
  assert.equal(isAdvertisedBrowserSkill(skills, "browser.download"), false);
  assert.equal(isAdvertisedBrowserSkill(skills, "terminal.exec"), false);
});

test("browser skill arguments keep explicit context bounded", () => {
  const args = JSON.parse(buildBrowserSkillArguments(
    "type",
    "https://example.com/" + "x".repeat(3_000),
    {
      selector: "#search",
      tag: "input",
      text: "  page text  ",
      href: "https://example.com/result",
    },
    "  hello   world  ",
  )) as Record<string, unknown>;
  assert.equal(args.action, "type");
  assert.equal((args.url as string).length, 2_000);
  assert.deepEqual(args.element, {
    selector: "#search",
    tag: "input",
    text: "page text",
    href: "https://example.com/result",
  });
  assert.equal(args.value, "hello world");
  assert.ok(JSON.stringify(args).length <= 8_000);
});
