#!/usr/bin/env node
/**
 * Open the work panel on the Terminal tab and report the state of the two
 * send actions, including the reason the `Run in Muse` action is unavailable.
 *
 * The reason matters more than the boolean: `disabled` combines the capability,
 * the host's session-loaded state and the typed command, so reading it alone has
 * already produced one wrong diagnosis. The tooltip is the discriminator.
 *
 * Usage: node scripts/ux-terminal-state.mjs --port 9227 [--type <command>]
 */
import { exit } from "node:process";
const PORT = (() => { const i = process.argv.indexOf("--port"); return i >= 0 ? Number(process.argv[i + 1]) : 9227; })();
const TYPE = (() => { const i = process.argv.indexOf("--type"); return i >= 0 ? process.argv[i + 1] : null; })();
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

async function waitFor(label, predicate, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await ev(predicate)) === true) { console.log(`  precondition OK   : ${label}`); return true; }
    await sleep(600);
  }
  console.error(`  PRECONDITION ECHOUEE : ${label}`);
  return false;
}

const conv = await waitFor("conversation affichee",
  `(() => { ${VIS} return Boolean(document.querySelector(".composer, .composer-card")) && Boolean(document.querySelector("h1")); })()`);
if (!conv) { console.error("Ouvre une conversation."); ws.close(); process.exit(1); }

await waitFor("panneau de travail deplie",
  `(() => { ${VIS}
    if (document.querySelector(".work-panel-body")) return true;
    const b = [...document.querySelectorAll("button")].find((n) => (n.getAttribute("aria-label")||"") === "Show work panel");
    if (b) { b.click(); return false; }
    return false; })()`, 25_000);

const clicked = await ev(`(() => { ${VIS}
  const b = [...document.querySelectorAll("button, [role=tab]")].filter(vis).find((n) => (n.innerText || "").trim() === "Terminal");
  if (b) b.click();
  return Boolean(b); })()`);
if (!clicked) { console.error("Onglet Terminal introuvable."); ws.close(); process.exit(1); }
await sleep(2000);
await waitFor("onglet Terminal rendu", `(() => { ${VIS} return Boolean(document.querySelector(".terminal-panel")); })()`);

const REPORT = `(() => { ${VIS}
  const run = document.querySelector(".terminal-muse");
  const send = document.querySelector(".terminal-input button[type=submit]");
  const input = document.querySelector(".terminal-input input");
  const h = document.querySelector("h1");

  // Read the props the component actually received. The tooltip and the DOM
  // disagree often enough in this app that the prop is the only tie-breaker.
  let props = null;
  if (run) {
    const key = Object.keys(run).find((k) => k.startsWith("__reactFiber$"));
    let fiber = key ? run[key] : null;
    for (let n = fiber, i = 0; n && i < 30; n = n.return, i++) {
      const t = n.type;
      const name = typeof t === "function" ? (t.displayName || t.name) : null;
      if (name === "TerminalPanel") {
        const p = n.memoizedProps || {};
        props = { canRunThroughMuse: p.canRunThroughMuse, sessionLoaded: p.sessionLoaded, sessionId: p.sessionId };
        break;
      }
    }
  }

  return {
    session: h ? h.textContent.trim() : null,
    command: input ? input.value : null,
    runDisabled: run ? run.disabled : null,
    runTitle: run ? run.getAttribute("title") : null,
    sendDisabled: send ? send.disabled : null,
    props,
  }; })()`;

if (TYPE) {
  await ev(`(() => { ${VIS} const i = document.querySelector(".terminal-input input"); if (i) i.focus(); return true; })()`);
  for (const ch of TYPE) {
    await cmd("Input.dispatchKeyEvent", { type: "keyDown", text: ch });
    await cmd("Input.dispatchKeyEvent", { type: "keyUp" });
    await sleep(20);
  }
  await sleep(700);
}

const state = await ev(REPORT);
console.log("");
console.log(`  session    : ${state.session}`);
console.log(`  commande   : ${JSON.stringify(state.command)}`);
console.log(`  Run in Muse: disabled=${state.runDisabled}`);
console.log(`  raison     : ${state.runTitle}`);
console.log(`  Send       : disabled=${state.sendDisabled}`);
console.log(`  props      : ${JSON.stringify(state.props)}`);
ws.close();
