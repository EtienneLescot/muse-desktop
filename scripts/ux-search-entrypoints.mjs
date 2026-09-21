#!/usr/bin/env node
/**
 * Verify the two search entry points are now distinct and the transcript is free
 * of a permanent bar.
 *
 *   1. no find bar in the transcript when nothing has been asked for;
 *   2. Ctrl/Cmd+F opens it, and it can be closed;
 *   3. the header icon opens the global "Search conversations" dialog.
 *
 * A claim of "no longer takes space" has to be measured, not asserted.
 *
 * Usage: node scripts/ux-search-entrypoints.mjs --port 9227
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
const VIS = `const vis = (n) => { if (!n || !n.isConnected) return false; const c = getComputedStyle(n);
  if (c.display === "none" || c.visibility === "hidden") return false;
  if (c.display !== "contents" && n.getClientRects().length === 0) return false; return true; };`;

const SNAPSHOT = `(() => { ${VIS}
  const stream = document.querySelector(".stream");
  const dock = document.querySelector(".stream-find-dock");
  const findInput = document.querySelector(".stream-find input");
  const dialog = [...document.querySelectorAll("dialog")].find((d) => d.open);
  const searchBtn = [...document.querySelectorAll("header button, .icon")].filter(vis)
    .find((b) => /search all conversations/i.test(b.getAttribute("aria-label") || ""));
  return {
    transcriptHeight: stream ? Math.round(stream.getBoundingClientRect().height) : null,
    transcriptScrollHeight: stream ? stream.scrollHeight : null,
    dockPresent: Boolean(dock),
    findInputPresent: Boolean(findInput),
    globalDialogOpen: Boolean(dialog),
    globalDialogTitle: dialog ? (dialog.querySelector("h2")?.innerText || "").trim() : null,
    headerSearchIcon: Boolean(searchBtn),
  }; })()`;

// A conversation with history must be open: `.stream` and the Ctrl+F listener
// only exist inside a rendered transcript.
const opened = await ev(`(() => { ${VIS}
  if (document.querySelector(".stream")) return { already: true };
  const rows = [...document.querySelectorAll("button, [role=button], li")].filter(vis).filter((n) => {
    const r = n.getBoundingClientRect();
    const label = (n.innerText || "").trim();
    return r.left < window.innerWidth * 0.35 && r.height > 14 && r.height < 60 && label.length > 8
      && !/New conversation|Search|Automations|Extensions|Library|Manage|Archived|profile/i.test(label);
  });
  const target = rows.find((n) => /Reply with exactly|Explain the proj/i.test(n.innerText || "")) ?? rows[0];
  if (!target) return { opened: false };
  const sib = target.querySelector(".session-select");
  (sib || target).click();
  return { opened: true, label: (target.innerText || "").trim().slice(0, 40) };
})()`);
console.log(`  conversation : ${JSON.stringify(opened)}`);
await sleep(3000);

console.log("\n  1. au repos (rien demande)");
console.log("     " + JSON.stringify(await ev(SNAPSHOT)));

// Ctrl+F through the real key path, not by calling the setter.
await cmd("Input.dispatchKeyEvent", { type: "keyDown", key: "f", code: "KeyF", windowsVirtualKeyCode: 70, modifiers: 2 });
await cmd("Input.dispatchKeyEvent", { type: "keyUp", key: "f", code: "KeyF", windowsVirtualKeyCode: 70, modifiers: 2 });
await sleep(800);
console.log("\n  2. apres Ctrl+F");
console.log("     " + JSON.stringify(await ev(SNAPSHOT)));

// Close it with Escape.
await cmd("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
await cmd("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
await sleep(700);
console.log("\n  3. apres Echap");
console.log("     " + JSON.stringify(await ev(SNAPSHOT)));

// The header icon opens the global dialog.
const clicked = await ev(`(() => { ${VIS}
  const b = [...document.querySelectorAll("button")].filter(vis)
    .find((n) => /search all conversations/i.test(n.getAttribute("aria-label") || ""));
  if (b) b.click();
  return Boolean(b); })()`);
await sleep(900);
console.log(`\n  4. clic sur l'icone d'en-tete : ${clicked}`);
console.log("     " + JSON.stringify(await ev(SNAPSHOT)));

// Leave the app as found.
await ev(`(() => { ${VIS}
  const d = [...document.querySelectorAll("dialog")].find((x) => x.open);
  if (!d) return false;
  const b = [...d.querySelectorAll("button")].find((n) => /close/i.test((n.getAttribute("aria-label") || "") + (n.innerText || "")));
  if (b) b.click();
  return Boolean(b); })()`);
await sleep(400);
ws.close();
