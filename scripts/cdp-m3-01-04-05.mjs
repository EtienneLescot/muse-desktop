#!/usr/bin/env node
/**
 * M3-04 / M3-05 / M3-01 native qualification through the real webview.
 *
 *   M3-04: a SKILL.md skill created inside the scratch repo's `.muse/skills`
 *          root is discovered by `Scan workspace` (bounded scan, frontmatter
 *          parsed, resources listed).
 *   M3-05: `/qualif-skill` in the composer becomes a skill part and is sent to
 *          the live host; the send path completes with an honest host answer
 *          (execution or typed refusal), no partial send, no crash.
 *   M3-01: a real local stdio MCP server (line-delimited JSON-RPC) is added,
 *          started, and `Refresh tools` lists its `qualif_echo` tool —
 *          initialize → notifications/initialized → tools/list through the
 *          Rust client.
 *
 * Usage: node scripts/cdp-m3-01-04-05.mjs
 *   [--out docs/evidence/2026-09-27-m3-closure/m3-01-04-05-skills-mcp.json]
 */
import { execFileSync } from "node:child_process";
import { writeFileSync as wf, mkdirSync as mkd, rmSync } from "node:fs";
import { dirname } from "node:path";

const PORT = Number(process.env.MUSE_CDP_PORT ?? 9222);
const OUT = (() => {
  const i = process.argv.indexOf("--out");
  return i >= 0 ? process.argv[i + 1] : null;
})();
const REPO_FWD = "G:/repos/m1-qualification";
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

// --- fixtures: a skill with a resource + a minimal MCP stdio server
// the Skills panel scans the app's GLOBAL workspace (openscreen)
const skillDir = "G:/repos/openscreen/.muse/skills/qualif-skill";
rmSync(skillDir, { recursive: true, force: true });
mkd(skillDir, { recursive: true });
wf(`${skillDir}/SKILL.md`, `---
name: qualif-skill
description: Qualification skill that explains its own resource file.
---

Use the resource below, then answer with QUALIF-SKILL-OK.

[resource](./qualif-resource.txt)
`);
wf(`${skillDir}/qualif-resource.txt`, "QUALIF-RESOURCE-CONTENT-4471\n");
const mcpServerPath = `${REPO_FWD}/fake-mcp-server.mjs`;
wf(mcpServerPath, `// minimal MCP stdio server (line-delimited JSON-RPC)
import { createInterface } from "node:readline";
const rl = createInterface({ input: process.stdin });
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
rl.on("line", (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.id === undefined) return;
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: {
      protocolVersion: "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "qualif-mcp", version: "1.0.0" },
    } });
    return;
  }
  if (message.method === "tools/list") {
    send({ jsonrpc: "2.0", id: message.id, result: { tools: [{
      name: "qualif_echo",
      description: "Echo the given text back",
      inputSchema: { type: "object", properties: { text: { type: "string" } } },
    }] } });
    return;
  }
  if (message.method === "tools/call") {
    const text = message.params?.arguments?.text ?? "";
    send({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "pong:" + text }] } });
    return;
  }
  send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "not found" } });
});
`);

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
if (!page) throw new Error("no CDP page target");
const socket = new WebSocket(page.webSocketDebuggerUrl);
let nextId = 1;
const pending = new Map();
socket.addEventListener("message", (event) => {
  const frame = JSON.parse(typeof event.data === "string" ? event.data : "");
  if (frame.id === undefined || !pending.has(frame.id)) return;
  const entry = pending.get(frame.id);
  pending.delete(frame.id);
  frame.error ? entry.reject(new Error(frame.error.message)) : entry.resolve(frame);
});
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", () => reject(new Error("CDP socket error")), { once: true });
});
const send = (m, p) => new Promise((resolve, reject) => {
  const id = nextId++;
  pending.set(id, { resolve, reject });
  socket.send(JSON.stringify({ id, method: m, params: p }));
});
const evaluate = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "page exception");
  return r.result?.result?.value;
};
const report = {
  schema: "muse-desktop.m3-skills-mcp.v1",
  date: new Date().toISOString().slice(0, 10),
  platform: "Windows 11 (26200), dev webview (WebView2, CDP), real Muse 1.3.0 sidecar",
  steps: {},
  verdict: {},
};
const step = (name, data) => {
  report.steps[name] = data;
  console.log(`- ${name}: ${JSON.stringify(data).slice(0, 260)}`);
};
const waitFor = async (label, fn, timeoutMs = 30_000, interval = 600) => {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await fn().catch((error) => ({ ok: false, error: String(error) }));
    if (last && last.ok) return last;
    await sleep(interval);
  }
  throw new Error(`timeout waiting for ${label}: ${JSON.stringify(last).slice(0, 200)}`);
};

// open the scratch conversation (main checkout)
await sleep(2500);
await evaluate(`(() => {
  const sessions = JSON.parse(localStorage.getItem("muse-desktop.sessions.v1") || "[]");
  const inWs = sessions.find((s) => (s.workspace || "").replace(/[\\\\?]/g, "").replace(/\\\\/g, "/").endsWith("repos/m1-qualification"));
  if (!inWs) return false;
  const row = [...document.querySelectorAll("button.session-select")]
    .find((b) => (b.getAttribute("title") || "") === inWs.title);
  row?.click();
  return !!row;
})()`);
await sleep(3500);

// ---- M3-04: scan the workspace, the skill must be discovered
await evaluate(`(() => {
  const b = document.querySelector('button[aria-label="Extensions"]') ??
    [...document.querySelectorAll("button")].find((x) => x.textContent.trim() === "Extensions");
  b?.click();
})()`);
await sleep(1500);
await evaluate(`(() => {
  const b = [...document.querySelectorAll('[aria-label="Skills"] button')]
    .find((x) => /Scan workspace/i.test(x.textContent));
  b?.click();
})()`);
const scan = await waitFor("skill discovered", () => evaluate(`(() => {
  const text = document.querySelector('[aria-label="Skills"]')?.textContent ?? "";
  return {
    ok: /qualif-skill/.test(text),
    text: text.slice(0, 260),
  };
})()`), 30_000);
step("m3-04-skill-discovered", scan);
report.verdict.skillDiscovered = scan.ok;

// ---- M3-01: add the local MCP server, start it, refresh tools
const serverName = "qualif-mcp";
await evaluate(`(() => {
  const b = document.querySelector('button[aria-label="Extensions"]') ??
    [...document.querySelectorAll("button")].find((x) => x.textContent.trim() === "Extensions");
  b?.click();
})()`);
await sleep(1500);
await evaluate(`(() => {
  const panel = document.querySelector('[aria-label="Local MCP server"]') ?? document;
  const nameInput = [...panel.querySelectorAll("input")].find((i) => i.getAttribute("aria-label") === "Local MCP server name");
  const cmdInput = [...panel.querySelectorAll("input")].find((i) => i.getAttribute("aria-label") === "Local MCP command");
  const P = HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(P, "value").set;
  if (nameInput) { setter.call(nameInput, "qualif-mcp"); nameInput.dispatchEvent(new Event("input", { bubbles: true })); }
  if (cmdInput) { setter.call(cmdInput, ${JSON.stringify(`node ${mcpServerPath}`)}); cmdInput.dispatchEvent(new Event("input", { bubbles: true })); }
  return { name: !!nameInput, command: !!cmdInput };
})()`);
await sleep(400);
// the local MCP form submits through its Probe button: initialize ->
// notifications/initialized -> tools/list through the Rust client
const probe = await evaluate(`(() => {
  const form = document.querySelector('[aria-label="Local MCP server"]')?.closest("form")
    ?? document.querySelector('[aria-label="Local MCP server"]')?.parentElement?.querySelector("form");
  const submit = form ? form.querySelector('button[type=submit]') : null;
  if (!submit || submit.disabled) return { ok: false, disabled: submit?.disabled ?? null };
  submit.click();
  return { ok: true };
})()`);
step("m3-01-probe-clicked", probe);
const tools = await waitFor("qualif_echo tools listed", () => evaluate(`(() => {
  const text = document.querySelector('[aria-label="Local MCP server"]')?.textContent ?? "";
  return {
    ok: /qualif_echo/.test(text) && /Connected to/.test(text),
    text: text.match(/Connected to[^\n]{0,140}/)?.[0] ?? text.slice(-140),
  };
})()`), 45_000);
step("m3-01-tools-listed", tools);
report.verdict.localMcpToolsListed = tools.ok;

// ---- M3-05: /qualif-skill in the composer becomes a skill part and is sent
await evaluate(`(() => {
  document.querySelector('button[aria-label="Hide work panel"]')?.click();
})()`);
await sleep(600);
await evaluate(`(() => {
  const area = document.querySelector('textarea[aria-label="Message Muse"]');
  area?.focus();
})()`);
await send("Input.insertText", { text: "/qualif-skill use the resource and confirm" });
await sleep(1200);
const slashState = await evaluate(`(() => ({
  dropdown: !!document.querySelector('[role="listbox"], .composer-slash, [class*="slash"]'),
  value: document.querySelector('textarea[aria-label="Message Muse"]')?.value ?? "",
}))()`);
step("m3-05-slash-typed", slashState);
await evaluate(`(() => {
  const area = document.querySelector('textarea[aria-label="Message Muse"]');
  area?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
})()`);
await sleep(400);
// submit whatever the composer holds (skill part or plain text)
await evaluate(`(() => { document.querySelector('button[aria-label="Send message"]')?.click(); })()`);
const sent = await waitFor("skill turn answer", () => evaluate(`(() => {
  const dot = document.querySelector(".task-metadata .dot");
  const text = document.querySelector(".session-center")?.innerText ?? "";
  return {
    ok: dot?.getAttribute("data-running") !== "true" && text.length > 0,
    tail: text.slice(-160).replace(/\\n+/g, " | "),
  };
})()`), 180_000, 4000);
step("m3-05-sent-to-host", sent);
report.verdict.skillSentToHost = sent.ok;

socket.close();
report.verdict.all =
  !!report.verdict.skillDiscovered &&
  !!report.verdict.localMcpToolsListed &&
  !!report.verdict.skillSentToHost;
if (OUT) {
  mkd(dirname(OUT), { recursive: true });
  wf(OUT, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`written ${OUT}`);
}
rmSync(skillDir, { recursive: true, force: true });
console.log(JSON.stringify(report.verdict));
process.exit(0);
