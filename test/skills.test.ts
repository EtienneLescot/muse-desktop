/**
 * US-25 skills: `/skill-name` slash parsing + invocation, keyword
 * auto-suggest with log traces, progressive disclosure (view-only
 * default), builtin merge and shareable sources.
 *
 * Runs on the built-in node:test runner, no extra framework (npm test).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  BUILTIN_SKILLS,
  buildSkillInvocation,
  formatSkillInvokeTrace,
  formatSkillTrace,
  getSkillDetail,
  loadSkills,
  mergeBuiltinSkills,
  normalizeSkillName,
  parseSkillCommand,
  resolveSkill,
  setSkillEnabled,
  skillInvocationStageLabel,
  suggestSkills,
  type Skill,
} from "../src/lib/skills.ts";

const skills: Skill[] = mergeBuiltinSkills([]);

describe("parseSkillCommand (/skill-name slash in composer)", () => {
  it("parses name + args", () => {
    assert.deepEqual(parseSkillCommand("/review-pr please check"), {
      name: "review-pr",
      args: "please check",
    });
  });

  it("parses a bare slash command without args", () => {
    assert.deepEqual(parseSkillCommand("  /plan-task  "), {
      name: "plan-task",
      args: "",
    });
  });

  it("normalizes case for the name", () => {
    assert.equal(parseSkillCommand("/Review-PR x")?.name, "review-pr");
  });

  it("accepts namespaced host selectors", () => {
    assert.deepEqual(parseSkillCommand("/threejs:threejs demo"), {
      name: "threejs:threejs",
      args: "demo",
    });
  });

  it("rejects plain text and a lone slash", () => {
    assert.equal(parseSkillCommand("hello world"), null);
    assert.equal(parseSkillCommand("/"), null);
    assert.equal(parseSkillCommand(""), null);
  });
});

describe("resolveSkill", () => {
  it("resolves an enabled skill by name", () => {
    assert.equal(resolveSkill(skills, "review-pr")?.name, "review-pr");
  });

  it("returns null for unknown names", () => {
    assert.equal(resolveSkill(skills, "nope"), null);
  });

  it("skips disabled skills", () => {
    const { skills: next } = setSkillEnabled(skills, "review-pr", false);
    assert.equal(resolveSkill(next, "review-pr"), null);
    assert.ok(resolveSkill(skills, "review-pr"));
  });
});

describe("progressive disclosure (view-only default)", () => {
  it("builtins are view-only by default", () => {
    for (const s of BUILTIN_SKILLS) assert.equal(s.viewOnly, true);
  });

  it("default view hides instructions; full grant reveals them", () => {
    const skill = resolveSkill(skills, "plan-task");
    assert.ok(skill);
    const view = getSkillDetail(skill, false);
    assert.equal(view.instructions, null);
    assert.ok(view.description.length > 0);
    const full = getSkillDetail(skill, true);
    assert.ok(full.instructions && full.instructions.length > 0);
  });

  it("invocation builds on the full instructions + user args", () => {
    const skill = resolveSkill(skills, "write-tests");
    assert.ok(skill);
    const text = buildSkillInvocation(skill, "cover the parser");
    assert.ok(text.includes("[write-tests]"));
    assert.ok(text.includes("cover the parser"));
    assert.ok(text.includes(skill.instructions));
  });

  it("invocation includes bounded resources with their provenance", () => {
    const skill: Skill = {
      name: "with-resource",
      description: "Resource skill",
      instructions: "Use the attached guide.",
      source: "project",
      viewOnly: true,
      enabled: true,
      path: ".agents/skills/with-resource/SKILL.md",
      resources: ["guide.md"],
      discovered: true,
    };
    const text = buildSkillInvocation(skill, "apply", [
      { path: ".agents/skills/with-resource/guide.md", content: "Rules", truncated: false },
    ]);
    assert.match(text, /skill-resource path=/);
    assert.match(text, /Rules/);
    assert.match(text, /Request: apply/);
  });
});

describe("skill invocation progress", () => {
  it("keeps user-facing labels stable for every pipeline stage", () => {
    assert.equal(skillInvocationStageLabel("preparing"), "Preparing invocation");
    assert.equal(skillInvocationStageLabel("loading-resources"), "Loading skill resources");
    assert.equal(skillInvocationStageLabel("sending"), "Sending to Muse");
    assert.equal(skillInvocationStageLabel("queued"), "Queued by Muse");
    assert.equal(skillInvocationStageLabel("running"), "Running");
    assert.equal(skillInvocationStageLabel("completed"), "Completed");
    assert.equal(skillInvocationStageLabel("failed"), "Failed");
    assert.equal(skillInvocationStageLabel("unknown"), "Needs attention");
  });
});

describe("auto-suggest (traced in log by the hook)", () => {
  it("suggests by keyword with a reason", () => {
    const out = suggestSkills(skills, "please add regression tests");
    assert.deepEqual(out, [
      { skillName: "write-tests", reason: 'keyword "test"' },
    ]);
  });

  it("suggests nothing for empty drafts or slash commands", () => {
    assert.deepEqual(suggestSkills(skills, ""), []);
    assert.deepEqual(suggestSkills(skills, "   "), []);
    assert.deepEqual(suggestSkills(skills, "/review-pr"), []);
  });

  it("ignores disabled skills", () => {
    const { skills: next } = setSkillEnabled(skills, "write-tests", false);
    assert.deepEqual(suggestSkills(next, "please add tests"), []);
  });

  it("trace lines name the skill and reason", () => {
    const line = formatSkillTrace({
      skillName: "plan-task",
      reason: 'keyword "plan"',
    });
    assert.ok(line.includes("plan-task"));
    assert.ok(line.includes('keyword "plan"'));
    assert.equal(formatSkillInvokeTrace("review-pr", "look"), "[skill invoke] /review-pr look");
    assert.equal(formatSkillInvokeTrace("review-pr", ""), "[skill invoke] /review-pr");
  });
});

describe("merge + sources (shareable repo/team)", () => {
  it("keeps builtins and adds repo/team skills", () => {
    const extra: Skill = {
      name: "deploy-check",
      description: "Pre-deploy checklist.",
      instructions: "Check migrations.",
      source: "team",
      viewOnly: true,
      enabled: true,
    };
    const merged = mergeBuiltinSkills([extra]);
    assert.equal(merged.length, BUILTIN_SKILLS.length + 1);
    assert.equal(resolveSkill(merged, "deploy-check")?.source, "team");
  });

  it("stored overrides win for enabled/viewOnly", () => {
    const stored: Skill = {
      ...BUILTIN_SKILLS[0],
      enabled: false,
      viewOnly: false,
    };
    const merged = mergeBuiltinSkills([stored]);
    assert.equal(merged.length, BUILTIN_SKILLS.length);
    assert.equal(resolveSkill(merged, stored.name), null);
  });

  it("setSkillEnabled on a missing name changes nothing", () => {
    assert.deepEqual(setSkillEnabled(skills, "missing", false), {
      skills,
      changed: false,
    });
  });

  it("normalizeSkillName is case/format-insensitive", () => {
    assert.equal(normalizeSkillName("Review_PR"), "review-pr");
  });
});

describe("persistence", () => {
  it("loads [] without localStorage (node:test has none)", () => {
    assert.deepEqual(loadSkills(), []);
  });
});
