import assert from "node:assert/strict";
import test from "node:test";
import {
  desktopWindowLabel,
  isDesktopControlAllowed,
  isDesktopPointInBounds,
  type DesktopWindow,
} from "../src/lib/desktopControl.ts";

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

