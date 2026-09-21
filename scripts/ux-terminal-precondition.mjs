#!/usr/bin/env node
/**
 * Verify the terminal's stated precondition is honest.
 *
 * `session/userShell` only answers for a conversation the host has loaded, so
 * the panel disables "Run in Muse" while `loaded` is false. That is the right
 * behaviour - but the flag used to be a boot-time snapshot nothing ever
 * refreshed, so a persisted conversation stayed "not loaded" in the renderer
 * even after the host had loaded it. The action was then refused with "send a
 * message in this conversation first" on conversations that were already
 * loaded, and the message did not clear it.
 *
 * This walks the sidebar, types a command in each conversation, and asserts
 * that the reason for a disabled Run in Muse is never the loading precondition.
 * The command matters: `disabled` combines four conditions, so reading it on an
 * empty field proves nothing.
 *
 * Read-only: no turn is sent, nothing is resumed by this script.
 *
 * Usage: node scripts/ux-terminal-precondition.mjs [--port 9227] [--max 6]
 */
const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const PORT = Number(arg("--port", "9227"));
const MAX = Number(arg("--max", "6"));
const sleep = (ms) => new Promise((d) => setTimeout(d, ms));

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === "page" && !String(t.url).startsWith("chrome-error"));
if (!page) {
  console.error("pas de page");
  process.exit(1);
}
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let id = 1;
const pending = new Map();
ws.addEventListener("message", (e) => {
  const f = JSON.parse(typeof e.data === "string" ? e.data : "");
  if (f.id === undefined) return;
  const p = pending.get(f.id);
  if (p) {
    pending.delete(f.id);
    p(f);
  }
});
const cmd = (m, p) =>
  new Promise((res) => {
    const i = id++;
    pending.set(i, res);
    ws.send(JSON.stringify({ id: i, method: m, params: p }));
  });
async function ev(expression) {
  const r = await cmd("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || "exception");
  return r.result?.result?.value;
}

const VIS = `const vis = (n) => { if (!n || !n.isConnected) return false; const c = getComputedStyle(n);
  if (c.display === "none" || c.visibility === "hidden") return false;
  if (c.display !== "contents" && n.getClientRects().length === 0) return false; return true; };`;

const PROBE = `(() => { ${VIS}
  const muse = document.querySelector(".terminal-muse");
  const input = document.querySelector('input[aria-label="Terminal command"]');
  return {
    conversationOpen: document.querySelectorAll(".msg").length > 0,
    terminalOpen: Boolean(document.querySelector(".terminal-panel")),
    runDisabled: muse ? muse.disabled : null,
    runTitle: muse ? muse.getAttribute("title") : null,
    typed: input ? input.value : null,
  }; })()`;

// Open the Terminal tab once; it stays selected across conversations.
await ev(`(() => { ${VIS}
  const tab = [...document.querySelectorAll("button, [role=tab]")].filter(vis)
    .find((b) => (b.innerText || "").trim() === "Terminal");
  if (tab) { tab.click(); return "onglet"; }
  const show = [...document.querySelectorAll("button")].filter(vis)
    .find((b) => (b.getAttribute("aria-label") || "") === "Show work panel");
  if (show) show.click();
  return "panneau"; })()`);
await sleep(1500);
await ev(`(() => { ${VIS}
  const tab = [...document.querySelectorAll("button, [role=tab]")].filter(vis)
    .find((b) => (b.innerText || "").trim() === "Terminal");
  if (tab) tab.click();
  return Boolean(tab); })()`);
await sleep(1000);

const titles = await ev(`(() => { ${VIS}
  return [...document.querySelectorAll(".session-item .session-select")]
    .filter(vis).map((b) => (b.innerText || "").replace(/\\s+/g, " ").trim().slice(0, 40)); })()`);
const targets = titles.slice(0, MAX);
console.log(`conversations inspectees : ${targets.length}`);

let failures = 0;
const rows = [];
for (const title of targets) {
  await ev(`(() => { ${VIS}
    const target = [...document.querySelectorAll(".session-item .session-select")].filter(vis)
      .find((b) => (b.innerText || "").replace(/\\s+/g, " ").trim().slice(0, 40) === ${JSON.stringify(title)});
    if (target) target.click();
    return Boolean(target); })()`);
  await sleep(2500);
  await ev(`(() => { ${VIS}
    const input = document.querySelector('input[aria-label="Terminal command"]');
    if (!input) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    setter.call(input, "echo muse-precondition-probe");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    return true; })()`);
  await sleep(500);
  const state = await ev(PROBE);
  // A conversation with no messages renders no work panel at all, so it has no
  // terminal and nothing to decide. Count it as skipped rather than as a pass.
  const skipped = !state.conversationOpen || !state.terminalOpen;
  const blamedOnLoading =
    state.runDisabled === true && /not loaded|send a message|Load conversation/i.test(state.runTitle ?? "");
  const usable = !skipped && state.typed === "echo muse-precondition-probe";
  rows.push({ title, skipped, usable, runDisabled: state.runDisabled, runTitle: state.runTitle, blamedOnLoading });
  if (!skipped && !usable) failures += 1;
  if (blamedOnLoading) failures += 1;
}

const inspected = rows.filter((row) => !row.skipped);
console.log("");
for (const row of rows) {
  const verdict = row.skipped ? "ignoree" : row.blamedOnLoading ? "REFUS" : row.usable ? "ok" : "PRECONDITION";
  console.log(`  ${verdict.padEnd(12)} ${row.title.padEnd(42)} disabled=${String(row.runDisabled).padEnd(5)} ${row.runTitle ?? ""}`);
}

console.log("\nverifications");
console.log(`  ${inspected.length > 0 ? "ok  " : "FAIL"} au moins une conversation avec panneau Terminal (${inspected.length} sur ${rows.length})`);
console.log(`  ${failures === 0 ? "ok  " : "FAIL"} aucune d'elles n'est refusee pour cause de chargement`);
ws.close();
console.log(failures === 0 ? "\nPASS" : `\n${failures} conversation(s) refusee(s) a tort`);
process.exit(failures === 0 ? 0 : 1);
