import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const files = [
  "../src/App.tsx",
  "../src/components/ArtifactsPane.tsx",
  "../src/components/CompactBar.tsx",
  "../src/components/ImportPanel.tsx",
  "../src/components/ProjectsPanel.tsx",
  "../src/components/SessionSidebar.tsx",
];

const legacyFrenchUi = [
  "Compacter",
  "Recompacter",
  "Summary du",
  "log actuel",
  "Regroupez vos",
  "Source connue",
  "Importer le texte",
  "Actions :",
  'toLocaleLowerCase("fr")',
  // Shipped in the work panel's Conversation summary: "… 2 subagent, 0 outil,
  // 0 system." — French in an English sentence. A visual review caught it, not
  // this test, because ArtifactsPane.tsx was not in the audited set. It is now.
  "} outil",
];

describe("English product copy", () => {
  it("keeps the audited navigation and secondary surfaces in English", () => {
    for (const relative of files) {
      const source = readFileSync(new URL(relative, import.meta.url), "utf8");
      for (const phrase of legacyFrenchUi) {
        assert.equal(
          source.includes(phrase),
          false,
          `${relative} still contains legacy UI copy: ${phrase}`,
        );
      }
    }
  });
});
