/**
 * US-19 browser + computer-use (scoped).
 *
 * - URL normalization: bare domains gain https://, non-http(s) rejected.
 * - Anchored comments: comment attaches to URL + selection, persists.
 * - Computer-use: per-app toggle, default denied.
 * - Image generation: explicitly out of scope.
 *
 * Runs on the built-in node:test runner, no extra framework:
 *   npm test
 */
import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  addBrowserAnnotation,
  annotationsForUrl,
  BROWSER_ANNOTATIONS_KEY,
  BROWSER_PERMS_KEY,
  createBrowserAnnotation,
  formatBrowserContext,
  IMAGE_GENERATION_NOTE,
  isBrowserActionAllowed,
  isRenderableBrowserUrl,
  loadBrowserAnnotations,
  loadBrowserPermissions,
  normalizeBrowserUrl,
  removeBrowserAnnotation,
  saveBrowserAnnotations,
  saveBrowserPermissions,
  setBrowserAppPermission,
  type BrowserAnnotation,
} from "../src/lib/browserAnnotate.ts";

function fakeStorage(): Map<string, string> {
  const m = new Map<string, string>();
  (globalThis as Record<string, unknown>).localStorage = {
    getItem: (k: string): string | null => (m.has(k) ? (m.get(k) as string) : null),
    setItem: (k: string, v: string): void => {
      m.set(k, String(v));
    },
    removeItem: (k: string): void => {
      m.delete(k);
    },
  };
  return m;
}

describe("browser URL normalization", () => {
  it("accepts http(s) URLs", () => {
    assert.equal(normalizeBrowserUrl("https://example.com/a"), "https://example.com/a");
    assert.equal(normalizeBrowserUrl("http://example.com/"), "http://example.com/");
  });

  it("prepends https:// to a bare domain", () => {
    assert.equal(normalizeBrowserUrl("example.com"), "https://example.com/");
  });

  it("rejects empty input and non-http(s) schemes", () => {
    assert.equal(normalizeBrowserUrl("   "), null);
    assert.equal(normalizeBrowserUrl("not a url"), null);
    assert.equal(normalizeBrowserUrl("javascript:alert(1)"), null);
    assert.equal(normalizeBrowserUrl("file:///etc/passwd"), null);
    assert.equal(isRenderableBrowserUrl("javascript:alert(1)"), false);
    assert.equal(isRenderableBrowserUrl("example.com"), true);
  });
});

describe("anchored comments", () => {
  it("anchors a comment to URL + selection text", () => {
    const a = createBrowserAnnotation("example.com", "quoted line", "look here");
    assert.ok(a !== null);
    assert.equal(a.url, "https://example.com/");
    assert.equal(a.selection, "quoted line");
    assert.equal(a.comment, "look here");
  });

  it("rejects invalid URLs and empty comments", () => {
    assert.equal(createBrowserAnnotation("javascript:x", "s", "c"), null);
    assert.equal(createBrowserAnnotation("example.com", "s", "   "), null);
  });

  it("adds and removes annotations", () => {
    const a = createBrowserAnnotation("https://example.com/", "", "note");
    assert.ok(a !== null);
    let list = addBrowserAnnotation([], a);
    assert.equal(list.length, 1);
    // Null drafts (invalid rows) never stored.
    assert.deepEqual(addBrowserAnnotation(list, null), list);
    list = removeBrowserAnnotation(list, a.id);
    assert.deepEqual(list, []);
  });

  it("filters annotations per page URL", () => {
    const a = createBrowserAnnotation("https://example.com/a", "x", "one") as BrowserAnnotation;
    const b = createBrowserAnnotation("https://other.test/", "y", "two") as BrowserAnnotation;
    const list = [a, b];
    // Bare-domain form resolves to the same anchor.
    assert.deepEqual(annotationsForUrl(list, "example.com/a").map((x) => x.id), [a.id]);
    assert.deepEqual(annotationsForUrl(list, "https://other.test/").map((x) => x.id), [b.id]);
    assert.deepEqual(annotationsForUrl(list, "javascript:x"), []);
  });

  it("formats bounded page context with provenance", () => {
    assert.equal(
      formatBrowserContext("example.com/docs", "quoted line", "review this"),
      "[Browser context]\nURL: https://example.com/docs\nSelection: quoted line\nComment: review this",
    );
    assert.equal(formatBrowserContext("javascript:alert(1)", "s", "c"), "");
  });
});

describe("computer-use permissions (default denied)", () => {
  it("denies unknown apps with no rows at all", () => {
    assert.equal(isBrowserActionAllowed([], "finder"), false);
  });

  it("toggles one app without affecting others", () => {
    let perms = setBrowserAppPermission([], "finder", true);
    assert.equal(isBrowserActionAllowed(perms, "finder"), true);
    assert.equal(isBrowserActionAllowed(perms, "terminal"), false);
    perms = setBrowserAppPermission(perms, "terminal", false);
    assert.equal(isBrowserActionAllowed(perms, "terminal"), false);
    // Re-toggle updates the row instead of duplicating it.
    perms = setBrowserAppPermission(perms, "finder", false);
    assert.equal(perms.filter((p) => p.app === "finder").length, 1);
    assert.equal(isBrowserActionAllowed(perms, "finder"), false);
  });

  it("ignores empty app names", () => {
    assert.deepEqual(setBrowserAppPermission([], "   ", true), []);
  });
});

describe("browser persistence", () => {
  beforeEach(() => {
    fakeStorage();
  });

  it("returns [] when nothing was stored", () => {
    assert.deepEqual(loadBrowserAnnotations(), []);
    assert.deepEqual(loadBrowserPermissions(), []);
  });

  it("round-trips annotations under the muse-desktop.* key", () => {
    const a = createBrowserAnnotation("https://example.com/", "sel", "note");
    assert.ok(a !== null);
    saveBrowserAnnotations([a]);
    const store = (globalThis as Record<string, unknown>).localStorage as {
      getItem: (k: string) => string | null;
    };
    assert.ok(store.getItem(BROWSER_ANNOTATIONS_KEY)?.includes("note"));
    const back = loadBrowserAnnotations();
    assert.equal(back.length, 1);
    assert.equal(back[0].url, "https://example.com/");
    assert.equal(back[0].selection, "sel");
  });

  it("round-trips permissions under the muse-desktop.* key", () => {
    saveBrowserPermissions(setBrowserAppPermission([], "finder", true));
    const store = (globalThis as Record<string, unknown>).localStorage as {
      getItem: (k: string) => string | null;
    };
    assert.ok(store.getItem(BROWSER_PERMS_KEY)?.includes("finder"));
    const back = loadBrowserPermissions();
    assert.equal(isBrowserActionAllowed(back, "finder"), true);
  });

  it("filters out invalid entries and corrupt payloads", () => {
    (globalThis as Record<string, unknown>).localStorage = {
      getItem: () =>
        JSON.stringify([
          { id: "ok", url: "https://example.com/", selection: "", comment: "c", createdAt: 1 },
          { id: "bad", url: "", selection: "", comment: "", createdAt: 1 },
        ]),
      setItem: () => {},
      removeItem: () => {},
    };
    assert.deepEqual(loadBrowserAnnotations().map((a) => a.id), ["ok"]);
  });
});

describe("image generation scope", () => {
  it("states honestly that image generation is out of scope", () => {
    assert.match(IMAGE_GENERATION_NOTE, /not available/i);
  });
});
