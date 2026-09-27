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
// click the openscreen conversation row and watch the connection pill
await ev(`(() => {
  const sessions = JSON.parse(localStorage.getItem("muse-desktop.sessions.v1") || "[]");
  const inWs = sessions.find((s) => (s.workspace || "").includes("openscreen"));
  const row = [...document.querySelectorAll("button.session-select")]
    .find((b) => (b.getAttribute("title") || "") === inWs.title);
  row?.click();
  return inWs.title.slice(0, 30);
})()`);
for (let i = 0; i < 10; i++) {
  await sleep(3000);
  const st = await ev(`(() => ({
    connection: document.querySelector(".connection-state")?.textContent ?? null,
    notice: document.querySelector(".connection-notice")?.textContent?.slice(0, 100) ?? null,
    dot: document.querySelector(".task-metadata .dot")?.getAttribute("data-running") ?? null,
  }))()`);
  console.log(`t+${(i + 1) * 3}s:`, JSON.stringify(st));
  if (st.connection === "Connected") break;
}
socket.close();
process.exit(0);
