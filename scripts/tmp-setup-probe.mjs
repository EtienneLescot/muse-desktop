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
// open settings (may already be open from the crashed harness)
await ev(`(() => { document.querySelector('button[aria-label="Settings"]')?.click(); return 1; })()`);
await sleep(1200);
const set = await ev(`(() => {
  const area = document.querySelector('textarea[aria-label="Worktree setup command"]');
  const P = HTMLTextAreaElement.prototype;
  Object.getOwnPropertyDescriptor(P, "value").set.call(area, "echo M2-04-SETUP-PROOF > setup-proof.txt");
  area.dispatchEvent(new Event("input", { bubbles: true }));
  const run = [...document.querySelectorAll("button")].find((x) => x.textContent.trim() === "Run setup");
  return { area: !!area, runDisabled: run?.disabled ?? null };
})()`);
console.log("set:", JSON.stringify(set));
await ev(`(() => { [...document.querySelectorAll("button")].find((x) => x.textContent.trim() === "Run setup")?.click(); return 1; })()`);
await sleep(6000);
const state = await ev(`(() => ({
  group: document.querySelector('[aria-label="Worktree tools"]')?.innerText?.slice(0, 500) ?? null,
}))()`);
console.log(JSON.stringify(state, null, 1));
socket.close();
process.exit(0);
