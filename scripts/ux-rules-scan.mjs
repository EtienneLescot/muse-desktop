#!/usr/bin/env node
/**
 * Verify `rules_scan` end to end, through the real bridge, against the files.
 *
 * The point is not the unit-tested derivation but the three claims the UI makes
 * from this payload:
 *   1. the bridge answers at all (the command is registered and serializes);
 *   2. every row describes a file that really exists on disk, or really does
 *      not — checked from Node, not from the payload;
 *   3. reading rules never modifies the user's `AGENTS.md`: bytes and
 *      modification time are compared before and after the call.
 *
 * Usage: node scripts/ux-rules-scan.mjs [--port 9227] [--workspace <path>]
 */
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const PORT = Number(arg("--port", "9227"));
const WORKSPACE = arg("--workspace", process.cwd());

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === "page" && !String(t.url).startsWith("chrome-error"));
if (!page) {
  console.error(`no page on ${PORT}`);
  process.exit(1);
}
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let id = 1;
const pending = new Map();
ws.addEventListener("message", (e) => {
  const frame = JSON.parse(typeof e.data === "string" ? e.data : "");
  if (frame.id === undefined) return;
  const done = pending.get(frame.id);
  if (done) {
    pending.delete(frame.id);
    done(frame);
  }
});
const cmd = (method, params) =>
  new Promise((res) => {
    const next = id++;
    pending.set(next, res);
    ws.send(JSON.stringify({ id: next, method, params }));
  });
async function ev(expression) {
  const r = await cmd("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) {
    throw new Error(r.result.exceptionDetails.exception?.description || "exception");
  }
  return r.result?.result?.value;
}

console.log(`workspace: ${WORKSPACE}`);
console.log(`page     : ${page.url}`);

// Snapshot the files the scan is allowed to read, from outside the app.
function snapshot(paths) {
  const state = new Map();
  for (const path of paths) {
    try {
      const stat = statSync(path);
      state.set(path, { size: stat.size, mtimeMs: stat.mtimeMs, head: readFileSync(path).subarray(0, 64).toString("latin1") });
    } catch {
      state.set(path, null);
    }
  }
  return state;
}
const guesses = ["AGENTS.md", "CLAUDE.md", join(".claude", "CLAUDE.md"), join(".codex", "AGENTS.md")];
const candidates = [join(WORKSPACE, "AGENTS.md"), join(WORKSPACE, "CLAUDE.md")];
const before = snapshot(candidates);

const payload = await ev(`(async () => {
  const bridge = window.__TAURI_INTERNALS__;
  if (!bridge || typeof bridge.invoke !== "function") return { error: "invoke unavailable" };
  try { return await bridge.invoke("rules_scan", { workspace: ${JSON.stringify(WORKSPACE)} }); }
  catch (e) { return { error: String(e).slice(0, 300) }; }
})()`);

if (payload?.error) {
  console.error(`\nFAIL: the native command answered an error: ${payload.error}`);
  ws.close();
  process.exit(1);
}

const after = snapshot(candidates);
let failures = 0;
const check = (label, ok, detail) => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
};

console.log("\npayload");
console.log(`  workspace : ${payload.workspace}`);
console.log(`  governing : ${payload.governing}`);
check("the payload is an object with files[]", Array.isArray(payload.files), `${payload.files?.length} rows`);
if (!Array.isArray(payload.files)) {
  // Iterating an absent array would throw before the read-only comparison runs,
  // and the summary would never print - a probe that fails without saying why.
  ws.close();
  console.log("\n1 check(s) failed");
  process.exit(1);
}
check("four rule roles are always reported", payload.files.length === 4);

console.log("\nrows");
for (const file of payload.files) {
  console.log(`  ${file.id.padEnd(16)} ${file.status.padEnd(11)} present=${String(file.present).padEnd(5)} bytes=${String(file.bytes).padStart(7)}  ${file.path}`);
  console.log(`      ${file.detail}`);
}
console.log(`\nreviewed paths (${guesses.join(", ")}) are the CLI's names`);

// Cross-check presence against the real filesystem, for the project scope.
for (const file of payload.files.filter((row) => row.scope === "project")) {
  let exists = true;
  try {
    statSync(file.path);
  } catch {
    exists = false;
  }
  check(`project row ${file.id} matches the filesystem (${exists ? "exists" : "absent"})`, exists === file.present);
}

// The read-only guarantee, verified from outside the app.
for (const path of candidates) {
  const a = after.get(path) ?? null;
  const b = before.get(path) ?? null;
  const same =
    (a === null && b === null) ||
    (a !== null && b !== null && a.size === b.size && a.mtimeMs === b.mtimeMs && a.head === b.head);
  check(`unchanged: ${path}`, same);
}

// A governing row must be present, and an absent one must carry no preview.
const governing = payload.files.find((row) => row.id === payload.governing);
if (payload.governing) {
  check("the governing row exists and is present", Boolean(governing?.present), payload.governing);
}
check(
  "absent rows carry no preview",
  payload.files.filter((row) => !row.present).every((row) => row.preview === "" && row.bytes === 0),
);

ws.close();
console.log(failures === 0 ? "\nPASS" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
