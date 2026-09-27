#!/usr/bin/env node
/**
 * M3-01: local stdio MCP transport through the app's real Rust client —
 * direct invoke of mcp_local_probe (initialize -> notifications/initialized
 * -> tools/list) against a minimal line-delimited JSON-RPC server.
 */
import { writeFileSync as wf, mkdirSync as mkd } from "node:fs";
import { execFileSync } from "node:child_process";

const PORT = Number(process.env.MUSE_CDP_PORT ?? 9222);
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
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
const report = {
  schema: "muse-desktop.m3-01-local-mcp.v1",
  date: new Date().toISOString().slice(0, 10),
  platform: "Windows 11 (26200), dev webview (WebView2, CDP), real Muse 1.3.0 sidecar",
  steps: {},
  verdict: {},
};
const serverCommand = `node G:/repos/m1-qualification/fake-mcp-server.mjs`;
const result = await ev(`(async () => {
  try {
    return await window.__TAURI_INTERNALS__.invoke("mcp_local_probe", {
      command: ${JSON.stringify(serverCommand)},
      workspace: "G:\\\\repos\\\\m1-qualification",
    });
  } catch (e) {
    return { error: String(e).slice(0, 300) };
  }
})()`);
report.steps.probe = result;
const probeText = JSON.stringify(result);
const serverName = result?.serverName === "qualif-mcp";
const toolListed = (result?.tools ?? []).some((t) => t.name === "qualif_echo");
report.verdict.handshakeAndToolsList = serverName && toolListed;
report.verdict.all = report.verdict.handshakeAndToolsList;
mkd("docs/evidence/2026-09-27-m3-closure", { recursive: true });
wf("docs/evidence/2026-09-27-m3-closure/m3-01-local-mcp.json", `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report.verdict), "|", probeText.slice(0, 200));
socket.close();
process.exit(0);
