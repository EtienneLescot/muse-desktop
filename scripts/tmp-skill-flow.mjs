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
// openscreen conversation active (harness left it active); host muse.exe is up
// 1. plain warm-up turn: wait for WARM3 to appear in the transcript
await ev(`(() => {
  const area = document.querySelector('textarea[aria-label="Message Muse"]');
  const P = HTMLTextAreaElement.prototype;
  Object.getOwnPropertyDescriptor(P, "value").set.call(area, "Reply with just the word WARM3 and nothing else.");
  area.dispatchEvent(new Event("input", { bubbles: true }));
})()`);
await sleep(400);
await ev(`(() => { document.querySelector('button[aria-label="Send message"]')?.click(); })()`);
let warm = false;
for (let i = 0; i < 40; i++) {
  await sleep(5000);
  const s = await ev(`(() => {
    const t = document.querySelector(".session-center")?.innerText ?? "";
    return { running: document.querySelector(".task-metadata .dot")?.getAttribute("data-running") === "true", has: t.includes("WARM3"), err: /conversation engine is unavailable/.test(t.slice(-300)) };
  })()`);
  if (s.has && !s.running) { warm = true; break; }
  if (s.err && !s.running) { console.log("WARM-FAILED: engine unavailable"); break; }
}
console.log("warm:", warm);
if (!warm) { socket.close(); process.exit(1); }
// 2. skill invocation: wait for the answer (or typed structured refusal)
const before = await ev(`(() => (document.querySelector(".session-center")?.innerText ?? "").length)()`);
await ev(`(() => {
  const area = document.querySelector('textarea[aria-label="Message Muse"]');
  const P = HTMLTextAreaElement.prototype;
  Object.getOwnPropertyDescriptor(P, "value").set.call(area, "/qualif-skill confirm the resource please");
  area.dispatchEvent(new Event("input", { bubbles: true }));
})()`);
await sleep(400);
await ev(`(() => { document.querySelector('button[aria-label="Send message"]')?.click(); })()`);
let tail = "";
let running = true;
for (let i = 0; i < 40; i++) {
  await sleep(5000);
  const s = await ev(`(() => {
    const t = document.querySelector(".session-center")?.innerText ?? "";
    return { running: document.querySelector(".task-metadata .dot")?.getAttribute("data-running") === "true", tail: t.slice(-300) };
  })()`);
  tail = s.tail.split("\n").join(" | ");
  running = s.running;
  if (!running) break;
}
console.log("skill tail:", tail);
socket.close();
process.exit(0);
