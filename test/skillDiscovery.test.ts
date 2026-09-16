import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  dedupeDiscoveredSkills,
  parseSkillDocument,
  parseSkillDocuments,
  type DiscoveredSkill,
} from "../src/lib/skillDiscovery.ts";

function doc(overrides: Partial<DiscoveredSkill> = {}): DiscoveredSkill {
  return {
    name: "demo",
    description: "Demo skill",
    instructions: "Do the thing.",
    source: "repo",
    viewOnly: true,
    enabled: true,
    path: "skills/demo/SKILL.md",
    resources: [],
    discovered: true,
    ...overrides,
  };
}

describe("SKILL.md discovery", () => {
  it("parses frontmatter, body and relative resources", () => {
    const result = parseSkillDocument({
      path: ".agents/skills/demo/SKILL.md",
      source: "project",
      text: "---\nname: demo\ndescription: A useful demo\nresources: [guide.md, examples.txt]\n---\n\nFollow the guide.",
    });
    assert.equal(result.error, null);
    assert.equal(result.skill?.name, "demo");
    assert.equal(result.skill?.instructions, "Follow the guide.");
    assert.deepEqual(result.skill?.resources, ["guide.md", "examples.txt"]);
  });

  it("rejects malformed metadata and unsafe resources", () => {
    const missing = parseSkillDocument({ path: "bad/SKILL.md", source: "repo", text: "name: bad" });
    assert.match(missing.error?.message ?? "", /frontmatter/);
    const unsafe = parseSkillDocument({
      path: "bad/SKILL.md",
      source: "repo",
      text: "---\nname: bad\ndescription: Bad\nresources: [../secret.md]\n---\nDo not load",
    });
    assert.match(unsafe.error?.message ?? "", /relative/);
    const windowsAbsolute = parseSkillDocument({
      path: "bad/SKILL.md",
      source: "repo",
      text: "---\nname: bad\ndescription: Bad\nresources: [C:\\secret.md]\n---\nDo not load",
    });
    assert.match(windowsAbsolute.error?.message ?? "", /relative/);
  });

  it("keeps parse errors visible while returning valid documents", () => {
    const result = parseSkillDocuments([
      { path: "ok/SKILL.md", source: "repo", text: "---\nname: ok\ndescription: OK\n---\nRun" },
      { path: "bad/SKILL.md", source: "repo", text: "---\nname: bad\n---\nRun" },
    ]);
    assert.deepEqual(result.skills.map((skill) => skill.name), ["ok"]);
    assert.equal(result.errors.length, 1);
  });

  it("uses scope precedence for homonymous skills", () => {
    const selected = dedupeDiscoveredSkills([
      doc({ source: "team", path: "team/demo/SKILL.md" }),
      doc({ source: "repo", path: "repo/demo/SKILL.md" }),
      doc({ source: "project", path: ".agents/skills/demo/SKILL.md" }),
    ]);
    assert.equal(selected.length, 1);
    assert.equal(selected[0].source, "project");
    assert.equal(selected[0].path, ".agents/skills/demo/SKILL.md");
  });
});
