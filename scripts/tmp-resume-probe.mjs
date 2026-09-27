#!/usr/bin/env node
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
const state = await ev(`(() => {
  const header = document.querySelector(".session-view header") ?? document.querySelector(".task-heading");
  return {
    pill: document.querySelector(".connection-state")?.textContent ?? null,
    headerButtons: header ? [...header.querySelectorAll("button")].map((b) => b.textContent.trim() || b.getAttribute("aria-label")) : [],
    pendingSends: [...document.querySelectorAll("[role=alert], .pending-send")].map((x) => x.textContent.trim().slice(0, 60)),
    activeH1: document.querySelector(".session-view h1")?.textContent?.slice(0, 40) ?? null,
  };
})()`);
console.log(JSON.stringify(state, null, 1));
// try clicking Reconnect if present
const reconnected = await ev(`(() => {
  const b = [...document.querySelectorAll("button")].find((x) => /reconnect/i.test(x.textContent || x.getAttribute("aria-label") || ""));
  b?.click();
  return b ? b.textContent.trim() : "no reconnect button";
})()`);
console.log("reconnect:", reconnected);
await sleep(8000);
const after = await ev(`(() => ({
  pill: document.querySelector(".connection-state")?.textContent ?? null,
  notice: document.querySelector(".connection-notice")?.textContent?.slice(0, 100) ?? null,
}))()`);
console.log("after:", JSON.stringify(after));
socket.close();
process.exit(0);
