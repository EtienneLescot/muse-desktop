#!/usr/bin/env node
/**
 * Verify the worktree choice at conversation start.
 *
 * Two claims: the welcome screen asks the question before the conversation
 * exists, and the native command really creates a worktree without a session —
 * which is what `git_worktree_create` could not do, since it resolved its
 * workspace from a session id.
 *
 * The probe creates a real worktree of the current repository on a throwaway
 * branch, checks the folder and the branch exist, then removes both. It leaves
 * nothing behind.
 *
 * Usage: node scripts/ux-start-worktree.mjs [--port 9227] [--workspace <path>]
 */
import { spawnSync } from "node:child_process";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const PORT = Number(arg("--port", "9227"));
const WORKSPACE = arg("--workspace", process.cwd());
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
const invoke = (method, args = {}) =>
  ev(`(async () => {
    try { return await window.__TAURI_INTERNALS__.invoke(${JSON.stringify(method)}, ${JSON.stringify(args)}); }
    catch (e) { return { __error: String(e).slice(0, 300) }; } })()`);

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail === undefined ? "" : ` — ${detail}`}`);
  if (!ok) failures += 1;
};

// 1. The welcome screen asks the question.
const VIS = `const vis = (n) => { if (!n || !n.isConnected) return false; const c = getComputedStyle(n);
  if (c.display === "none" || c.visibility === "hidden") return false;
  if (c.display !== "contents" && n.getClientRects().length === 0) return false; return true; };`;
await ev(`(() => { ${VIS}
  if (document.querySelector(".empty-session")) return true;
  const b = [...document.querySelectorAll("button")].filter(vis)
    .find((n) => (n.innerText || "").trim() === "New conversation");
  if (b) b.click();
  return Boolean(b); })()`);
await sleep(1500);
const screen = await ev(`(() => { ${VIS}
  const label = document.querySelector(".welcome-worktree");
  const box = label ? label.querySelector("input[type=checkbox]") : null;
  return { present: Boolean(label && vis(label)), checked: box ? box.checked : null,
           text: label ? (label.innerText || "").replace(/\\s+/g, " ").trim() : null }; })()`);
console.log("\necran d'accueil");
console.log("  " + JSON.stringify(screen));
check("la case « Create a new worktree » est proposee", screen.present === true);
check("elle est decochee par defaut", screen.checked === false);
check("elle dit ou le travail aura lieu", /worktree|directly in/i.test(screen.text ?? ""), screen.text);

// 2. The native command creates a worktree with no session id.
const branch = `muse/probe-${Date.now().toString(36)}`;
const relativePath = `.muse/worktrees/${branch.split("/")[1]}`;
console.log(`\ncreation sans session : ${branch}`);
const created = await invoke("git_worktree_create_for_workspace", {
  workspace: WORKSPACE,
  branch,
  relativePath,
  baseRef: "HEAD",
});
if (created.__error) {
  console.error(`  echec : ${created.__error}`);
  process.exit(1);
}
console.log("  " + JSON.stringify(created));
check("la commande repond un chemin", typeof created.path === "string", created.path);

check("le chemin est celui du plan", String(created.path).split(/[\\/]/).join("/").endsWith(relativePath), created.path);
check("la branche est celle demandee", created.branch === branch);

const listed = spawnSync("git", ["-C", WORKSPACE, "worktree", "list", "--porcelain"], { encoding: "utf8" });
check(
  "git connait ce worktree",
  (listed.stdout ?? "").includes(relativePath),
  (listed.stdout ?? "").split("\n").filter((l) => l.startsWith("worktree")).length + " worktree(s)",
);

// A malformed request must be refused before Git runs.
const refused = await invoke("git_worktree_create_for_workspace", {
  workspace: WORKSPACE,
  branch: `${branch}-bad`,
  relativePath: "../outside",
  baseRef: "HEAD",
});
check(
  "un chemin hors .muse/worktrees est refuse",
  typeof refused.__error === "string" && refused.__error.length > 0,
  refused.__error,
);

// Cleanup: remove the worktree and its branch.
const removed = spawnSync("git", ["-C", WORKSPACE, "worktree", "remove", "--force", created.path], {
  encoding: "utf8",
});
spawnSync("git", ["-C", WORKSPACE, "branch", "-D", branch], { encoding: "utf8" });
check("le worktree est retire", removed.status === 0, (removed.stderr ?? "").trim().slice(0, 120));

ws.close();
console.log(failures === 0 ? "\nPASS" : `\n${failures} verification(s) en echec`);
process.exit(failures === 0 ? 0 : 1);
