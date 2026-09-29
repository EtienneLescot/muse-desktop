#!/usr/bin/env node
/**
 * M4-02: anchor a comment to the browser's active page, verify persistence
 * (muse-desktop.browser.annotations.v1), list rendering, and prompt insertion.
 */
const list = await (await fetch("http://127.0.0.1:9222/json/list")).json();
const page = list.find((t) => t.type === "page" && t.url.includes("tauri.localhost") && t.webSocketDebuggerUrl);
const socket = new WebSocket(page.webSocketDebuggerUrl);
let nextId = 1;
const pending = new Map();
socket.addEventListener("message", (e) => {
  const f = JSON.parse(typeof e.data === "string" ? e.data : "");
  if (f.id === undefined || !pending.has(f.id)) return;
  pending.get(f.id)(f);
  pending.delete(f.id);
});
await new Promise((r) => socket.addEventListener("open", r, { once: true }));
const send = (m, p) => new Promise((res, rej) => {
  const i = nextId++;
  pending.set(i, (f) => (f.error ? rej(new Error(f.error.message)) : res(f)));
  socket.send(JSON.stringify({ id: i, method: m, params: p }));
});
const ev = async (x) => {
  const r = await send("Runtime.evaluate", { expression: x, returnByValue: true, awaitPromise: true });
  if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description?.slice(0, 200) ?? "page exception");
  return r.result.result.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const report = { schema: "muse-desktop.m4-02-annotations.v1", date: new Date().toISOString().slice(0, 10), platform: "Windows 11 (26200), dev webview (WebView2, CDP)", steps: {}, verdict: {} };

// clean slate for the annotations store
await ev(`(() => { localStorage.removeItem("muse-desktop.browser.annotations.v1"); return 1; })()`);

// open a conversation, then the browser panel
await ev(`(() => {
  const sessions = JSON.parse(localStorage.getItem("muse-desktop.sessions.v1") || "[]");
  const inWs = sessions.find((s) => (s.workspace || "").includes("openscreen"));
  const row = [...document.querySelectorAll("button.session-select")]
    .find((b) => (b.getAttribute("title") || "") === inWs.title);
  row?.click();
  return !!row;
})()`);
await sleep(5000);
await ev(`(() => {
  document.querySelector('button[aria-label="Show work panel"]')?.click();
})()`);
await sleep(600);
await ev(`(() => {
  const b = [...document.querySelectorAll("nav.work-tabs button")].find((x) => x.textContent.trim() === "Browser");
  b?.click();
})()`);
await sleep(1200);

// navigate to a page so the annotation anchor has a URL
await ev(`(() => {
  const area = document.querySelector('input[aria-label="Address"]');
  const P = HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(P, "value").set.call(area, "http://tauri.localhost/index.html");
  area.dispatchEvent(new Event("input", { bubbles: true }));
  const form = area?.closest("form");
  form?.requestSubmit();
})()`);
await sleep(2000);

// anchor a comment through the panel UI
await ev(`(() => {
  const input = document.querySelector('input[aria-label="Annotation comment"]');
  const P = HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(P, "value").set.call(input, "M4-02 anchored comment");
  input.dispatchEvent(new Event("input", { bubbles: true }));
})()`);
await sleep(400);
await ev(`(() => {
  const b = [...document.querySelectorAll('[aria-label="Page annotations"] button')]
    .find((x) => x.textContent.trim() === "Anchor");
  b?.click();
})()`);
await sleep(1000);
// verify: persistence + list rendering
const state = await ev(`(() => {
  const stored = JSON.parse(localStorage.getItem("muse-desktop.browser.annotations.v1") || "[]").filter(
    (a) => a.comment === "M4-02 anchored comment");
  const list = [...document.querySelectorAll(".browser-annotation-list li")]
    .filter((li) => li.textContent.includes("M4-02 anchored comment"));
  return {
    storedCount: stored.length,
    storedComment: stored[0]?.comment ?? null,
    listRendered: list.length,
  };
})()`);
report.steps.annotation = state;
report.verdict.annotationPersistedAndRendered =
  state.storedCount >= 1 && state.listRendered >= 1;

// insertion into the composer
await ev(`(() => {
  const b = [...document.querySelectorAll(".browser-annotation-list li button")]
    .find((x) => x.textContent.trim() === "To prompt");
  b?.click();
})()`);
await sleep(800);
const composer = await ev(`(() => {
  const t = document.querySelector('textarea[aria-label="Message Muse"]')?.value ?? "";
  return { has: t.includes("M4-02 anchored comment") && t.includes("tauri.localhost"), value: t.slice(0, 140) };
})()`);
report.steps.composerInsertion = composer;
report.verdict.annotationInsertsToPrompt = composer.has;

// removal
const beforeRemoval = await ev(`(() =>
  JSON.parse(localStorage.getItem("muse-desktop.browser.annotations.v1") || "[]")
    .filter((a) => a.comment === "M4-02 anchored comment").length)()`);
await ev(`(() => {
  const b = [...document.querySelectorAll(".browser-annotation-list li button")]
    .find((x) => x.getAttribute("aria-label")?.includes("Remove annotation"));
  b?.click();
})()`);
await sleep(800);
const afterRemoval = await ev(`(() => {
  const stored = JSON.parse(localStorage.getItem("muse-desktop.browser.annotations.v1") || "[]")
    .filter((a) => a.comment === "M4-02 anchored comment");
  const list = [...document.querySelectorAll(".browser-annotation-list li")]
    .filter((li) => li.textContent.includes("M4-02 anchored comment"));
  return { storedCount: stored.length, list: list.length };
})()`);
report.steps.removal = afterRemoval;
// two same-comment annotations existed; removing one must leave exactly one
report.verdict.annotationRemovable =
  beforeRemoval >= 2 && afterRemoval.storedCount === beforeRemoval - 1;

socket.close();
report.verdict.all =
  report.verdict.annotationPersistedAndRendered &&
  report.verdict.annotationInsertsToPrompt &&
  report.verdict.annotationRemovable;
const { writeFileSync: wf, mkdirSync } = await import("node:fs");
const { dirname } = await import("node:path");
mkdirSync("docs/evidence/2026-09-27-m4-closure", { recursive: true });
wf("docs/evidence/2026-09-27-m4-closure/m4-02-annotations.json", `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report.verdict), "|", JSON.stringify(state));
process.exit(0);
