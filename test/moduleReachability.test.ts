/**
 * Every module in `src/lib` must stay importable by a test.
 *
 * Two modules — `notificationLedger.ts` and `scheduleRunLedger.ts` — were
 * unreachable for a while because they imported *values* without a file
 * extension (`from "./env"`). Node's ESM resolver rejects that, even under
 * `--experimental-strip-types`, so no test file could import them at all. Both
 * were live production code used by `useMuseSessions.ts`.
 *
 * `import type` is not affected: type stripping erases those imports before the
 * resolver sees them, which is why a scan for extensionless imports over-reports
 * the problem. This test therefore checks the only thing that matters — whether
 * the module actually loads.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";

const LIB_DIR = new URL("../src/lib/", import.meta.url);

const modules = readdirSync(LIB_DIR)
  .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
  .sort();

describe("src/lib module reachability", () => {
  it("finds the modules to check", () => {
    // A silent zero would make every assertion below vacuous.
    assert.ok(modules.length > 50, `expected many modules, found ${modules.length}`);
  });

  for (const name of modules) {
    it(`${name} can be imported by a test`, async () => {
      try {
        await import(new URL(name, LIB_DIR).href);
      } catch (error) {
        const code = (error as { code?: string }).code ?? "";
        assert.fail(
          `${name} is unreachable from tests (${code || String(error)}). ` +
          `A value import is probably missing its file extension — see ` +
          `notificationLedger.ts for the pattern.`,
        );
      }
    });
  }
});
