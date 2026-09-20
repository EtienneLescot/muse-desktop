/**
 * Behaviour of `displayPath()` — the human-facing form of a filesystem path.
 *
 * The call-site *wiring* is locked by `test/navigationDetails.test.ts`, but the
 * function's own behaviour had no test. It exists because the native layer
 * canonicalizes workspaces into the verbatim `\\?\` form, which is correct for
 * identity and filesystem calls and unreadable in the UI.
 *
 * A wrong answer here is silent: the user simply sees `\\?\C:\…` in the
 * workspace label, or worse loses the server/share on a UNC path.
 */
import test, { describe, it } from "node:test";
import assert from "node:assert/strict";

const load = async (): Promise<(path: string) => string> => {
  const module = await import("../src/lib/paths.ts" as string);
  return (module as { displayPath: (path: string) => string }).displayPath;
};

const displayPath = await load();

describe("displayPath", () => {
  it("strips the verbatim drive prefix", () => {
    assert.equal(displayPath("\\\\?\\C:\\Users\\etien\\repo"), "C:\\Users\\etien\\repo");
    assert.equal(displayPath("\\\\?\\D:\\"), "D:\\");
  });

  it("is case-insensitive on the drive letter", () => {
    assert.equal(displayPath("\\\\?\\c:\\temp"), "c:\\temp");
  });

  it("rewrites a verbatim UNC path to the readable share form", () => {
    assert.equal(
      displayPath("\\\\?\\UNC\\server\\share\\folder\\file.txt"),
      "\\\\server\\share\\folder\\file.txt",
    );
    assert.equal(displayPath("\\\\?\\UNC\\server\\share"), "\\\\server\\share");
  });

  it("leaves already-readable paths untouched", () => {
    // Storage and routing keep the stored value; only the render is rewritten.
    const untouched = [
      "C:\\Users\\etien\\repo",
      "\\\\server\\share\\folder",
      "/home/etien/repo",
      "relative/path",
      "",
    ];
    for (const value of untouched) {
      assert.equal(displayPath(value), value, `should not rewrite ${JSON.stringify(value)}`);
    }
  });

  it("does not confuse a UNC prefix with a longer device name", () => {
    // `\\?\UNC\` needs both a server and a share; a bare prefix must pass
    // through rather than be silently truncated into a wrong path.
    assert.equal(displayPath("\\\\?\\UNC\\"), "\\\\?\\UNC\\");
    assert.equal(displayPath("\\\\?\\Volume{abc}\\"), "\\\\?\\Volume{abc}\\");
  });

  it("preserves trailing content exactly, including spaces", () => {
    assert.equal(
      displayPath("\\\\?\\UNC\\server\\share\\a b\\c d.txt"),
      "\\\\server\\share\\a b\\c d.txt",
    );
    assert.equal(
      displayPath("\\\\?\\C:\\Program Files\\Muse"),
      "C:\\Program Files\\Muse",
    );
  });
});
