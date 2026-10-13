#!/usr/bin/env node
/**
 * M4-01 on macOS: the built-in browser, in WKWebView. One isolated instance
 * (scripts/macos/test-instance.mjs) on the pinned engine; one live turn only to
 * open a conversation (the Browser panel belongs to one).
 *
 * The Windows criteria (m4-01-browser.json, roadmap M4-01), replayed here:
 *   1. navigation renders in the sandboxed iframe (a local page served on
 *      127.0.0.1, which reports its own location to the parent by postMessage,
 *      and the server sees the request);
 *   2. in-tab history: Back and Forward;
 *   3. a second tab with its own history, both persisted under the
 *      conversation's key of muse-desktop.browser.tabs.v1, restored after a reload;
 *   4. no unplanned protocol: file:, javascript:, tauri: refused by the panel,
 *      file: and embedded credentials refused by the native boundary;
 *   5. Open native: a dedicated muse-browser window (WKWebView) on the page,
 *      a private non-persistent store (a cookie and localStorage written there
 *      are gone after Close native and a reopen; the server sees no cookie),
 *      distinct from the app's store; one window per conversation (opening for
 *      another conversation closes the first); Close native idempotent.
 * Addresses are typed with the bridge's trusted keyboard and the buttons
 * clicked with its trusted mouse.
 *
 *   node scripts/macos/m4-01-browser.mjs --exe ~/muse-proofs/app/08b291d/muse-desktop [--port 9471] [--web 9472] [--base <dir>] [--out <json>]
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { argValue, redactor, sleep, waitFor } from "../cdp-harness.mjs";
import { newProjectConversation, sendFirstMessage, transcript } from "./smoke-real-turn.mjs";
import { launch, processTree } from "./test-instance.mjs";

const EXE = resolve(argValue("--exe", "src-tauri/target/debug/muse-desktop"));
const PORT = Number(argValue("--port", "9471"));
const WEB = Number(argValue("--web", "9472"));
const CLOSED = Number(argValue("--closed", "9479"));
const BASE = resolve(argValue("--base", join(tmpdir(), "muse-proofs-g7", "m4-01")));
const OUT = argValue("--out", "docs/evidence/2026-10-13-macos-closure/m4-01-browser-macos.json");
const ID = Date.now().toString(36);
const ORIGIN = `http://127.0.0.1:${WEB}`;

// ---- the local test site ---------------------------------------------------------
const hits = [];
const page = (name) => `<!doctype html><meta charset="utf-8"><title>M4-01 ${name}</title>
<body style="font:16px system-ui;background:#fffbe6"><h1>M4-01 page ${name}</h1><p id="cookie"></p>
<script>
  let ls = null; try { ls = localStorage.getItem("m401"); } catch (e) { ls = "error: " + e.message; }
  document.getElementById("cookie").textContent = "cookie=" + document.cookie;
  try { parent.postMessage({ m401: true, page: ${JSON.stringify(name)}, href: location.href, origin: location.origin, title: document.title, cookie: document.cookie, ls, ua: navigator.userAgent }, "*"); } catch (e) {}
</script>`;
const server = createServer((req, res) => {
  hits.push({ at: Date.now(), path: req.url, cookie: req.headers.cookie ?? null, ua: String(req.headers["user-agent"] ?? "").slice(0, 160) });
  const name = (req.url ?? "").match(/^\/(\w+)\.html/)?.[1];
  if (!name) { res.writeHead(404).end("not found"); return; }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(page(name));
});
await new Promise((ok, fail) => { server.once("error", fail); server.listen(WEB, "127.0.0.1", ok); });
const hitsOf = (path, since = 0) => hits.filter((h) => h.path === path && h.at >= since);

// ---- page helpers ------------------------------------------------------------------
async function click(app, expr) {
  const at = await app.ev(`(() => { const el = ${expr}; if (!el) return null; el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, disabled: Boolean(el.disabled) }; })()`);
  if (!at) throw new Error(`nothing to click: ${expr}`);
  await app.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: at.x, y: at.y });
  await app.send("Input.dispatchMouseEvent", { type: "mousePressed", x: at.x, y: at.y, button: "left", buttons: 1, clickCount: 1 });
  await app.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: at.x, y: at.y, button: "left", buttons: 0, clickCount: 1 });
  await sleep(250);
  return at;
}
const ADDRESS = `document.querySelector('input[aria-label="Address"]')`;
/** Click the address bar (it selects its text), type, press Enter: as a user would. */
async function typeAddress(app, text) {
  await click(app, ADDRESS);
  await app.ev(`(${ADDRESS}.select(), true)`);
  await app.send("Input.insertText", { text });
  await waitFor(() => app.ev(`${ADDRESS}.value === ${JSON.stringify(text)}`), 5_000, 100);
  await app.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", text: "\r" });
  await app.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter" });
  await sleep(400);
}
const panelState = (app) => app.ev(`(() => {
  const panel = document.querySelector('[aria-label="In-app browser"]');
  const frame = panel?.querySelector('iframe');
  return {
    iframeSrc: frame?.getAttribute('src') ?? null,
    sandbox: frame?.getAttribute('sandbox') ?? null,
    address: ${ADDRESS}?.value ?? null,
    notice: panel?.querySelector('.browser-notice')?.textContent ?? null,
    tabs: [...(panel?.querySelectorAll('[role="tab"]') ?? [])].map((t) => ({ title: t.getAttribute('title'), selected: t.getAttribute('aria-selected') === 'true' })),
    back: !panel?.querySelector('button[aria-label="Back"]')?.disabled,
    forward: !panel?.querySelector('button[aria-label="Forward"]')?.disabled,
  };
})()`);
/** The last postMessage a framed page sent to the app, after `since` messages. */
const frameMessages = (app) => app.ev("window.__m401 || []");
const INSTALL_LISTENER = `(() => { if (!window.__m401) { window.__m401 = []; window.addEventListener('message', (e) => { if (e.data && e.data.m401) window.__m401.push({ origin: e.origin, ...e.data }); }); } return true; })()`;
async function waitFrame(app, pageName, count) {
  return waitFor(async () => { const list = await frameMessages(app); return list.length > count && list.at(-1).page === pageName ? list.at(-1) : null; }, 10_000, 200);
}
async function openBrowserPanel(app) {
  if (!(await app.ev(`Boolean(document.querySelector('nav.work-tabs'))`))) await click(app, `document.querySelector('button[aria-label="Show work panel"]')`);
  await waitFor(() => app.ev(`Boolean(document.querySelector('nav.work-tabs'))`), 5_000, 100);
  await click(app, `[...document.querySelectorAll('nav.work-tabs button')].find((b) => b.textContent.trim() === 'Browser')`);
  return waitFor(() => app.ev(`Boolean(document.querySelector('[aria-label="In-app browser"]'))`), 5_000, 100);
}
const invoke = (app, cmd, args) => app.ev(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args)}).then((value) => ({ ok: true, value }), (error) => ({ ok: false, error: String(error) }))`);

// ---- another window of the app, over the bridge ----------------------------------
const targets = async () => (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).map((t) => ({ id: t.id, title: t.title, url: t.url, ws: t.webSocketDebuggerUrl }));
async function openTarget(ws) {
  const socket = new WebSocket(ws);
  let next = 1;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const frame = JSON.parse(String(event.data));
    const entry = pending.get(frame.id);
    if (!entry) return;
    pending.delete(frame.id);
    frame.error ? entry.reject(new Error(frame.error.message)) : entry.resolve(frame.result);
  });
  await new Promise((ok, fail) => { socket.addEventListener("open", ok, { once: true }); socket.addEventListener("error", () => fail(new Error("socket error")), { once: true }); });
  const send = (method, params = {}) => new Promise((ok, fail) => { const id = next++; pending.set(id, { resolve: ok, reject: fail }); socket.send(JSON.stringify({ id, method, params })); setTimeout(() => { if (pending.delete(id)) fail(new Error(`${method}: timed out`)); }, 20_000); });
  const ev = async (expression) => {
    const result = await send("Runtime.evaluate", { expression: `(async () => JSON.stringify(await (${expression})))()`, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? "evaluation failed");
    return JSON.parse(result.result?.value ?? "null");
  };
  return { send, ev, close: () => socket.close() };
}

// ---- scenario --------------------------------------------------------------------
const project = join(BASE, `project-${ID}`);
mkdirSync(project, { recursive: true });
const platform = execFileSync("sw_vers", [], { encoding: "utf8" }).trim().split("\n").map((l) => l.split(":")[1].trim());
const report = {
  schema: "muse-desktop.m4-01-browser-macos.v1",
  ticket: "M4-01",
  date: new Date().toISOString().slice(0, 10),
  commit: "08b291d",
  platform: `${platform[0]} ${platform[1]} (${platform[2]}), ${execFileSync("uname", ["-m"], { encoding: "utf8" }).trim()}, Apple Silicon; debug build with embedded frontend, WKWebView through the test bridge`,
  harness: "scripts/macos/m4-01-browser.mjs on scripts/macos/test-instance.mjs",
  liveTurns: 0,
  method: "One isolated test instance (fresh data folder, its own WKWebView store, pinned engine with auto-update off). A conversation is opened with one live turn, then the Browser work panel is driven with the bridge's trusted AppKit mouse and keyboard events: addresses typed into the address bar and Enter, Back, Forward, New tab, the tab buttons, Reload and Open in a browser window clicked. The framed pages come from a local Node server on 127.0.0.1 that logs every request with its Cookie header; each page posts its own location, origin and cookie to the app page, which a listener records. The native browser window is read through its own bridge WebSocket (/json/list lists every window). Close native and a second conversation's surface are invoked through the app's IPC (the panel has no Close button); the refusals of the native boundary likewise.",
  limits: [
    "The pages are local (127.0.0.1): a public site's framing refusal (X-Frame-Options, CSP frame-ancestors) and a real network error are not measured here, nor on Windows.",
    "Downloads are no longer in the panel (removed on 23/09): not replayed.",
    "The bridge has no Network domain: the absence of a cookie is read from the test server's request log and from document.cookie, not from WebKit's cookie store.",
    "Other proof agents run test instances in parallel on this Mac, so the number of stores under ~/Library/WebKit/muse-desktop/WebsiteDataStore is not attributable: the check is that this run's own store is deleted and the default stores unchanged.",
  ],
  checks: {},
};
const inst = await launch({ exe: EXE, port: PORT, data: join(BASE, `data-${ID}`) });
report.engine = inst.engineVersion;
report.isolation = inst.isolation;
const app = inst.app;
let native = null;
try {
  // A conversation: the Browser panel belongs to one.
  await newProjectConversation(app, project);
  const sid = await sendFirstMessage(app, "Reply with exactly OK and nothing else.");
  report.liveTurns = 1;
  await waitFor(async () => (await transcript(app, sid)).some((e) => e.role === "assistant"), 180_000, 1_000);
  await app.ev(INSTALL_LISTENER);
  report.checks.panelOpened = await openBrowserPanel(app);

  // 1. Navigation renders in the sandboxed iframe.
  let seen = (await frameMessages(app)).length;
  let t = Date.now();
  await typeAddress(app, `127.0.0.1:${WEB}/a.html`);
  const a = await waitFrame(app, "a", seen);
  report.checks.navigation = { panel: await panelState(app), frameReported: a, serverHits: hitsOf("/a.html", t).length };

  // 2. History in the tab: a -> b, Back -> a, Forward -> b.
  seen = (await frameMessages(app)).length;
  await typeAddress(app, `${ORIGIN}/b.html`);
  const b = await waitFrame(app, "b", seen);
  const afterB = await panelState(app);
  seen = (await frameMessages(app)).length; t = Date.now();
  await click(app, `document.querySelector('[aria-label="In-app browser"] button[aria-label="Back"]')`);
  const back = await waitFrame(app, "a", seen);
  const afterBack = await panelState(app);
  const backHits = hitsOf("/a.html", t).length;
  seen = (await frameMessages(app)).length;
  await click(app, `document.querySelector('[aria-label="In-app browser"] button[aria-label="Forward"]')`);
  const forward = await waitFrame(app, "b", seen);
  report.checks.history = { afterB: { src: afterB.iframeSrc, back: afterB.back, frame: b?.href ?? null }, afterBack: { src: afterBack.iframeSrc, forward: afterBack.forward, frame: back?.href ?? null, serverHits: backHits }, afterForward: { src: (await panelState(app)).iframeSrc, frame: forward?.href ?? null } };

  // 3. A second tab, its own history; persisted per conversation; restored after a reload.
  await click(app, `document.querySelector('[aria-label="In-app browser"] button[aria-label="New tab"]')`);
  const blank = await panelState(app);
  seen = (await frameMessages(app)).length;
  await typeAddress(app, `${ORIGIN}/c.html`);
  const c = await waitFrame(app, "c", seen);
  const tab2 = await panelState(app);
  seen = (await frameMessages(app)).length;
  await click(app, `document.querySelectorAll('[aria-label="In-app browser"] [role="tab"]')[0]`);
  const tab1Frame = await waitFrame(app, "b", seen);
  const tab1 = await panelState(app);
  const stored = await app.ev(`(() => Object.keys(localStorage).filter((k) => k.startsWith('muse-desktop.browser.tabs.v1')).map((k) => ({ key: k, tabs: JSON.parse(localStorage.getItem(k)).map((t) => ({ url: t.url, history: t.history, historyIndex: t.historyIndex })) })))()`);
  const expectedKey = await app.ev(`(() => { let h = 0x811c9dc5; for (const ch of ${JSON.stringify(sid)}) { h ^= ch.codePointAt(0); h = Math.imul(h, 0x01000193); } return 'muse-desktop.browser.tabs.v1.session.' + (h >>> 0).toString(16).padStart(8, '0'); })()`);
  await app.send("Page.reload");
  await waitFor(() => app.ev("document.readyState === 'complete' && Boolean(document.querySelector('.primary-nav'))").catch(() => false), 30_000, 250);
  await sleep(1_000);
  await app.ev(INSTALL_LISTENER);
  await click(app, `[...document.querySelectorAll('button.session-select')][0]`).catch(() => null);
  await sleep(800);
  await openBrowserPanel(app);
  await sleep(800);
  const restored = await panelState(app);
  report.checks.tabs = {
    newTabBlank: { src: blank.iframeSrc, back: blank.back, count: blank.tabs.length },
    secondTab: { src: tab2.iframeSrc, back: tab2.back, frame: c?.href ?? null, count: tab2.tabs.length },
    firstTabAgain: { src: tab1.iframeSrc, back: tab1.back, frame: tab1Frame?.href ?? null },
    stored,
    storedUnderConversationKey: stored.length === 1 && stored[0].key === expectedKey,
    afterReload: { count: restored.tabs.length, titles: restored.tabs.map((t) => t.title) },
  };

  // 4. No unplanned protocol.
  const refused = {};
  for (const url of ["file:///etc/hosts", "javascript:alert(1)", "tauri://localhost/index.html"]) {
    const before = await panelState(app);
    await typeAddress(app, url);
    const after = await panelState(app);
    refused[url] = { notice: after.notice, iframeUnchanged: after.iframeSrc === before.iframeSrc };
  }
  const nativeRefusals = {};
  for (const url of ["file:///etc/hosts", `http://user:pw@127.0.0.1:${WEB}/a.html`, "javascript:alert(1)"]) {
    const answer = await invoke(app, "open_native_browser", { url, sessionId: sid });
    nativeRefusals[url] = answer.ok ? `OPENED (${answer.value})` : answer.error;
  }
  report.checks.protocols = { panel: refused, nativeBoundary: nativeRefusals, windowsAfter: (await targets()).length };

  // 5. Open native: a muse-browser WKWebView window, private and non-persistent.
  seen = hits.length;
  await typeAddress(app, `${ORIGIN}/n.html`);
  t = Date.now();
  await click(app, `document.querySelector('[aria-label="In-app browser"] button[aria-label="Open in a browser window"]')`);
  const opened = await waitFor(async () => (await targets()).find((x) => x.id.startsWith("muse-browser-") && x.url.includes("/n.html")) ?? null, 15_000, 300);
  native = opened ? await openTarget(opened.ws) : null;
  const first = native ? await waitFor(() => native.ev("document.readyState === 'complete' ? { href: location.href, title: document.title, cookie: document.cookie, ls: localStorage.getItem('m401'), ua: navigator.userAgent } : null").catch(() => null), 10_000, 200) : null;
  const write = native ? await native.ev("(document.cookie = 'native401=kept; max-age=86400; path=/', localStorage.setItem('m401', 'native'), { cookie: document.cookie, ls: localStorage.getItem('m401') })") : null;
  const nativeHitsFirst = hits.slice(seen).filter((h) => h.path === "/n.html").map((h) => ({ cookie: h.cookie }));
  // The app's own iframe never sees the native window's cookie (another store).
  seen = (await frameMessages(app)).length;
  t = Date.now();
  await click(app, `document.querySelector('[aria-label="In-app browser"] button[aria-label="Reload"]')`);
  const iframeAfter = await waitFrame(app, "n", seen);
  const iframeHit = hitsOf("/n.html", t).map((h) => ({ cookie: h.cookie }));
  native?.close();
  // Close native, twice: true then false (idempotent).
  const close1 = await invoke(app, "close_native_browser", { sessionId: sid });
  const goneAfterClose = await waitFor(async () => !(await targets()).some((x) => x.id.startsWith("muse-browser-")), 10_000, 300);
  const close2 = await invoke(app, "close_native_browser", { sessionId: sid });
  // Reopen: a fresh private store, nothing kept.
  seen = hits.length;
  await click(app, `document.querySelector('[aria-label="In-app browser"] button[aria-label="Open in a browser window"]')`);
  const reopened = await waitFor(async () => (await targets()).find((x) => x.id.startsWith("muse-browser-")) ?? null, 15_000, 300);
  native = reopened ? await openTarget(reopened.ws) : null;
  const second = native ? await waitFor(() => native.ev("document.readyState === 'complete' ? { href: location.href, cookie: document.cookie, ls: localStorage.getItem('m401') } : null").catch(() => null), 10_000, 200) : null;
  const nativeHitsSecond = hits.slice(seen).filter((h) => h.path === "/n.html").map((h) => ({ cookie: h.cookie }));
  native?.close();
  // Another conversation's surface closes this one first (one per conversation).
  const other = await invoke(app, "open_native_browser", { url: `${ORIGIN}/o.html`, sessionId: `other-${ID}` });
  const afterOther = await waitFor(async () => { const list = (await targets()).filter((x) => x.id.startsWith("muse-browser-")); return list.length === 1 && list[0].id !== reopened?.id ? list : null; }, 10_000, 300);
  const closeOther = await invoke(app, "close_native_browser", { sessionId: `other-${ID}` });
  const noneLeft = await waitFor(async () => !(await targets()).some((x) => x.id.startsWith("muse-browser-")), 10_000, 300);
  report.checks.native = {
    opened: opened ? { label: "muse-browser-<hash>", title: opened.title, url: opened.url } : null,
    firstLoad: first ? { href: first.href, title: first.title, cookie: first.cookie, ls: first.ls, webkit: /AppleWebKit/.test(first.ua) && !/Chrome|Edg\//.test(first.ua) } : null,
    written: write,
    serverSawFirst: nativeHitsFirst,
    appIframeAfterNativeWrite: { frameCookie: iframeAfter?.cookie ?? null, serverCookie: iframeHit },
    close1, goneAfterClose: Boolean(goneAfterClose), close2,
    reopened: reopened ? { sameLabel: reopened.id === opened?.id, url: reopened.url } : null,
    afterReopen: second,
    serverSawAfterReopen: nativeHitsSecond,
    otherConversation: { open: other, onlyOneWindowAndNotTheFirst: Boolean(afterOther), close: closeOther, noneLeft: Boolean(noneLeft) },
  };
  report.processes = processTree(inst.pid).map((p) => p.command.replace(/^.*\//, "").slice(0, 100));
} catch (error) {
  report.failure = String(error?.message ?? error).slice(0, 400);
} finally {
  native?.close();
  report.consoleErrors = app.errors.slice(0, 20);
  report.stop = await inst.stop();
  server.close();
}

const c = report.checks;
report.verdicts = {
  "1 navigation renders in the sandboxed iframe": c.navigation?.panel?.iframeSrc === `${ORIGIN}/a.html` && c.navigation.panel.sandbox === "allow-scripts allow-same-origin allow-forms allow-popups" && c.navigation.frameReported?.href === `${ORIGIN}/a.html` && c.navigation.frameReported?.origin === ORIGIN && c.navigation.serverHits >= 1,
  "2 history Back and Forward in the tab": c.history?.afterB?.back === true && c.history.afterBack.src === `${ORIGIN}/a.html` && c.history.afterBack.frame === `${ORIGIN}/a.html` && c.history.afterBack.forward === true && c.history.afterForward.frame === `${ORIGIN}/b.html`,
  "3 second tab with its own history": c.tabs?.newTabBlank?.src === null && c.tabs.newTabBlank.back === false && c.tabs.secondTab.count === 2 && c.tabs.secondTab.frame === `${ORIGIN}/c.html` && c.tabs.secondTab.back === false && c.tabs.firstTabAgain.frame === `${ORIGIN}/b.html` && c.tabs.firstTabAgain.back === true,
  "3 tabs persisted under the conversation key and restored": c.tabs?.storedUnderConversationKey === true && c.tabs.afterReload.count === 2,
  "4 unplanned protocols refused": Object.values(c.protocols?.panel ?? {}).length === 3 && Object.values(c.protocols.panel).every((r) => /http or https/.test(r.notice ?? "") && r.iframeUnchanged) && Object.values(c.protocols.nativeBoundary).every((e) => !/^OPENED/.test(e)),
  "5 Open native: a WKWebView muse-browser window on the page": Boolean(c.native?.opened) && c.native.firstLoad?.href === `${ORIGIN}/n.html` && c.native.firstLoad.webkit === true,
  "5 native store private and distinct from the app's": c.native?.written?.cookie?.includes("native401=kept") && !String(c.native.appIframeAfterNativeWrite.frameCookie ?? "").includes("native401") && c.native.appIframeAfterNativeWrite.serverCookie.every((h) => !String(h.cookie ?? "").includes("native401")),
  "5 native store non-persistent across Close native and reopen": c.native?.afterReopen?.cookie === "" && c.native.afterReopen.ls === null && c.native.serverSawAfterReopen.length >= 1 && c.native.serverSawAfterReopen.every((h) => h.cookie === null),
  "5 Close native idempotent": c.native?.close1?.value === true && c.native.goneAfterClose && c.native.close2?.ok === true && c.native.close2.value === false,
  "5 one native window per conversation": c.native?.otherConversation?.onlyOneWindowAndNotTheFirst === true && c.native.otherConversation.noneLeft === true,
  "isolation: test store deleted, default stores unchanged": report.stop?.defaultStoresUnchangedAtEnd === true && report.stop.testStoreDeleted === true,
  "clean stop": report.stop?.leftAfterQuit?.length === 0 && !report.failure,
};
report.passed = Object.values(report.verdicts).every(Boolean);
const redact = redactor([[BASE, "<proof>"], [BASE.replace(/^\/var\//, "/private/var/"), "<proof>"], [homedir(), "<home>"]]);
const text = `${JSON.stringify(redact(report), null, 2)}\n`;
mkdirSync(resolve(OUT, ".."), { recursive: true });
writeFileSync(OUT, text);
console.log(JSON.stringify({ verdicts: report.verdicts, failure: report.failure ?? null }, null, 2));
process.exit(report.passed ? 0 : 1);
