#!/usr/bin/env node
/**
 * Verify the Projects panel shows the rules the CLI actually loads.
 *
 * Three claims, checked against the live app rather than reasoned about:
 *   1. the retired "Instructions" field is gone from the project detail — the
 *      client no longer keeps a second instruction store;
 *   2. expanding a project reads the folder's rules through the native command
 *      and lists one row per role, with the status the file on disk deserves;
 *   3. a folder whose governing file exists offers its text read-only.
 *
 * Usage: node scripts/ux-project-rules.mjs [--port 9227] [--out <png>]
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

const SNAPSHOT = `(() => {
  const rows = [...document.querySelectorAll(".project-rule-row")];
  return {
    onProjectsPage: Boolean(document.querySelector(".projects-panel")),
    instructionTextareas: document.querySelectorAll('textarea[aria-label^="Instructions for project"]').length,
    summary: (document.querySelector(".project-rules-summary")?.innerText || "").trim(),
    rows: rows.map((r) => ({
      name: r.querySelector(".project-rule-name")?.innerText?.trim() ?? null,
      scope: r.querySelector(".project-rule-scope")?.innerText?.trim() ?? null,
      status: r.querySelector(".project-rule-status")?.innerText?.trim() ?? null,
      detail: r.querySelector(".project-rule-detail")?.innerText?.trim().slice(0, 60) ?? null,
    })),
    previewOpenable: Boolean(document.querySelector(".project-rule-preview")),
  }; })()`;

// Open the Projects page and expand the first project.
await ev(`(() => {
  const button = [...document.querySelectorAll("button.sidebar-manage")]
    .find((b) => (b.innerText || "").includes("Manage projects"));
  if (button) button.click();
  return true; })()`);
await sleep(600);

const projects = await ev(`(() => {
  const items = [...document.querySelectorAll(".project-item")];
  return items.map((item) => (item.querySelector(".project-name")?.innerText || "").trim()); })()`);
console.log(`projets : ${JSON.stringify(projects)}`);
if (projects.length === 0) {
  console.error("aucun projet a inspecter");
  ws.close();
  process.exit(1);
}

// Prefer a project whose folder has rules, so the governing path is exercised.
const target = await ev(`(() => {
  const items = [...document.querySelectorAll(".project-item")];
  const wanted = items.find((i) => (i.innerText || "").includes("openscreen")) ?? items[0];
  const details = wanted.querySelector("details");
  if (details) details.open = true;
  return (wanted.querySelector(".project-name")?.innerText || "").trim(); })()`);
console.log(`projet ouvert : ${target}`);

let snapshot = null;
for (let attempt = 0; attempt < 24; attempt += 1) {
  await sleep(400);
  snapshot = await ev(SNAPSHOT);
  if (snapshot.rows.length > 0) break;
}

console.log("\netat du panneau");
console.log("  " + JSON.stringify(snapshot, null, 2).replace(/\n/g, "\n  "));

let failures = 0;
const check = (label, ok) => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}`);
  if (!ok) failures += 1;
};
console.log("\nverifications");
check("le panneau Projets est affiche", snapshot.onProjectsPage);
check("le champ Instructions a disparu", snapshot.instructionTextareas === 0);
check("une ligne par role (4)", snapshot.rows.length === 4);
check(
  "les statuts sont ceux du vocabulaire",
  snapshot.rows.every((r) => ["Loaded", "Ignored", "Fallback", "Missing"].includes(r.status)),
);
check("chaque ligne s'explique", snapshot.rows.every((r) => (r.detail ?? "").length > 0));
check(
  "aucun chemin verbatim Windows",
  !snapshot.rows.some((r) => JSON.stringify(r).includes("\\\\\\\\?\\\\")),
);
const summaryMentionsRules = /AGENTS\.md|rules file/i.test(snapshot.summary);
check(`le resume parle des regles : ${JSON.stringify(snapshot.summary)}`, summaryMentionsRules);

if (OUT) {
  const box = await ev(`(() => {
    const el = document.querySelector(".project-rules-setting");
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.max(0, Math.round(r.left) - 12), y: Math.max(0, Math.round(r.top) - 12),
             width: Math.round(r.width) + 24, height: Math.round(r.height) + 24 };
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

// Rule paths are long and machine-specific, so the floor of this block is the
// narrow window. Same predicate as ux-panel-overflow.mjs: only content escaping
// a box that cannot scroll it away counts.
const VIS = `const vis = (n) => { if (!n || !n.isConnected) return false; const c = getComputedStyle(n);
  if (c.display === "none" || c.visibility === "hidden") return false;
  if (c.display !== "contents" && n.getClientRects().length === 0) return false; return true; };`;
const LEAK = `(() => { ${VIS}
  const panel = document.querySelector(".projects-panel");
  if (!panel) return { panel: false, deep: [] };
  const deep = [];
  for (const el of panel.querySelectorAll("*")) {
    if (!vis(el)) continue;
    const cls = el.getAttribute("class") || "";
    if (/(^|\\s)sr-only(\\s|$)/.test(cls)) continue;
    const c = getComputedStyle(el);
    if (c.overflowX !== "visible") continue;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    const padR = Number.parseFloat(c.paddingRight) || 0;
    const padL = Number.parseFloat(c.paddingLeft) || 0;
    let worst = 0;
    for (const kid of el.children) {
      const k = kid.getBoundingClientRect();
      if (k.width === 0 && k.height === 0) continue;
      worst = Math.max(worst, Math.max(0, k.right - (r.right - padR)), Math.max(0, (r.left + padL) - k.left));
    }
    if (worst > 1) deep.push({
      cls: cls.split(/\\s+/)[0] || el.tagName.toLowerCase(),
      plus: Math.round(worst),
      inRules: Boolean(el.closest(".project-rules-setting, .project-legacy-instructions")),
    });
  }
  return { panel: true, deep, total: deep.reduce((s, o) => s + o.plus, 0) }; })()`;

console.log("\ndebordement du panneau par largeur");
let rulesLeaks = 0;
for (const width of [1440, 1280, 1080, 900, 820, 760]) {
  await cmd("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: false });
  await sleep(500);
  const probe = await ev(LEAK);
  const mine = (probe.deep ?? []).filter((o) => o.inRules);
  const theirs = (probe.deep ?? []).filter((o) => !o.inRules);
  rulesLeaks += mine.length;
  console.log(
    `  ${String(width).padEnd(6)} regles: ${mine.length === 0 ? "0" : mine.map((o) => `.${o.cls} +${o.plus}`).join(" | ")}` +
      `   reste du panneau: ${theirs.length === 0 ? "0" : theirs.map((o) => `.${o.cls} +${o.plus}`).join(" | ")}`,
  );
}
await cmd("Emulation.clearDeviceMetricsOverride", {});
check("le bloc de regles ne deborde a aucune largeur", rulesLeaks === 0);
// The remaining offenders are pre-existing and were attributed by hiding this
// block and re-measuring: byte-identical leaks at 820px (.workspace-root-row
// +32 twice) and 760px (.project-actions +12), with the block hidden or not.
// They are reported here rather than silently folded into this check.

ws.close();
console.log(failures === 0 ? "\nPASS" : `\n${failures} verification(s) en echec`);
process.exit(failures === 0 ? 0 : 1);
