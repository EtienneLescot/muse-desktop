#!/usr/bin/env node
/**
 * Read what the Rust bridge actually returns for restored sessions, straight
 * from the running app. This is the authoritative check for the `model_id`
 * projection: it inspects the invoke() result, not the rendered label, so a
 * renderer-side fallback cannot mask a missing host field.
 *
 * Usage: node scripts/ux-session-meta-probe.mjs --port 9227
 */
import { exit } from "node:process";
const PORT = (() => { const i = process.argv.indexOf("--port"); return i >= 0 ? Number(process.argv[i + 1]) : 9227; })();
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === "page" && !String(t.url).startsWith("chrome-error"));
if (!page) { console.error("pas de page"); process.exit(1); }
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

/**
 * The renderer exposes Tauri's invoke as `window.__TAURI_INTERNALS__.invoke`.
 * Only read-only commands are called here: nothing is started, sent or changed.
 */
const out = await ev(`(async () => {
  const bridge = window.__TAURI_INTERNALS__;
  if (!bridge || typeof bridge.invoke !== "function") return { error: "invoke indisponible" };
  const projects = Object.keys(localStorage).filter((k) => /project|workspace/i.test(k));
  const result = { projectKeys: projects, keys: Object.keys(localStorage).length };
  try {
    // Native commands that only read state.
    result.known = typeof bridge.invoke;
    const sessions = await bridge.invoke("restore_sessions").catch((e) => ({ error: String(e) }));
    result.restoreSessions = sessions;
  } catch (e) { result.restoreError = String(e); }
  return result;
})()`);

console.log(JSON.stringify(out, null, 2));
ws.close();
