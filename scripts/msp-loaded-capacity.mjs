#!/usr/bin/env node

/**
 * How many sessions does one host keep loaded?
 *
 * Starts sessions in a temporary workspace until the host refuses, then checks
 * that `session/setApprovalMode` still applies on a loaded session at the cap.
 * Measured on Muse 1.3 (Windows): 32 loaded, the 33rd start is rejected with
 * `-32030 host loaded-session capacity is exhausted` (`runtime_busy`).
 *
 * Usage:
 *   node scripts/msp-loaded-capacity.mjs
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SIDECAR = resolve(process.env.MUSE_SIDECAR ?? "src-tauri/binaries/muse-x86_64-pc-windows-msvc.exe");
const WORKSPACE = mkdtempSync(join(tmpdir(), "muse-capacity-"));
const uuid = () => { const b=new Uint8Array(16); crypto.getRandomValues(b); const n=BigInt(Date.now()); for(let i=0;i<6;i++) b[i]=Number((n>>BigInt(40-8*i))&0xffn); b[6]=(b[6]&0x0f)|0x70; b[8]=(b[8]&0x3f)|0x80; const h=[...b].map(x=>x.toString(16).padStart(2,"0")).join(""); return h.slice(0,8)+"-"+h.slice(8,12)+"-"+h.slice(12,16)+"-"+h.slice(16,20)+"-"+h.slice(20); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const child = spawn(SIDECAR, ["serve", "--sandbox-network", "restricted"], { stdio: ["pipe", "pipe", "pipe"], cwd: WORKSPACE });
const pending = new Map();
let nextId = 1;
createInterface({ input: child.stdout }).on("line", (line) => {
  let f; try { f = JSON.parse(line); } catch { return; }
  if (f.id !== undefined && pending.has(f.id)) { pending.get(f.id)(f); pending.delete(f.id); }
});
const request = (method, params = {}) => new Promise((resolve) => {
  const id = nextId++;
  pending.set(id, resolve);
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  setTimeout(() => { if (pending.has(id)) { pending.delete(id); resolve({ error: { message: "timeout" } }); } }, 20_000);
});
const err = (r) => r.error ? `${r.error.code} ${r.error.message} ${JSON.stringify(r.error.data ?? {})}`.slice(0, 220) : null;

const init = await request("initialize", { clientInfo: { name: "capacity_probe", version: "1" }, schema: 1, capabilities: { requestedCapabilities: ["userShell"] } });
child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} })}\n`);
await sleep(500);
console.log("initialize advertises no session limit:", Object.keys(init.result ?? {}).join(" "));

const ids = [];
for (let i = 0; i < 40; i++) {
  const r = await request("session/start", { workspaceRoot: WORKSPACE, commandId: uuid() });
  if (r.error) { console.log(`start #${i + 1} FAILED: ${err(r)}`); break; }
  ids.push(r.result.session?.sessionId ?? r.result.sessionId);
}
console.log("sessions loaded:", ids.length);

for (const mode of ["allowAll", "onRequest", "promptUnmatched"]) {
  const r = await request("session/setApprovalMode", { sessionId: ids[0], mode, commandId: uuid() });
  console.log(`setApprovalMode ${mode}:`, err(r) ?? JSON.stringify(r.result).slice(0, 200));
}

child.kill();
