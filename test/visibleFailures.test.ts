/**
 * Wiring guard for two failures the 05/10/2026 native audits measured
 * (docs/evidence/2026-10-05-roadmap-closure/):
 *
 * - M0-13: a refused MCP probe or bundle on Extensions set the global error,
 *   but the banner was rendered only beside the conversation, so the click
 *   produced nothing visible. The banner must render on Settings and on every
 *   destination page as well.
 * - M2-01: a failed start (a moved project folder) remounts the welcome screen;
 *   the draft survived in session storage but the chosen environment and the
 *   worktree switch fell back to the defaults, so a retry ran elsewhere.
 * - M1-05: after any tab change, the terminal's Close reopened a shell at once;
 *   otherwise it left "Terminal unavailable" with no way to open a new one.
 * - M3-02: a failed remote call disconnected the session, but the "Connected
 *   to …" block stayed on screen beside "Disconnected".
 *
 * Both are layout/lifecycle facts that the pure-logic tests cannot see.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (relative: string): string =>
  readFileSync(new URL(relative, import.meta.url), "utf8");

describe("visible failures", () => {
  it("renders the error banner in the conversation, on Settings and on destination pages", () => {
    const app = read("../src/App.tsx");
    assert.equal(app.match(/className="error-banner"/g)?.length, 1, "one banner definition");
    const uses = app.match(/\{errorBanner\}|: errorBanner\}/g) ?? [];
    assert.equal(uses.length, 3, "conversation + Settings + destination pages");
    const settings = app.indexOf("<h1>Settings</h1>");
    assert.ok(settings > 0 && app.indexOf("{errorBanner}", settings) - settings < 120, "banner right under the Settings title");
    const destination = app.indexOf('className="destination-page"', settings);
    const projects = app.indexOf('page === "projects" && (', destination);
    assert.ok(app.slice(destination, projects).includes("{errorBanner}"), "banner before the destination panels");
  });

  it("keeps the welcome environment and worktree choice with the draft until a start succeeds", () => {
    const screen = read("../src/components/EmptySessionScreen.tsx");
    for (const key of ["welcomeEnvironmentKey", "welcomeWorktreeKey"]) {
      assert.match(screen, new RegExp(`readSessionStorageString\\(${key}\\)`), `${key} restored on mount`);
      assert.match(screen, new RegExp(`writeSessionStorageString\\(${key},`), `${key} written on change`);
      assert.match(screen, new RegExp(`removeSessionStorageKey\\(${key}\\)`), `${key} cleared after a successful start`);
    }
  });

  it("keeps a closed terminal closed and offers to open a new one", () => {
    const panel = read("../src/components/TerminalPanel.tsx");
    assert.match(panel, /if \(terminal\) \{\s*attemptedSession\.current = sessionId;\s*return;\s*\}/, "a mount on a live terminal counts as the attempt");
    assert.match(panel, /<button type="button" onClick=\{open\}>Open terminal<\/button>/, "the empty state opens a new terminal");
    assert.doesNotMatch(panel, /Terminal unavailable/);
  });

  it("shows the remote connection block only while that connector is connected", () => {
    const panel = read("../src/components/ConnectorPanel.tsx");
    assert.match(panel, /\{remoteProbe && remoteConnectedIds\.includes\(remoteId\) && \(/);
    assert.match(panel, /connectorId: remoteId,/, "the call targets the same connector id");
  });
});
