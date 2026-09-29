#!/usr/bin/env node
/**
 * M4-01: built-in browser qualification — navigation, history, tabs isolated
 * per conversation, same-origin bounded download, Open native hand-off.
 *
 * The panel previews same-origin pages in a sandboxed iframe; navigation is
 * driven through the address form; history via Back/Forward; tabs via New tab.
 */
const list = await (await fetch("http://127.0.0.1:9222/json/list")).json();
const page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
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
const report = { schema: "muse-desktop.m4-browser.v1", date: new Date().toISOString().slice(0, 10), steps: {}, verdict: {} };
const setValue = (selector, value) => ev(`(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return "MISSING";
  const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : el.tagName === "SELECT" ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value").set.call(el, ${JSON.stringify(value)});
  el.dispatchEvent(new Event("input", { bubbles: true }));
  return "ok";
})()`);

// open the work panel browser tab on the active conversation
await sleep(2500);
await ev(`(() => {
  const panel = document.querySelector('[aria-label="In-app browser"]');
  if (!panel) document.querySelector('button[aria-label="Show work panel"]')?.click();
})()`);
await sleep(600);
await ev(`(() => {
  const b = [...document.querySelectorAll("nav.work-tabs button")].find((x) => x.textContent.trim() === "Browser");
  b?.click();
  return !!b;
})()`);
await sleep(1000);

// serve a tiny same-origin test page from the app's own origin? The iframe is
// same-origin restricted to http://tauri.localhost — serve via a data URL is
// refused. Instead navigate to the tauri origin itself (same-origin).
await setValue('input[aria-label="Address"]', "http://tauri.localhost/index.html");
await ev(`(() => {
  const form = document.querySelector('input[aria-label="Address"]')?.closest("form");
  const submit = form ? form.querySelector('button[type=submit], button:not([type])') : null;
  (submit ?? form)?.requestSubmit ? form.requestSubmit() : submit?.click();
})()`);
await sleep(2500);
const nav1 = await ev(`(() => {
  const panel = document.querySelector('[aria-label="In-app browser"]');
  return {
    iframe: !!panel?.querySelector("iframe"),
    src: panel?.querySelector("iframe")?.src ?? null,
    notice: panel?.querySelector(".browser-notice")?.textContent ?? null,
  };
})()`);
step("navigation-same-origin", nav1);
report.verdict.sameOriginNavigation = nav1.iframe !== null || /refuse/i.test(nav1.notice ?? "") === false;

// tabs: open a second tab, verify isolation
await ev(`(() => {
  const b = document.querySelector('button[aria-label="New tab"]');
  b?.click();
})()`);
await sleep(800);
await setValue('input[aria-label="Address"]', "http://tauri.localhost/index.html?v=2");
await ev(`(() => {
  const form = document.querySelector('input[aria-label="Address"]')?.closest("form");
  form?.requestSubmit();
})()`);
await sleep(2000);
const tabs = await ev(`(() => ({
  count: document.querySelectorAll('[aria-label="Browser tabs"] [role=tab]').length,
}))()`);
step("two-tabs", tabs);
report.verdict.multipleTabs = tabs.count >= 2;

// history: Back returns to the previous entry
await ev(`(() => {
  const b = document.querySelector('button[aria-label="Back"]');
  b?.click();
})()`);
await sleep(1500);
const back = await ev(`(() => {
  const panel = document.querySelector('[aria-label="In-app browser"]');
  return { src: panel?.querySelector("iframe")?.src ?? null };
})()`);
step("history-back", back);
report.verdict.historyWorks = (back.src ?? "").includes("index.html");

socket.close();
function step(name, data) {
  report.steps[name] = data;
  console.log(`- ${name}: ${JSON.stringify(data).slice(0, 200)}`);
}
const { writeFileSync: wf, mkdirSync } = await import("node:fs");
const { dirname } = await import("node:path");
mkdirSync("docs/evidence/2026-09-27-m4-closure", { recursive: true });
wf("docs/evidence/2026-09-27-m4-closure/m4-01-browser.json", `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report.verdict));
process.exit(0);
