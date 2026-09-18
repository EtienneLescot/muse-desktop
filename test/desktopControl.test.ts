import assert from "node:assert/strict";
import test from "node:test";
import {
  desktopCaptureAttachment,
  desktopWindowLabel,
  formatDesktopCaptureContext,
  isDesktopControlAllowed,
  isDesktopPointInBounds,
  type DesktopWindow,
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
