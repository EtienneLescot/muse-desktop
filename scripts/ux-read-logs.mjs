#!/usr/bin/env node
/**
 * Read the app's own transcript state for the active session, from the hook that
 * holds it (the `logs` record on App's fiber).
 *
 * The DOM is a projection: a missing node can mean "nothing was produced" or
 * "the selector is wrong". The hook state is the authority on what the client
 * actually recorded, so a negative finding must be confirmed here before it is
 * reported as a defect — eight false diagnoses in this campaign came from
 * treating a DOM absence as a product absence.
 *
 * Usage: node scripts/ux-read-logs.mjs --port 9227 [--session <prefix>]
 */
import { exit } from "node:process";
const PORT = (() => { const i = process.argv.indexOf("--port"); return i >= 0 ? Number(process.argv[i + 1]) : 9227; })();
const ONLY = (() => { const i = process.argv.indexOf("--session"); return i >= 0 ? process.argv[i + 1] : null; })();

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
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || "exception");
  return r.result?.result?.value;
}

/**
 * Find the hook whose state is a session-id-keyed record of entry arrays: that
 * is `logs`. Entries are trimmed to the fields that matter here so the output
 * stays readable.
 */
const out = await ev(`(() => {
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}/i;
  const anchor = document.querySelector(".work-panel") || document.body;
  const key = Object.keys(anchor).find((k) => k.startsWith("__reactFiber$"));
  if (!key) return { error: "pas de cle fiber" };
  let fiber = anchor[key];
  for (let n = fiber; n; n = n.return) {
    let h = n.memoizedState, index = 0;
    while (h && index < 120) {
      const s = h.memoizedState;
      if (s && typeof s === "object" && !Array.isArray(s)) {
        const keys = Object.keys(s);
        const arrays = keys.filter((k) => Array.isArray(s[k]));
        if (UUID.test(keys[0] || "") && arrays.length === keys.length && keys.length > 0) {
          const entries = [...new Set(arrays.flatMap((k) => s[k].map((e) => e && e.role)))];
          // The logs map holds objects with role/text; other session maps hold
          // empty arrays and would not show any role.
          if (entries.length > 0) {
            const summary = {};
            for (const k of keys) {
              summary[k.slice(0, 13)] = s[k].map((e) => ({
                role: e && e.role,
                text: e && typeof e.text === "string" ? e.text.slice(0, 60) : null,
                itemId: e && e.itemId ? String(e.itemId).slice(0, 13) : null,
                turnId: e && e.turnId ? String(e.turnId).slice(0, 13) : null,
                open: e && e.open === true,
              }));
            }
            return { hookIndex: index, sessions: summary };
          }
        }
      }
      h = h.next; index++;
    }
  }
  return { error: "hook logs introuvable" };
})()`);

if (out.error) { console.error(out.error); ws.close(); process.exit(1); }
console.log(`hook #${out.hookIndex}\n`);
for (const [session, entries] of Object.entries(out.sessions)) {
  if (ONLY && !session.startsWith(ONLY)) continue;
  console.log(`=== ${session} — ${entries.length} entree(s) ===`);
  for (const e of entries) {
    console.log(`  ${String(e.role).padEnd(10)} ${String(e.text || "").replace(/\n/g, " ").padEnd(62)} item=${e.itemId || "-"} turn=${e.turnId || "-"}${e.open ? "  [open]" : ""}`);
  }
}
ws.close();
