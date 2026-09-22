#!/usr/bin/env node
/**
 * Verify the welcome screen offers ONE entry for where a conversation runs.
 *
 * It used to offer two: a folder chip ("Change folder Â· openscreen") and a
 * project selector ("Project Â· openscreen"). Both answered the same question,
 * both printed the same word, and nothing said which one won. This asserts the
 * folder chip and the old `<select>` are gone, that a single project control
 * remains, and that its popover is where a missing project gets created â€” by
 * choosing a folder, since a project *is* its folder.
 *
 * Usage: node scripts/ux-project-picker.mjs [--port 9227] [--out <png>]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const PORT = Number(arg("--port", "9227"));
const OUT = arg("--out", null);
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
  if (c.display !== "contents" && n.getClientRects().length === 0) return false;
  if (n.closest("details:not([open])")) return false; return true; };`;

// Preconditions: the welcome screen is the one with the project picker.
const openedWizard = await ev(`(() => { ${VIS}
  if (document.querySelector(".empty-session")) return "deja ouverte";
  const b = [...document.querySelectorAll("button")].filter(vis)
    .find((n) => (n.innerText || "").trim() === "New conversation");
  if (b) b.click();
  return b ? "ouverte" : "introuvable"; })()`);
await sleep(1500);
if (openedWizard === "introuvable") {
  console.error("precondition: ecran d'accueil introuvable");
  ws.close();
  process.exit(1);
}

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail === undefined ? "" : ` â€” ${detail}`}`);
  if (!ok) failures += 1;
};

const before = await ev(`(() => { ${VIS}
  const picker = [...document.querySelectorAll(".project-picker")].filter(vis);
  return {
    welcome: Boolean(document.querySelector(".empty-session")),
    pickers: picker.length,
    folderChip: [...document.querySelectorAll(".workspace-picker")].filter(vis).length,
    changeFolder: [...document.querySelectorAll("button")].filter(vis)
      .filter((b) => /^(Change folder|Choose folder)$/.test((b.innerText || "").trim())).length,
    selects: document.querySelectorAll("#welcome-environment-select").length,
    trigger: (document.querySelector(".project-trigger")?.innerText || "").replace(/\\s+/g, " ").trim(),
    note: (document.querySelector(".welcome-project-note")?.innerText || "").trim(),
  }; })()`);
console.log("\necran d'accueil");
console.log("  " + JSON.stringify(before, null, 2).replace(/\n/g, "\n  "));

console.log("\nverifications");
check("l'ecran d'accueil est affiche", before.welcome);
check("une seule entree de projet", before.pickers === 1, `${before.pickers} controle(s)`);
check("la pastille de dossier a disparu", before.folderChip === 0);
check("Â« Change folder Â» a disparu", before.changeFolder === 0);
check("l'ancien selecteur a disparu", before.selects === 0);
check("l'entree annonce un projet", before.trigger.length > 0, before.trigger);
check(
  "la note ne repete plus le meme mot deux fois",
  !/openscreen with openscreen/i.test(before.note),
  before.note,
);

// The popover is where a missing project gets created.
// Set the disclosure rather than clicking it: a click toggles, so a second run
// against an already-open popover would close it and measure nothing.
await ev(`(() => { ${VIS}
  const control = document.querySelector(".project-picker-control");
  if (!control) return false;
  control.open = true;
  return true; })()`);
await sleep(600);
const popover = await ev(`(() => { ${VIS}
  const box = document.querySelector(".project-popover");
  if (!box || !vis(box)) return { open: false };
  return {
    open: true,
    options: [...box.querySelectorAll(".project-option")].filter(vis).length,
    labels: [...box.querySelectorAll(".project-option strong")].filter(vis).map((n) => n.innerText.trim()),
    newAction: (box.querySelector(".project-option-new")?.innerText || "").trim(),
    hint: (box.querySelector(".project-popover-empty")?.innerText || "").trim(),
  }; })()`);
console.log("\npopover");
console.log("  " + JSON.stringify(popover));
check("le popover s'ouvre", popover.open === true);
check("il liste les projets existants", popover.options > 0, `${popover.options} projet(s)`);
check(
  "il offre de creer un projet depuis un dossier",
  /folder/i.test(popover.newAction ?? ""),
  popover.newAction,
);

if (OUT) {
  const box = await ev(`(() => {
    const el = document.querySelector(".project-picker");
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const pop = document.querySelector(".project-popover");
    const bottom = pop && pop.getBoundingClientRect().height ? pop.getBoundingClientRect().bottom : r.bottom;
    return { x: Math.max(0, Math.round(r.left) - 10), y: Math.max(0, Math.round(r.top) - 10),
             width: Math.round(r.width) + 20, height: Math.round(bottom - r.top) + 20 };
  })()`);
  if (box) {
    const shot = await cmd("Page.captureScreenshot", { format: "png", clip: { ...box, scale: 2 } });
    if (shot.result?.data) {
      mkdirSync(dirname(OUT), { recursive: true });
      writeFileSync(OUT, Buffer.from(shot.result.data, "base64"));
      console.log(`\n  capture : ${OUT}`);
    }
  }
}

ws.close();
console.log(failures === 0 ? "\nPASS" : `\n${failures} verification(s) en echec`);
process.exit(failures === 0 ? 0 : 1);
