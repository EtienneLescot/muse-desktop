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
const state = await ev(`(() => {
  const runs = JSON.parse(localStorage.getItem("muse-desktop.schedule-runs.v1") || "[]");
  const last = runs.slice(-2).map((r) => ({ name: r.scheduleName.slice(0, 26), status: r.status, err: (r.error || "").slice(0, 80), ws: r.workspace, reuse: r.threadReuse }));
  const schedules = JSON.parse(localStorage.getItem("muse-desktop.schedules.v1") || "[]").slice(-2).map((s) => ({ name: s.name.slice(0, 26), enabled: s.enabled, lastFiredAt: s.lastFiredAt ?? null }));
  const page = document.body.innerText || "";
  return {
    last,
    schedules,
    automationsPage: /Automations/.test(page),
    unsent: page.match(/\\d+ unsent/)?.[0] ?? null,
    error: document.querySelector(".window-error, [role=alert]")?.textContent?.slice(0, 110) ?? null,
  };
})()`);
console.log(JSON.stringify(state, null, 1));
socket.close();
process.exit(0);
