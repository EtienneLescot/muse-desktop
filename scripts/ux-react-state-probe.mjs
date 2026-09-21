#!/usr/bin/env node
// Read the React hook state that feeds the capability check.
import { exit } from "node:process";
const PORT = (() => { const i = process.argv.indexOf("--port"); return i >= 0 ? Number(process.argv[i + 1]) : 9227; })();
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === "page" && !String(t.url).startsWith("chrome-error"));
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let id = 1; const pending = new Map();
ws.addEventListener("message", (e) => {
  const f = JSON.parse(typeof e.data === "string" ? e.data : "");
  if (f.id === undefined) return;
  const p = pending.get(f.id); if (p) { pending.delete(f.id); p(f); }
});
const cmd = (m, p) => new Promise((res) => { const i = id++; pending.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
async function ev(expression) {
  const r = await cmd("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) return { THREW: r.result.exceptionDetails.exception?.description };
  return r.result?.result?.value;
}

const out = await ev(`(() => {
  const btn = document.querySelector(".terminal-muse");
  if (!btn) return { error: "bouton absent" };
  const key = Object.keys(btn).find((k) => k.startsWith("__reactFiber$") || k.startsWith("__reactProps$"));
  if (!key) return { error: "pas de cle React sur le bouton" };
  const props = btn[key];
  // props on the fiber key carries the React props for this host element.
  const walk = [];
  let fiber = key.startsWith("__reactFiber$") ? btn[key] : null;
  if (!fiber && key.startsWith("__reactProps$")) {
    return { propsKey: key, props: Object.keys(props || {}).slice(0, 20) };
  }
  let node = fiber;
  for (let i = 0; node && i < 40; i++) {
    const t = node.type;
    const name = typeof t === "function" ? (t.displayName || t.name) : (typeof t === "string" ? t : null);
    if (name) walk.push(name);
    if (name === "TerminalPanel") {
      const p = node.memoizedProps || {};
      return {
        propsKey: key,
        walk: walk.slice(0, 10),
        canRunThroughMuse: p.canRunThroughMuse,
        propKeys: Object.keys(p).slice(0, 24),
        sessionId: p.sessionId ?? null,
        commandProp: p.command ?? "(pas de prop command)",
      };
    }
    node = node.return;
  }
  return { propsKey: key, walk: walk.slice(0, 14) };
})()`);
console.log(JSON.stringify(out, null, 2));
ws.close();
