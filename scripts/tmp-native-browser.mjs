#!/usr/bin/env node
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
// go to Browser tab, navigate, click Open in a browser window (⧉)
await ev(`(() => {
  document.querySelector('button[aria-label="Show work panel"]')?.click();
})()`);
await sleep(600);
await ev(`(() => {
  const b = [...document.querySelectorAll("nav.work-tabs button")].find((x) => x.textContent.trim() === "Browser");
  b?.click();
})()`);
await sleep(1200);
await ev(`(() => {
  const area = document.querySelector('input[aria-label="Address"]');
  const P = HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(P, "value").set.call(area, "http://tauri.localhost/index.html");
  area.dispatchEvent(new Event("input", { bubbles: true }));
  const form = area?.closest("form");
  form?.requestSubmit();
})()`);
await sleep(2000);
const click = await ev(`(() => {
  const btn = [...document.querySelectorAll("button")].find((x) => x.getAttribute("aria-label") === "Open in a browser window");
  if (!btn) return { found: false };
  if (btn.disabled) return { found: true, disabled: true };
  btn.click();
  return { found: true, clicked: true };
})()`);
console.log("click:", JSON.stringify(click));
await sleep(4000);
const targets = await (await fetch("http://127.0.0.1:9222/json/list")).json();
console.log("targets:", targets.filter((t) => t.type === "page").map((t) => t.url.slice(0, 60)));
socket.close();
process.exit(0);
