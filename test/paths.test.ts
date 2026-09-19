import assert from "node:assert/strict";
import test from "node:test";
import { displayPath } from "../src/lib/paths.ts";

test("displayPath strips the Windows verbatim drive prefix", () => {
  assert.equal(
    displayPath("\\\\?\\C:\\Users\\etien\\AppData\\Local\\Temp\\muse-dogfood"),
    "C:\\Users\\etien\\AppData\\Local\\Temp\\muse-dogfood",
  );
});

test("displayPath restores the UNC form for verbatim network paths", () => {
  assert.equal(
    displayPath("\\\\?\\UNC\\server\\share\\dir"),
    "\\\\server\\share\\dir",
  );
  assert.equal(displayPath("\\\\?\\UNC\\server\\share"), "\\\\server\\share");
});

test("displayPath leaves ordinary and degenerate values untouched", () => {
  assert.equal(displayPath("C:\\Users\\etien"), "C:\\Users\\etien");
  assert.equal(displayPath("/mnt/c/Users/etien"), "/mnt/c/Users/etien");
  assert.equal(displayPath(""), "");
  assert.equal(displayPath("\\\\?\\"), "\\\\?\\");
  assert.equal(displayPath("\\\\?\\relative\\path"), "\\\\?\\relative\\path");
});
