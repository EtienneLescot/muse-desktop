#!/usr/bin/env node
/** M4-01 follow-up: in-tab history — two navigations in the SAME tab, then Back. */
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
const ev = async (x) => {
  const i = nextId++;
  const p = new Promise((res, rej) => pending.set(i, (f) => (f.error ? rej(new Error(f.error.message)) : res(f.result.result.value))));
  socket.send(JSON.stringify({ id: i, method: "Runtime.evaluate", params: { expression: x, returnByValue: true, awaitPromise: true } }));
  return p;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const navigate = (url) => ev(`(() => {
  const set = (v) => {
    const el = document.querySelector('input[aria-label="Address"]');
    const P = HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(P, "value").set.call(el, v);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  };
  set(${JSON.stringify(url)});
  const form = document.querySelector('input[aria-label="Address"]')?.closest("form");
  form?.requestSubmit();
  return "ok";
})()`);
// ensure we're on tab 1 (the original) — click the first tab
await ev(`(() => {
  const tab = [...document.querySelectorAll('[aria-label="Browser tabs"] [role=tab]')][0];
  tab?.click();
})()`);
await sleep(1000);
await navigate("http://tauri.localhost/index.html");
await sleep(1500);
await navigate("http://tauri.localhost/index.html?v=second");
await sleep(1500);
const before = await ev(`(() => document.querySelector('[aria-label="In-app browser"] iframe')?.src ?? null)()`);
await ev(`(() => { document.querySelector('button[aria-label="Back"]')?.click(); })()`);
await sleep(1500);
const after = await ev(`(() => document.querySelector('[aria-label="In-app browser"] iframe')?.src ?? null)()`);
console.log(JSON.stringify({ before, after, backWorked: after === "http://tauri.localhost/index.html" }));
process.exit(0);
