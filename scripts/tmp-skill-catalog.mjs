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
// what does the host catalogue say (the SkillPanel shows "Host skills")?
const panel = await ev(`(() => {
  const b = document.querySelector('button[aria-label="Extensions"]') ??
    [...document.querySelectorAll("button")].find((x) => x.textContent.trim() === "Extensions");
  b?.click();
  return !!b;
})()`);
await new Promise((r) => setTimeout(r, 2000));
const state = await ev(`(() => {
  const text = document.querySelector('[aria-label="Skills"]')?.innerText ?? "NO PANEL";
  const hostSection = text.match(/Host skills[\\s\\S]{0,300}/)?.[0] ?? "no host section";
  const discovered = text.match(/\\d+ discovered/)?.[0] ?? null;
  const hasQualif = /qualif-skill/.test(text);
  return { discovered, hasQualif, hostSection: hostSection.replace(/\\n+/g, " | ").slice(0, 260) };
})()`);
console.log(JSON.stringify(state, null, 1));
socket.close();
process.exit(0);
