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
const send = (m, p) => new Promise((res, rej) => {
  const i = nextId++;
  pending.set(i, (f) => (f.error ? rej(new Error(f.error.message)) : res(f)));
  socket.send(JSON.stringify({ id: i, method: m, params: p }));
});
const ev = async (x) => {
  const r = await send("Runtime.evaluate", { expression: x, returnByValue: true, awaitPromise: true });
  if (r.result.exceptionDetails) throw new Error('PAGE: ' + (r.result.exceptionDetails.exception?.description || '').slice(0, 200));
  return r.result.result.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 1. direct resume_session via IPC for the story conversation
const resume = await ev(`(async () => {
  try {
    const r = await window.__TAURI_INTERNALS__.invoke("resume_session", {
      sessionId: "01a0da8f-15d5-7842-a5b4-c05b5c1f9801",
      workspacePath: "G:\\\\repos\\\\openscreen",
    });
    return { ok: true, loaded: r.loaded, model: r.model_id };
  } catch (e) {
    return { ok: false, error: String(e).slice(0, 200) };
  }
})()`);
console.log("resume:", JSON.stringify(resume));
// 2. if loaded, a direct send_input
if (resume.ok) {
  const parts = await ev(`(async () => {
    try {
      const r = await window.__TAURI_INTERNALS__.invoke("send_input", {
        sessionId: "01a0da8f-15d5-7842-a5b4-c05b5c1f9801",
        input: JSON.stringify([{ type: "text", text: "Reply with just the word DIRECT5 and nothing else." }]),
      });
      return { ok: true, r };
    } catch (e) {
      return { ok: false, error: String(e).slice(0, 200) };
    }
  })()`);
  console.log("send:", JSON.stringify(parts).slice(0, 200));
  await sleep(15000);
  const st = await ev(`(() => {
    const t = document.querySelector(".session-center")?.innerText ?? "";
    return { has: t.includes("DIRECT5"), running: document.querySelector(".task-metadata .dot")?.getAttribute("data-running") };
  })()`);
  console.log("state:", JSON.stringify(st));
}
socket.close();
process.exit(0);
