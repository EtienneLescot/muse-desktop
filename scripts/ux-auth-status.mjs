#!/usr/bin/env node
/**
 * Verify the Muse authentication detection against the running app.
 *
 * Calls the native command directly and prints exactly what the renderer
 * receives, then asserts that nothing in that payload can be a credential. The
 * point is to check the real bridge rather than the unit-tested derivation.
 *
 * Usage: node scripts/ux-auth-status.mjs --port 9227
 */
import { exit } from "node:process";
const PORT = (() => { const i = process.argv.indexOf("--port"); return i >= 0 ? Number(process.argv[i + 1]) : 9227; })();

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === "page" && !String(t.url).startsWith("chrome-error"));
if (!page) { console.error(`pas de page sur ${PORT}`); process.exit(1); }
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

const payload = await ev(`(async () => {
  const bridge = window.__TAURI_INTERNALS__;
  if (!bridge || typeof bridge.invoke !== "function") return { error: "invoke indisponible" };
  try { return await bridge.invoke("muse_auth_status"); }
  catch (e) { return { error: String(e).slice(0, 200) }; }
})()`);

console.log("  payload recu du pont :");
console.log("    " + JSON.stringify(payload));

if (payload.error) {
  console.error(`\n  ECHEC : la commande native a repondu une erreur`);
  ws.close();
  process.exit(1);
}

const expected = ["mode", "source", "apiKeyOverridesLogin", "loginCommand"];
const keys = Object.keys(payload).sort();
console.log(`\n  champs : ${keys.join(", ")}`);
const shapeOk = JSON.stringify(keys) === JSON.stringify([...expected].sort());
console.log(`  forme conforme au garde-fou Rust : ${shapeOk ? "OUI" : "NON"}`);
console.log(`  mode effectif : ${payload.mode} (source: ${payload.source})`);
console.log(`  la cle API prime sur un login : ${payload.apiKeyOverridesLogin}`);

// Assert no value is long enough to be a credential.
const longest = Math.max(...Object.values(payload).map((v) => String(v).length));
console.log(`  valeur la plus longue : ${longest} caracteres (une cle en fait 48)`);
const noSecret = longest <= 32;
console.log(`  aucune valeur ne peut etre un secret : ${noSecret ? "OUI" : "NON"}`);

ws.close();
process.exit(shapeOk && noSecret ? 0 : 1);
