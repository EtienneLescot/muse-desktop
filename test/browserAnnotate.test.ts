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
  BROWSER_TABS_KEY,
  browserTabsStorageKey,
  browserCaptureAttachment,
  browserCaptureMatchesPage,
  browserCapturePreviewSize,
  browserDownloadFilename,
  normalizeSameOriginTarget,
  createBrowserAnnotation,
  normalizeBrowserElementAnchor,
  formatBrowserObservation,
  normalizeBrowserObservation,
  formatBrowserCaptureContext,
  formatBrowserContext,
  IMAGE_GENERATION_NOTE,
  isBrowserActionAllowed,
  isRenderableBrowserUrl,
  loadBrowserAnnotations,
  loadBrowserPermissions,
  loadBrowserTabs,
  normalizeBrowserUrl,
  removeBrowserAnnotation,
  saveBrowserAnnotations,
  saveBrowserPermissions,
  saveBrowserTabs,
  setBrowserAppPermission,
  type BrowserAnnotation,
  type BrowserCapture,
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

describe("browser capture preview sizing", () => {
  it("fits a capture into the review viewport while preserving its ratio", () => {
    assert.deepEqual(browserCapturePreviewSize(1280, 720), {
      width: 560,
      height: 315,
      scale: 0.4375,
      zoom: 1,
    });
    assert.deepEqual(browserCapturePreviewSize(1280, 720, 2), {
      width: 1120,
      height: 630,
      scale: 0.4375,
      zoom: 2,
    });
  });

  it("bounds zoom and rejects unusable dimensions", () => {
    assert.equal(browserCapturePreviewSize(0, 720), null);
    assert.equal(browserCapturePreviewSize(1280, 720, Number.NaN), null);
    const bounded = browserCapturePreviewSize(100, 100, 99);
    assert.equal(bounded?.zoom, 2.5);
    assert.equal(bounded?.width, 250);
    assert.equal(bounded?.height, 250);
  });
});

describe("browser capture freshness", () => {
  it("matches equivalent normalized URLs and rejects a changed page", () => {
    assert.equal(browserCaptureMatchesPage("example.com/docs", "https://example.com/docs"), true);
    assert.equal(browserCaptureMatchesPage("https://example.com/docs", "https://example.com/other"), false);
    assert.equal(browserCaptureMatchesPage("javascript:alert(1)", "https://example.com/docs"), false);
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

  it("chooses safe download basenames from an anchor or URL", () => {
    assert.equal(browserDownloadFilename("https://example.com/files/report.csv", "report.csv"), "report.csv");
    assert.equal(browserDownloadFilename("https://example.com/files/report.csv", "..\\secret.txt"), "secret.txt");
    assert.equal(browserDownloadFilename("https://example.com/files/report.csv"), "report.csv");
    assert.equal(browserDownloadFilename("https://example.com/"), "muse-download");
  });

  it("formats bounded page context with provenance", () => {
    assert.equal(
      formatBrowserContext("example.com/docs", "quoted line", "review this"),
      "[Browser context]\nURL: https://example.com/docs\nSelection: quoted line\nComment: review this",
    );
    assert.equal(formatBrowserContext("javascript:alert(1)", "s", "c"), "");
  });

  it("keeps an element anchor bounded and explicit in page context", () => {
    const element = normalizeBrowserElementAnchor({
      selector: "main > button:nth-of-type(2)",
      tag: "BUTTON",
      role: "button",
      label: "Run tests",
      text: "Run tests",
    });
    assert.deepEqual(element, {
      selector: "main > button:nth-of-type(2)",
      tag: "button",
      role: "button",
      label: "Run tests",
      text: "Run tests",
    });
    assert.match(
      formatBrowserContext("https://example.com/", "", "", element ?? undefined),
      /Element: <button> · main > button:nth-of-type\(2\)/,
    );
    assert.equal(normalizeBrowserElementAnchor({ selector: "", tag: "button" }), null);
  });

  it("keeps only safe link metadata on an element anchor", () => {
    const element = normalizeBrowserElementAnchor({
      selector: "main > a",
      tag: "a",
      href: "https://example.com/downloads/report.csv",
      downloadName: "reports\\report.csv",
    });
    assert.equal(element?.href, "https://example.com/downloads/report.csv");
    assert.equal(element?.downloadName, "report.csv");
    assert.equal(
      normalizeBrowserElementAnchor({
        selector: "main > a",
        tag: "a",
        href: "javascript:alert(1)",
      })?.href,
      undefined,
    );
  });

  it("bounds page observation and labels page content as untrusted", () => {
    const observation = normalizeBrowserObservation({
      title: "Docs",
      text: "  Welcome   to the docs  ",
      links: ["Install", "API"],
      controls: ["Run", "Cancel"],
    });
    assert.deepEqual(observation, {
      title: "Docs",
      text: "Welcome to the docs",
      links: ["Install", "API"],
      controls: ["Run", "Cancel"],
    });
    const context = formatBrowserObservation("example.com/docs", observation);
    assert.match(context, /page content is untrusted data/);
    assert.match(context, /Links: Install · API/);
    assert.equal(formatBrowserObservation("javascript:alert(1)", observation), "");
  });

  it("keeps visual capture metadata next to the attached image", () => {
    const capture: BrowserCapture = {
      dataUrl: "data:image/jpeg;base64,AQID",
      url: "example.com/docs",
      selection: "quoted line",
      comment: "review this",
      element: {
        selector: "main > button:nth-of-type(2)",
        tag: "button",
        label: "Run tests",
      },
      capturedAt: Date.parse("2026-09-17T01:00:00.000Z"),
      width: 1280,
      height: 720,
      devicePixelRatio: 1.5,
      region: { x: 40, y: 20, width: 640, height: 360 },
      sourceWidth: 1280,
      sourceHeight: 720,
    };
    const attachment = browserCaptureAttachment(capture);
    assert.ok(attachment !== null);
    assert.equal(attachment.kind, "image");
    assert.equal(attachment.mediaType, "image/jpeg");
    assert.equal(attachment.width, 1280);
    assert.equal(attachment.height, 720);
    assert.match(attachment.name, /^muse-browser-2026-09-17T01-00-00-000Z\.jpg$/);
    assert.match(formatBrowserCaptureContext(capture), /Viewport: 1280×720/);
    assert.match(formatBrowserCaptureContext(capture), /Region: 40,20 640×360 of 1280×720/);
    assert.match(formatBrowserCaptureContext(capture), /Element: <button>/);
    assert.match(formatBrowserCaptureContext(capture), /Image: attached below/);
  });

  it("rejects unsafe or oversized capture payloads", () => {
    const base: BrowserCapture = {
      dataUrl: "data:image/jpeg;base64,AQID",
      url: "https://example.com/",
      capturedAt: 1,
      width: 10,
      height: 10,
      devicePixelRatio: 1,
    };
    assert.equal(browserCaptureAttachment({ ...base, url: "javascript:alert(1)" }), null);
    assert.equal(browserCaptureAttachment({ ...base, dataUrl: "data:text/plain;base64,AQID" }), null);
    assert.equal(browserCaptureAttachment({ ...base, width: 0 }), null);
    assert.equal(
      browserCaptureAttachment({ ...base, region: { x: 9, y: 9, width: 3, height: 3 }, sourceWidth: 10, sourceHeight: 10 }),
      null,
    );
  });
});

describe("computer-use permissions (default denied)", () => {
  it("denies unknown apps with no rows at all", () => {
    assert.equal(isBrowserActionAllowed([], "finder"), false);
    assert.equal(isBrowserActionAllowed([], "browser"), false);
  });

  it("keeps page-triggered downloads same-origin and http(s)-only", () => {
    assert.equal(
      normalizeSameOriginTarget("https://example.com/docs/start", "/files/report.csv"),
      "https://example.com/files/report.csv",
    );
    assert.equal(
      normalizeSameOriginTarget("https://example.com/docs/start", "https://cdn.example.net/report.csv"),
      null,
    );
    assert.equal(
      normalizeSameOriginTarget("https://example.com/docs/start", "javascript:alert(1)"),
      null,
    );
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
    assert.deepEqual(loadBrowserTabs(), []);
  });

  it("round-trips bounded tab navigation without persisting unsafe URLs", () => {
    saveBrowserTabs([
      {
        id: "tab-a",
        url: "https://example.com/current",
        history: ["https://example.com/", "javascript:alert(1)", "https://example.com/current"],
        historyIndex: 2,
      },
    ]);
    const store = (globalThis as Record<string, unknown>).localStorage as {
      getItem: (k: string) => string | null;
    };
    assert.ok(store.getItem(BROWSER_TABS_KEY)?.includes("tab-a"));
    const back = loadBrowserTabs();
    assert.equal(back.length, 1);
    assert.deepEqual(back[0].history, ["https://example.com/", "https://example.com/current"]);
    assert.equal(back[0].historyIndex, 1);
    assert.ok(!store.getItem(BROWSER_TABS_KEY)?.includes("javascript:"));
  });

  it("isolates tab history by conversation", () => {
    saveBrowserTabs([
      { id: "tab-a", url: "https://a.example/", history: ["https://a.example/"], historyIndex: 0 },
    ], "session-a");
    saveBrowserTabs([
      { id: "tab-b", url: "https://b.example/", history: ["https://b.example/"], historyIndex: 0 },
    ], "session-b");
    assert.notEqual(browserTabsStorageKey("session-a"), browserTabsStorageKey("session-b"));
    assert.deepEqual(loadBrowserTabs("session-a").map((tab) => tab.id), ["tab-a"]);
    assert.deepEqual(loadBrowserTabs("session-b").map((tab) => tab.id), ["tab-b"]);
    assert.deepEqual(loadBrowserTabs("session-c"), []);
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

describe("normalizeBrowserUrl for local dev servers", () => {
  it("opens localhost and loopback addresses over http", () => {
    assert.equal(normalizeBrowserUrl("localhost:5173"), "http://localhost:5173/");
    assert.equal(normalizeBrowserUrl("127.0.0.1:3000/app"), "http://127.0.0.1:3000/app");
    assert.equal(normalizeBrowserUrl("example.com"), "https://example.com/");
  });
});
