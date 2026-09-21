#!/usr/bin/env node
/**
 * Is `Run in Muse` enabled now that the app has settled?
 *
 * Also exercises the M1-06 acceptance path: with a command typed, pressing the
 * button must publish a `userShell` item whose output reaches the transcript.
 *
 * Usage:
 *   node scripts/ux-run-in-muse.mjs --port 9227            # report only
 *   node scripts/ux-run-in-muse.mjs --port 9227 --click    # type a command and click
 */
import { exit } from "node:process";
const PORT = (() => { const i = process.argv.indexOf("--port"); return i >= 0 ? Number(process.argv[i + 1]) : 9227; })();
const CLICK = process.argv.includes("--click");
const sleep = (ms) => new Promise((d) => setTimeout(d, ms));

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
const VIS = `const vis = (n) => { if (!n || !n.isConnected) return false; const c = getComputedStyle(n);
  if (c.display === "none" || c.visibility === "hidden") return false;
  if (c.display !== "contents" && n.getClientRects().length === 0) return false; return true; };`;

const STATE = `(() => { ${VIS}
  const b = document.querySelector(".terminal-muse");
  const input = document.querySelector(".terminal-input input");
  const h = document.querySelector("h1");
  return {
    session: h ? h.textContent.trim() : null,
    terminalPresent: Boolean(document.querySelector(".terminal-panel")),
    buttonPresent: Boolean(b),
    buttonVisible: b ? vis(b) : null,
    runDisabled: b ? b.disabled : null,
    runTitle: b ? b.getAttribute("title") : null,
    commandValue: input ? input.value : null,
  }; })()`;

/** Watch the transcript for a userShell item and its output. */
const SHELL_ITEMS = `(() => { ${VIS}
  const rows = [];
  for (const n of document.querySelectorAll(".msg, .log-entry, [class*=msg]")) {
    const text = (n.innerText || "").replace(/\\s+/g, " ").trim();
    if (/userShell|Shell|shell/i.test(text)) rows.push(text.slice(0, 120));
  }
  return rows.slice(0, 8); })()`;

console.log("--- etat initial ---");
const before = await ev(STATE);
console.log(JSON.stringify(before, null, 2));

if (!before.buttonPresent) {
  console.error("\nLe panneau Terminal n'est pas affiche. Ouvre l'onglet Terminal puis relance.");
  ws.close(); process.exit(1);
}

if (!CLICK) { ws.close(); process.exit(0); }

// Type a command through real key events so React state updates for sure.
await ev(`(() => { ${VIS} const i = document.querySelector(".terminal-input input"); if (i) i.focus(); return true; })()`);
for (const ch of "echo muse-m1-06-probe") {
  await cmd("Input.dispatchKeyEvent", { type: "keyDown", text: ch });
  await cmd("Input.dispatchKeyEvent", { type: "keyUp" });
  await sleep(25);
}
await sleep(600);
const typed = await ev(STATE);
console.log(`\n  apres saisie : disabled=${typed.runDisabled}  valeur="${typed.commandValue}"`);

if (typed.runDisabled === true) {
  console.error("\n  Run in Muse reste desactive malgre une commande saisie.");
  console.error(`  title = ${typed.runTitle}`);
  ws.close(); process.exit(2);
}

console.log("\n  clic sur Run in Muse...");
await ev(`(() => { const b = document.querySelector(".terminal-muse"); if (b) b.click(); return Boolean(b); })()`);

// Poll for the durable userShell item, with its output, in the transcript.
let found = [];
for (let i = 0; i < 30; i++) {
  await sleep(1000);
  found = await ev(SHELL_ITEMS);
  if (found.length > 0) { console.log(`  item userShell detecte apres ${i + 1}s`); break; }
}
console.log(`\n  elements de transcript contenant « shell » : ${found.length}`);
for (const f of found) console.log(`    ${f}`);
if (found.length === 0) {
  console.log("\n  AUCUN item userShell visible. C'est le constat bloquant de M1-06 :");
  console.log("  le bouton est actif mais rien n'atteint le transcript.");
}
ws.close();
