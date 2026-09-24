import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  activeSlashToken,
  applySlashCommand,
  matchSlashCommands,
  type SlashCommand,
} from "../src/lib/slashCommands.ts";

function command(name: string, origin = "host"): SlashCommand {
  return { name, description: `does ${name}`, origin };
}

describe("slash token detection", () => {
  it("opens on the leading slash and follows the caret through the name", () => {
    assert.deepEqual(activeSlashToken("/pl", 3), { query: "pl", start: 0, end: 3 });
    assert.deepEqual(activeSlashToken("/", 1), { query: "", start: 0, end: 1 });
    assert.deepEqual(activeSlashToken("  /plan", 7), { query: "plan", start: 2, end: 7 });
  });

  it("closes once the command is chosen and an argument follows", () => {
    assert.equal(activeSlashToken("/plan the release", 12), null);
  });

  it("ignores a slash that does not open the message", () => {
    assert.equal(activeSlashToken("see src/lib", 11), null);
    assert.equal(activeSlashToken("and /compact it", 12), null);
  });

  it("ignores a caret sitting outside the token", () => {
    assert.equal(activeSlashToken("/plan", 0), null);
  });
});

describe("slash command matching", () => {
  const all = [command("plan"), command("create-skill"), command("replan"), command("compact")];

  it("lists everything for a bare slash", () => {
    assert.deepEqual(matchSlashCommands(all, "").map((c) => c.name), [
      "compact",
      "create-skill",
      "plan",
      "replan",
    ]);
  });

  it("puts a prefix match before a mere containment", () => {
    assert.deepEqual(matchSlashCommands(all, "plan").map((c) => c.name), ["plan", "replan"]);
  });

  it("drops what does not match at all, and is case-insensitive", () => {
    assert.deepEqual(matchSlashCommands(all, "CREATE").map((c) => c.name), ["create-skill"]);
    assert.deepEqual(matchSlashCommands(all, "zzz"), []);
  });

  it("keeps the host entry when both sides expose one name", () => {
    const merged = matchSlashCommands([command("plan", "host"), command("plan", "workspace")], "plan");
    assert.deepEqual(merged.map((c) => c.origin), ["host"]);
  });
});

describe("applying a slash command", () => {
  it("replaces the token and leaves the caret ready for arguments", () => {
    assert.deepEqual(applySlashCommand("/pl", { query: "pl", start: 0, end: 3 }, command("plan")), {
      text: "/plan ",
      caret: 6,
    });
  });

  it("keeps whatever already followed the token", () => {
    assert.deepEqual(
      applySlashCommand("/pl rest", { query: "pl", start: 0, end: 3 }, command("plan")),
      { text: "/plan  rest", caret: 6 },
    );
  });
});
