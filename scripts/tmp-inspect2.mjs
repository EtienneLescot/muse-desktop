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
  if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description?.slice(0, 160) ?? "page exception");
  return r.result.result.value;
};
const state = await ev(`(() => {
  const input = document.querySelector('label.composer-attach input[type=file]');
  return {
    h1: document.querySelector(".session-view h1")?.textContent?.slice(0, 40) ?? null,
    inputPresent: !!input,
    inputDisabled: input?.disabled ?? null,
    files: input?.files?.length ?? null,
    chips: document.querySelectorAll(".attachment-chips .attachment-chip").length,
    anyError: [...document.querySelectorAll("[role=alert], .attachment-error")].map((x) => x.textContent.trim().slice(0, 100)).filter(Boolean),
  };
})()`);
console.log(JSON.stringify(state, null, 1));
socket.close();
process.exit(0);
