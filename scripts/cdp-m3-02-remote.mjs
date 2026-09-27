#!/usr/bin/env node
import { writeFileSync as wf } from "node:fs";

/**
 * M3-02: connect a REMOTE MCP server over streamable HTTP to a real public
 * endpoint (mcp.deepwiki.com) through the connector form, and list its tools.
 */
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const report = { schema: "muse-desktop.m3-02-remote-mcp.v1", date: new Date().toISOString().slice(0, 10), platform: "Windows 11 (26200), dev webview (WebView2, CDP)", steps: {}, verdict: {} };

await ev(`(() => {
  const b = document.querySelector('button[aria-label="Extensions"]') ??
    [...document.querySelectorAll("button")].find((x) => x.textContent.trim() === "Extensions");
  b?.click();
  return 1;
})()`);
await sleep(1500);
// fill the remote connector form
await ev(`(() => {
  const panel = document.querySelector('[aria-label="Connectors"]') ?? document;
  const set = (label, v) => {
    const el = [...panel.querySelectorAll("input")].find((i) => i.getAttribute("aria-label") === label);
    if (!el) return "missing:" + label;
    const P = HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(P, "value").set.call(el, v);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    return "ok";
  };
  return [set("Remote connector name", "deepwiki"), set("Public HTTPS connector URL", "https://mcp.deepwiki.com/mcp"), set("Remote MCP bearer token", "")];
})()`);
await sleep(400);
// submit: the connect button in the remote section
const clicked = await ev(`(() => {
  const panel = document.querySelector('[aria-label="Connectors"]') ?? document;
  const btn = [...panel.querySelectorAll("button")]
    .find((b) => /connect/i.test(b.textContent) && !/disconnect/i.test(b.textContent));
  btn?.click();
  return btn ? btn.textContent.trim() : "no-button";
})()`);
report.steps.connectClicked = clicked;
// wait for the tools or an explicit result
const deadline = Date.now() + 60_000;
let result = null;
while (Date.now() < deadline) {
  await sleep(3000);
  result = await ev(`(() => {
    const zone = document.querySelector('[aria-label="Remote MCP connection result"]');
    const text = document.querySelector('[aria-label="Connectors"]')?.innerText ?? "";
    return {
      resultText: zone?.textContent?.slice(0, 220) ?? null,
      hasDeepwiki: /deepwiki|read_wiki/i.test(text),
      error: /refused|invalid|failed|error/i.test(zone?.textContent ?? "") ? zone.textContent.slice(0, 140) : null,
    };
  })()`);
  if (result.hasDeepwiki || result.error) break;
}
report.steps.result = result;
report.verdict.remoteConnectedAndListed = result.hasDeepwiki === true;
report.verdict.all = report.verdict.remoteConnectedAndListed;
const { mkdirSync } = await import("node:fs");
const { dirname } = await import("node:path");
mkdirSync("docs/evidence/2026-09-27-m3-closure", { recursive: true });
wf("docs/evidence/2026-09-27-m3-closure/m3-02-remote-mcp.json", `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report.verdict), "|", JSON.stringify(result).slice(0, 220));
socket.close();
process.exit(0);
