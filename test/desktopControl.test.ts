import assert from "node:assert/strict";
import test from "node:test";
import {
  desktopCaptureAttachment,
  desktopElementLabel,
  desktopWindowLabel,
  formatDesktopCaptureContext,
  formatDesktopObservation,
  isDesktopControlAllowed,
  isDesktopPointInBounds,
  type DesktopWindow,
  type DesktopElement,
} from "../src/lib/desktopControl.ts";
import {
  buildDesktopSkillArguments,
  findDesktopSkill,
} from "../src/lib/desktopSkills.ts";

const windowFixture: DesktopWindow = {
  id: "abc",
  title: "Editor",
  bounds: { x: 20, y: 30, width: 800, height: 600 },
};

test("desktop control permission is denied unless the desktop row is explicit", () => {
  assert.equal(isDesktopControlAllowed([]), false);
  assert.equal(
    isDesktopControlAllowed([{ app: "browser", allowed: true, updatedAt: 1 }]),
    false,
  );
  assert.equal(
    isDesktopControlAllowed([{ app: "desktop", allowed: true, updatedAt: 1 }]),
    true,
  );
});

test("desktop coordinates stay within the selected window", () => {
  assert.equal(isDesktopPointInBounds(windowFixture, 0, 0), true);
  assert.equal(isDesktopPointInBounds(windowFixture, 799, 599), true);
  assert.equal(isDesktopPointInBounds(windowFixture, 800, 599), false);
  assert.equal(isDesktopPointInBounds(windowFixture, -1, 1), false);
  assert.equal(isDesktopPointInBounds(null, 0, 0), false);
});

test("desktop window labels keep title and bounded geometry visible", () => {
  assert.equal(desktopWindowLabel(windowFixture), "Editor · 800×600");
});

test("desktop observation keeps native controls bounded and attributable", () => {
  const elements: DesktopElement[] = [{
    id: "child",
    title: "Run",
    className: "Button",
    semanticRole: "button",
    automationId: "run-action",
    value: "",
    valueRedacted: false,
    bounds: { x: 12, y: 18, width: 80, height: 28 },
    enabled: true,
    visible: true,
    offscreen: false,
  }];
  assert.equal(desktopElementLabel(elements[0]), "Run · 80×28 · enabled · button");
  const context = formatDesktopObservation(windowFixture, elements);
  assert.match(context, /\[Desktop observation\]/);
  assert.match(context, /Run \[Button\]/);
  assert.match(context, /role button/);
  assert.match(context, /automationId run-action/);
  assert.match(context, /read-only/);
});

test("desktop observation exposes safe values and marks protected ones without leaking them", () => {
  const safe: DesktopElement = {
    id: "field",
    title: "Search",
    className: "Edit",
    semanticRole: "edit",
    automationId: "search",
    value: "Muse",
    valueRedacted: false,
    bounds: { x: 0, y: 0, width: 120, height: 24 },
    enabled: true,
    visible: true,
    offscreen: false,
  };
  const secret: DesktopElement = {
    ...safe,
    id: "password",
    title: "Password",
    value: "",
    valueRedacted: true,
  };
  assert.match(desktopElementLabel(safe), /value Muse/);
  assert.match(desktopElementLabel(secret), /value hidden/);
  assert.doesNotMatch(formatDesktopObservation({ ...windowFixture }, [secret]), /Muse/);
  assert.match(formatDesktopObservation({ ...windowFixture }, [safe]), /value Muse/);
});

test("desktop observation keeps semantic range and selection states readable", () => {
  const base: DesktopElement = {
    id: "semantic",
    title: "Control",
    className: "Control",
    semanticRole: "control",
    automationId: "control",
    value: "50.000 (range 0.000–100.000)",
    valueRedacted: false,
    bounds: { x: 0, y: 0, width: 80, height: 20 },
    enabled: true,
    visible: true,
    offscreen: false,
  };
  assert.match(desktopElementLabel(base), /range 0\.000–100\.000/);
  assert.match(desktopElementLabel({ ...base, value: "selected" }), /selected/);
  assert.match(desktopElementLabel({ ...base, value: "on" }), /value on/);
});

test("desktop captures keep provenance and reject oversized payloads", () => {
  const capture = {
    dataUrl: "data:image/jpeg;base64," + "A".repeat(80),
    source: "desktop-screen" as const,
    capturedAt: 1_700_000_000_000,
    width: 1280,
    height: 720,
    devicePixelRatio: 1,
  };
  const attachment = desktopCaptureAttachment(capture);
  assert.equal(attachment?.kind, "image");
  assert.match(formatDesktopCaptureContext(capture), /\[Desktop capture\]/);
  assert.equal(
    desktopCaptureAttachment({ ...capture, dataUrl: "data:image/jpeg;base64," + "A".repeat(20_000_000) }),
    null,
  );
});

test("host desktop skills are used only when the selector is advertised", () => {
  const skills = [{ selector: "computer.click", description: "Click" }];
  assert.equal(findDesktopSkill(skills, "click")?.selector, "computer.click");
  assert.equal(findDesktopSkill(skills, "type"), null);
  const args = buildDesktopSkillArguments("click", windowFixture, undefined, 12, 18);
  assert.match(args, /"action":"click"/);
  assert.match(args, /"point":\{"x":12,"y":18\}/);
});
