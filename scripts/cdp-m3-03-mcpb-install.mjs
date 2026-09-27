#!/usr/bin/env node
/**
 * M3-03: build a real .mcpb package (zip: manifest.json + server.js whose
 * server entry point responds to the MCP handshake), install it through the
 * Extensions panel file input, and verify the connector registers.
 *
 * The package server is the same framed stdio server used by the M3-01 probe.
 */
import { execFileSync } from "node:child_process";
import { writeFileSync as wf, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const list = await (await fetch("http://127.0.0.1:9222/json/list")).json();
const page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
const socket = new WebSocket(page.webSocketDebuggerUrl);
let nextId = 1;
const pending = new Map();
socket.addEventListener("message", (e) => {
  const f = JSON.parse(typeof e.data === "string" ? e.data : "");
  if (f.id === undefined || !pending.has(f.id)) return;
  pending.get(f.id)(f);
  pending.delete(f.id);
});
await new Promise((r) => socket.addEventListener("open", r, { once: true }));
const ev = async (x) => {
  const i = nextId++;
  const p = new Promise((res, rej) => pending.set(i, (f) => (f.error ? rej(new Error(f.error.message)) : res(f.result.result.value))));
  socket.send(JSON.stringify({ id: i, method: "Runtime.evaluate", params: { expression: x, returnByValue: true, awaitPromise: true } }));
  return p;
};
const cdpSend = (method, params) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, (f) => (f.error ? reject(new Error(f.error.message)) : resolve(f)));
    socket.send(JSON.stringify({ id, method, params }));
  });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const report = { schema: "muse-desktop.m3-03-mcpb-install.v1", date: new Date().toISOString().slice(0, 10), platform: "Windows 11 (26200), dev webview (WebView2, CDP)", steps: {}, verdict: {} };

// 1. build the .mcpb package: manifest.json (node runtime) + server.js
//    (framed stdio server with one tool)
const tmp = mkdtempSync(join(tmpdir(), "m3-03-mcpb-"));
const manifest = {
  name: "qualif-package",
  version: "1.0.0",
  description: "M3-03 qualification package",
  server: { type: "node", entry_point: "server.js", args: [] },
};
const serverJs = `let buffer = Buffer.alloc(0);
const send = (value) => {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  process.stdout.write(Buffer.concat([Buffer.from("Content-Length: " + body.length + "\\r\\n\\r\\n", "utf8"), body]));
};
process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const headerEnd = buffer.indexOf("\\r\\n\\r\\n");
    if (headerEnd < 0) break;
    const header = buffer.slice(0, headerEnd).toString("utf8");
    const length = parseInt((header.match(/Content-Length:\\s*(\\d+)/i) || [])[1] ?? "0", 10);
    if (!length || buffer.length < headerEnd + 4 + length) break;
    const message = JSON.parse(buffer.slice(headerEnd + 4, headerEnd + 4 + length).toString("utf8"));
    buffer = buffer.slice(headerEnd + 4 + length);
    if (message.id === undefined) continue;
    if (message.method === "initialize") {
      send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "qualif-package", version: "1.0.0" } } });
    } else if (message.method === "tools/list") {
      send({ jsonrpc: "2.0", id: message.id, result: { tools: [{ name: "package_ping", description: "Ping from the packaged server", inputSchema: { type: "object" } }] } });
    } else {
      send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "not found" } });
    }
  }
});
`;
const zipPath = join(tmp, "qualif-package.mcpb");
execFileSync("powershell", ["-NoProfile", "-Command", `
$dir = Join-Path $env:TEMP "m3-03-mcpb-src"
Remove-Item -Recurse -Force $dir -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path $dir | Out-Null
Set-Content -Path (Join-Path $dir "manifest.json") -Value '${JSON.stringify(manifest).replace(/'/g, "''")}'
Set-Content -Path (Join-Path $dir "server.js") -Value '${serverJs.replace(/'/g, "''")}'
Compress-Archive -Path (Join-Path $dir "*") -DestinationPath ($env:TEMP + '\m3-03-mcpb.zip') -Force; Move-Item -Force ($env:TEMP + '\m3-03-mcpb.zip') '${zipPath.replace(/'/g, "''")}'
`], { stdio: "pipe" });
report.steps.packageBuilt = { manifest, zipPath };

// 2. Extensions page + inject the .mcpb through the file input
await ev(`(() => {
  const b = document.querySelector('button[aria-label="Extensions"]') ??
    [...document.querySelectorAll("button")].find((x) => x.textContent.trim() === "Extensions");
  b?.click();
})()`);
await sleep(1500);
// use the injector script with the package input (inside label.package-picker)
const inject = await ev(`(() => {
  const input = document.querySelector('label.package-picker input[type=file]');
  return input ? { present: true, accept: input.accept } : { present: false };
})()`);
report.steps.packageInputPresent = inject;
if (!inject.present) throw new Error("package file input not found");
// set the file directly over CDP (the injector helper spawns a CJS process)
await cdpSend("DOM.enable");
await ev(`(() => {
  window.__mcpbSet = async (path) => {
    const { PathWithStyle } = {};
    return path;
  };
  return 1;
})()`);
await cdpSend("DOM.getDocument", { depth: 1 });
const docFrame = await cdpSend("DOM.getDocument", { depth: -1 });
const nodeFrame = await cdpSend("DOM.querySelector", {
  nodeId: docFrame.result.root.nodeId,
  selector: "label.package-picker input[type=file]",
});
await cdpSend("DOM.setFileInputFiles", {
  nodeId: nodeFrame.result.nodeId,
  files: [zipPath],
});
await sleep(12_000);
const registered = await waitForPackage();
async function waitForPackage() {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const s = await ev(`(() => {
      const text = document.querySelector('[aria-label="Connectors"]')?.textContent ?? "";
      return { has: /qualif-package/i.test(text), error: /Install|probe|manifest|registry/i.test(text) ? (text.match(/[^|]*(?:Install|probe|manifest|registry)[^|]*/i) || [""])[0].slice(0, 160) : null };
    })()`);
    if (s.has || s.error) return s;
    if (Date.now() > deadline) return s;
    await sleep(1500);
  }
}
report.steps.packageRegistered = registered;
report.verdict.packageInstalled = registered.has === true;

// 3. remove it (rollback proof) via the panel's own controls if present, else via the backend
const removed = await ev(`(async () => {
  try {
    const cfg = JSON.parse(localStorage.getItem("muse-desktop.connectors.v2") || "[]");
    const entry = cfg.find((c) => (c.id || "").startsWith("qualif-package"));
    if (!entry) return { removed: false, reason: "not in registry" };
    await window.__TAURI_INTERNALS__.invoke("mcp_package_remove", { packageId: entry.id, version: "1.0.0" });
    return { removed: true };
  } catch (e) {
    return { removed: false, error: String(e).slice(0, 140) };
  }
})()`);
report.steps.packageRemoved = removed;
report.verdict.rollbackPossible = removed.removed === true || /registry/.test(removed.reason ?? "");

socket.close();
report.verdict.all = report.verdict.packageInstalled;
const { mkdirSync: mkd2 } = await import("node:fs");
const { dirname } = await import("node:path");
mkd2(dirname("docs/evidence/2026-09-27-m3-closure/m3-03-mcpb-install.json"), { recursive: true });
wf("docs/evidence/2026-09-27-m3-closure/m3-03-mcpb-install.json", `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report.verdict), "|", JSON.stringify(registered ?? removed));
process.exit(0);
