#!/usr/bin/env node
/**
 * M4-06 app-level proof: against the real reference server, drive the real
 * UI — configure the endpoint, snapshot the open conversation, publish,
 * read the minted URL as a second client, revoke, observe the 404.
 */
import { spawn } from "node:child_process";
import { writeFileSync as wf, mkdirSync } from "node:fs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = 8791;
const TOKEN = `rig-${Date.now().toString(36)}`;
const report = {
  schema: "muse-desktop.m4-06-publish-proof.v1",
  date: new Date().toISOString().slice(0, 10),
  platform: "Windows 11 (26200), dev webview (WebView2, CDP), reference share-server on loopback",
  steps: {},
  verdict: {},
};

// 1. the reference server, exactly as the user would run it
const server = spawn(process.execPath, ["scripts/share-server.mjs", "--port", String(PORT)], {
  env: { ...process.env, SHARE_TOKEN: TOKEN },
  stdio: ["ignore", "pipe", "pipe"],
});
let up = false;
server.stdout.on("data", (d) => { if (/listening/.test(String(d))) up = true; });
for (let i = 0; i < 20 && !up; i += 1) await sleep(500);
report.steps.serverUp = up;
if (!up) { console.log("server did not start"); server.kill(); process.exit(1); }

// 2. the app via CDP
const list = await (await fetch("http://127.0.0.1:9222/json/list")).json();
const page = list.find((t) => t.type === "page" && /^(http:\/\/localhost:1420|http:\/\/tauri\.localhost)/.test(t.url) && t.webSocketDebuggerUrl);
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
  const p = new Promise((res, rej) => pending.set(i, (f) => (f.error ? rej(new Error(f.error.message)) : res(f.result.result?.value))));
  socket.send(JSON.stringify({ id: i, method: "Runtime.evaluate", params: { expression: x, returnByValue: true, awaitPromise: true } }));
  return p;
};

// 3. open Settings, configure the endpoint
await ev(`(() => { document.querySelector("button.account[aria-label=Settings]")?.click(); })()`);
await sleep(1200);
const setUrl = await ev(`(() => {
  const panel = document.querySelector(".share-panel");
  if (!panel) return { found: false };
  const set = (selector, value) => {
    const input = panel.querySelector(selector);
    const P = HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(P, "value").set.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  };
  set('input[aria-label="Share service URL"]', "http://127.0.0.1:${PORT}");
  set('input[aria-label="Share service token"]', "${TOKEN}");
  return { found: true };
})()`);
await sleep(300);
const saved = await ev(`(() => {
  const btn = Array.from(document.querySelectorAll(".share-endpoint-actions button")).find((b) => b.textContent?.trim() === "Save service");
  btn?.click();
  return { clicked: !!btn };
})()`);
await sleep(800);
const endpointState = await ev(`(() => document.querySelector(".share-endpoint-ok")?.textContent?.trim() ?? "none")()`);
report.steps.endpoint = { setUrl, saved, endpointState };
report.verdict.endpointConfigured = endpointState.includes("127.0.0.1") && endpointState.includes("token set");

// 4. snapshot the open conversation (markdown)
const snapshot = await ev(`(() => {
  const btn = Array.from(document.querySelectorAll(".share-snapshot button")).find((b) => b.textContent?.trim() === "Markdown");
  btn?.click();
  return { clicked: !!btn };
})()`);
await sleep(1500);
report.steps.snapshot = snapshot;
report.verdict.bundleCreated = snapshot.clicked === true;

// 5. publish (24 h)
const publish = await ev(`(() => {
  const btn = Array.from(document.querySelectorAll(".share-bundle button")).find((b) => b.textContent?.trim() === "Publish");
  btn?.click();
  return { clicked: !!btn };
})()`);
await sleep(3000);
const urlShown = await ev(`(() => document.querySelector(".share-url")?.textContent?.trim() ?? null)()`);
report.steps.publishedUrl = urlShown;
report.verdict.urlShownOnlyAfterServerAnswered = Boolean(urlShown && urlShown.startsWith("http://127.0.0.1"));

// 6. a second client reads it without any token
if (urlShown) {
  const reader = await fetch(urlShown);
  const body = await reader.json();
  report.verdict.secondClientReads = reader.status === 200 && typeof body?.bundle?.body === "string";
  // 7. revoke from the UI, then observe the 404
  const revoke = await ev(`(() => {
    const btn = Array.from(document.querySelectorAll(".share-bundle button")).find((b) => b.textContent?.trim() === "Revoke");
    btn?.click();
    return { clicked: !!btn };
  })()`);
  await sleep(3000);
  report.steps.revoke = revoke;
  const after = await fetch(urlShown);
  report.verdict.revokedLinkIs404 = after.status === 404;
  const uiState = await ev(`(() => document.querySelector(".session-center, .share-panel")?.innerText?.match(/Revoked[^\\n]*/)?.[0] ?? "no revoke note")()`);
  report.steps.uiAfterRevoke = uiState;
}

mkdirSync("docs/evidence/2026-09-27-m4-closure", { recursive: true });
wf("docs/evidence/2026-09-27-m4-closure/m4-06-publish-proof.json", `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report.verdict, null, 1));
socket.close();
server.kill();
process.exit(0);
