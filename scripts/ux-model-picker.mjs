#!/usr/bin/env node
/**
 * Verify the composer's model control opens a picker instead of the Settings
 * panel.
 *
 * Before this change the chip called `setSettingsOpen(true)`, so choosing a model
 * meant leaving the conversation. This asserts the three things that make the
 * replacement real: the trigger is a disclosure rather than a settings button,
 * activating it opens a listbox of models, and Settings stays closed.
 *
 * Usage: node scripts/ux-model-picker.mjs --port 9227
 */
import { exit } from "node:process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
const PORT = (() => { const i = process.argv.indexOf("--port"); return i >= 0 ? Number(process.argv[i + 1]) : 9227; })();
const OUT = (() => { const i = process.argv.indexOf("--out"); return i >= 0 ? process.argv[i + 1] : null; })();
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
  const details = document.querySelector(".model-control");
  const trigger = document.querySelector(".model-trigger");
  const popover = document.querySelector(".model-popover");
  const options = popover ? [...popover.querySelectorAll(".model-option")] : [];
  const settings = document.querySelector(".settings-panel");
  return {
    controlPresent: Boolean(details),
    triggerLabel: trigger ? (trigger.innerText || "").trim().slice(0, 46) : null,
    triggerMinWidth: trigger ? getComputedStyle(trigger).minWidth : null,
    open: details ? details.hasAttribute("open") : null,
    popoverVisible: popover ? vis(popover) : false,
    optionCount: options.length,
    optionLabels: options.slice(0, 6).map((o) => (o.innerText || "").replace(/\\s+/g, " ").trim().slice(0, 44)),
    settingsPanelOpen: Boolean(settings),
  }; })()`;

console.log("  avant clic");
console.log("    " + JSON.stringify(await ev(SNAPSHOT)));

const clicked = await ev(`(() => { ${VIS}
  const t = document.querySelector(".model-trigger");
  if (!t) return false;
  t.click();
  return true; })()`);
await sleep(700);
console.log(`\n  clic sur le declencheur : ${clicked}`);
const open = await ev(SNAPSHOT);
console.log("    " + JSON.stringify(open));

if (open.optionCount > 0) {
  // Capture while the popover is genuinely open. An earlier attempt captured it
  // through a separate script that had already closed it, so the clip landed on
  // the composer and the window edge instead of the list.
  if (OUT) {
    const box = await ev(`(() => {
      const el = document.querySelector(".model-popover");
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: Math.max(0, Math.round(r.left) - 10), y: Math.max(0, Math.round(r.top) - 10),
               width: Math.round(r.width) + 20, height: Math.round(r.height) + 20 };
    })()`);
    if (box) {
      const shot = await cmd("Page.captureScreenshot", { format: "png", clip: { ...box, scale: 2 } });
      const data = shot.result?.data;
      if (data) {
        mkdirSync(dirname(OUT), { recursive: true });
        writeFileSync(OUT, Buffer.from(data, "base64"));
        console.log(`\n  capture (popover ouvert) : ${OUT}`);
      }
    }
  }

  const picked = await ev(`(() => { ${VIS}
    const first = document.querySelector(".model-option");
    if (!first) return null;
    const label = (first.innerText || "").replace(/\\s+/g, " ").trim().slice(0, 40);
    first.click();
    return label; })()`);
  await sleep(900);
  console.log(`\n  selection de la premiere option : ${JSON.stringify(picked)}`);
  console.log("    " + JSON.stringify(await ev(SNAPSHOT)));
}

console.log(`\n  le panneau Reglages s'est-il ouvert ? ${open.settingsPanelOpen ? "OUI (defaut)" : "NON (attendu)"}`);
ws.close();
process.exit(open.controlPresent && open.optionCount > 0 && !open.settingsPanelOpen ? 0 : 1);
