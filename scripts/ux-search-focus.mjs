#!/usr/bin/env node
/**
 * Re-check the two search entry points from a clean state, with focus made
 * explicit.
 *
 * The previous run reported that Escape did not close the find bar and that the
 * sidebar Search button did not open the dialog. Both are suspicious, and both
 * may be artefacts: the find input steals focus when it opens, so a key event
 * sent without refocusing lands somewhere else. Guessing which is which is not
 * acceptable, so this run prints the active element at each step.
 *
 * Usage: node scripts/ux-search-focus.mjs --port 9227
 */
import { exit } from "node:process";
const PORT = (() => { const i = process.argv.indexOf("--port"); return i >= 0 ? Number(process.argv[i + 1]) : 9227; })();
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

const STATE = `(() => {
  const a = document.activeElement;
  return {
    active: a ? (a.tagName + "." + String(a.getAttribute("class") || "").slice(0, 22)) : null,
    findOpen: Boolean(document.querySelector(".stream-find input")),
    dialogOpen: Boolean([...document.querySelectorAll("dialog")].find((d) => d.open)),
  };
})()`;

// 1. Clean slate: close whatever is open.
await ev(`(() => {
  const d = [...document.querySelectorAll("dialog")].find((x) => x.open);
  if (d) { const b = [...d.querySelectorAll("button")].find((n) => /close/i.test(n.getAttribute("aria-label") || "")); if (b) b.click(); }
  return true; })()`);
await sleep(600);
console.log(`  etat initial      : ${JSON.stringify(await ev(STATE))}`);

// 2. Ctrl+F opens the find bar, and the input should take focus.
await cmd("Input.dispatchKeyEvent", { type: "keyDown", key: "f", code: "KeyF", windowsVirtualKeyCode: 70, modifiers: 2 });
await cmd("Input.dispatchKeyEvent", { type: "keyUp", key: "f", code: "KeyF", windowsVirtualKeyCode: 70, modifiers: 2 });
await sleep(800);
console.log(`  apres Ctrl+F      : ${JSON.stringify(await ev(STATE))}`);

// 3. Escape must close it — sent while the input owns focus, which is the real
//    user situation.
await cmd("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
await cmd("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
await sleep(800);
const afterEscape = await ev(STATE);
console.log(`  apres Echap       : ${JSON.stringify(afterEscape)}`);

// 4. If Escape was not enough, close by the button and report which worked.
if (afterEscape.findOpen) {
  const closed = await ev(`(() => {
    const b = [...document.querySelectorAll(".stream-find button")].find((n) => /^Close$/.test((n.innerText || "").trim()));
    if (b) b.click();
    return Boolean(b); })()`);
  await sleep(600);
  console.log(`  fermeture par bouton : ${closed} -> ${JSON.stringify(await ev(STATE))}`);
}

// 5. The sidebar Search button opens the global dialog.
const clicked = await ev(`(() => {
  const b = [...document.querySelectorAll("button")].find((n) => (n.getAttribute("aria-label") || "") === "Search");
  if (b) b.click();
  return Boolean(b); })()`);
await sleep(900);
const afterSearch = await ev(STATE);
console.log(`  clic Search       : ${clicked} -> ${JSON.stringify(afterSearch)}`);
console.log(`  dialogue global ouvert : ${afterSearch.dialogOpen ? "OUI" : "NON"}`);

// 6. Ctrl+K must still open it too.
await ev(`(() => {
  const d = [...document.querySelectorAll("dialog")].find((x) => x.open);
  if (d) { const b = [...d.querySelectorAll("button")].find((n) => /close/i.test(n.getAttribute("aria-label") || "")); if (b) b.click(); }
  return true; })()`);
await sleep(500);
await cmd("Input.dispatchKeyEvent", { type: "keyDown", key: "k", code: "KeyK", windowsVirtualKeyCode: 75, modifiers: 2 });
await cmd("Input.dispatchKeyEvent", { type: "keyUp", key: "k", code: "KeyK", windowsVirtualKeyCode: 75, modifiers: 2 });
await sleep(800);
const afterK = await ev(STATE);
console.log(`  apres Ctrl+K      : ${JSON.stringify(afterK)}`);
console.log(`  raccourci global fonctionne : ${afterK.dialogOpen ? "OUI" : "NON"}`);

// Leave as found.
await ev(`(() => {
  const d = [...document.querySelectorAll("dialog")].find((x) => x.open);
  if (d) { const b = [...d.querySelectorAll("button")].find((n) => /close/i.test(n.getAttribute("aria-label") || "")); if (b) b.click(); }
  return true; })()`);
ws.close();
