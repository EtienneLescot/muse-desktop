#!/usr/bin/env node
/**
 * Verify the retired-instructions notice, end to end.
 *
 * The client used to keep its own project instructions and prepend them to every
 * turn. Retiring that store is only honest if a value someone typed can still be
 * seen and taken out — so this injects one, reloads, and checks the notice:
 * it appears, it says the text is no longer sent, it offers Copy and Dismiss,
 * and Dismiss really clears the stored value.
 *
 * It writes to `muse-desktop.projects.v1` and restores the exact previous string
 * before exiting, then reloads so the app is left as it was found.
 *
 * Usage: node scripts/ux-legacy-instructions.mjs [--port 9227]
 */
const PORT = (() => {
  const i = process.argv.indexOf("--port");
  return i >= 0 ? Number(process.argv[i + 1]) : 9227;
})();
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

const KEY = "muse-desktop.projects.v1";
const original = await ev(`localStorage.getItem(${JSON.stringify(KEY)})`);
console.log(`store initial : ${String(original).slice(0, 120)}...`);

const injected = await ev(`(() => {
  const rows = JSON.parse(localStorage.getItem(${JSON.stringify(KEY)}) || "[]");
  if (rows.length === 0) return false;
  rows[0].instructions = "Always answer in French. Never touch the lockfile.";
  localStorage.setItem(${JSON.stringify(KEY)}, JSON.stringify(rows));
  return true; })()`);
if (!injected) {
  console.error("aucun projet a modifier");
  ws.close();
  process.exit(1);
}
await cmd("Page.reload", {});
await sleep(3500);

await ev(`(() => {
  const button = [...document.querySelectorAll("button.sidebar-manage")]
    .find((b) => (b.innerText || "").includes("Manage projects"));
  if (button) button.click();
  return true; })()`);
await sleep(700);
await ev(`(() => {
  const details = document.querySelector(".project-item details");
  if (details) details.open = true;
  return Boolean(details); })()`);
await sleep(1200);

const notice = await ev(`(() => {
  const el = document.querySelector(".project-legacy-instructions");
  if (!el) return null;
  const buttons = [...el.querySelectorAll("button")].map((b) => (b.innerText || "").trim());
  return { text: (el.innerText || "").replace(/\\s+/g, " ").trim().slice(0, 260), buttons,
           textarea: document.querySelectorAll('textarea[aria-label^="Instructions for project"]').length }; })()`);
console.log("\nencart :");
console.log("  " + JSON.stringify(notice, null, 2).replace(/\n/g, "\n  "));

let failures = 0;
const check = (label, ok) => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}`);
  if (!ok) failures += 1;
};
console.log("\nverifications");
check("l'encart apparait pour une valeur heritee", notice !== null);
check(
  "il propose Copy et Dismiss",
  Boolean(notice && notice.buttons.includes("Copy") && notice.buttons.includes("Dismiss")),
);
check("il ne montre pas de champ editable", (notice?.textarea ?? 1) === 0);
check("il dit que rien n'est plus envoye", Boolean(notice && /no longer sent/.test(notice.text)));

await ev(`(() => {
  const el = document.querySelector(".project-legacy-instructions");
  const button = el ? [...el.querySelectorAll("button")].find((b) => (b.innerText || "").trim() === "Dismiss") : null;
  if (button) button.click();
  return Boolean(button); })()`);
await sleep(1200);
const after = await ev(`(() => {
  const rows = JSON.parse(localStorage.getItem(${JSON.stringify(KEY)}) || "[]");
  return { instructions: rows[0]?.instructions ?? null,
           notice: Boolean(document.querySelector(".project-legacy-instructions")) }; })()`);
console.log("\napres Dismiss :");
console.log("  " + JSON.stringify(after));
check(
  "Dismiss retire la valeur du stockage",
  after.instructions === undefined || after.instructions === null || after.instructions === "",
);
check("Dismiss retire l'encart", after.notice === false);

// Restore exactly what was there before the probe.
await ev(`(() => {
  const raw = ${JSON.stringify(original)};
  if (raw === null) localStorage.removeItem(${JSON.stringify(KEY)});
  else localStorage.setItem(${JSON.stringify(KEY)}, raw);
  return true; })()`);
await cmd("Page.reload", {});
await sleep(2500);
const restored = await ev(`localStorage.getItem(${JSON.stringify(KEY)})`);
check("le stockage est restaure", restored === original);

ws.close();
console.log(failures === 0 ? "\nPASS" : `\n${failures} verification(s) en echec`);
process.exit(failures === 0 ? 0 : 1);
