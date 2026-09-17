import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const files = [
  "../src/App.tsx",
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
