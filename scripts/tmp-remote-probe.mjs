#!/usr/bin/env node
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
// fill + submit + capture result with a longer window and direct invoke fallback
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
  return [set("Remote connector name", "deepwiki"), set("Public HTTPS connector URL", "https://mcp.deepwiki.com/mcp")];
})()`);
await sleep(400);
await ev(`(() => {
  const panel = document.querySelector('[aria-label="Connectors"]') ?? document;
  const btn = [...panel.querySelectorAll("button")].find((b) => b.textContent.trim() === "Connect and list tools");
  btn?.click();
  return !!btn;
})()`);
// poll 30s for the result zone to fill
let final = null;
for (let i = 0; i < 10; i++) {
  await sleep(3000);
  final = await ev(`(() => {
    const zone = document.querySelector('[aria-label="Remote MCP connection result"]');
    const connectors = localStorage.getItem("muse-desktop.connectors.v1") || localStorage.getItem("muse-desktop.connectors.v2");
    const text = document.querySelector('[aria-label="Connectors"]')?.innerText ?? "";
    return {
      zone: zone?.textContent?.slice(0, 200) ?? null,
      hasDeepwikiInPanel: /deepwiki/i.test(text),
      connectorStore: connectors ? connectors.slice(0, 200) : null,
      toolNames: (text.match(/read_wiki[^,\\n]|search_wiki[^,\\n]|list_wiki[^,\\n]/g) ?? []).slice(0, 5),
    };
  })()`);
  if (final.hasDeepwikiInPanel) break;
}
console.log(JSON.stringify(final, null, 1));
socket.close();
process.exit(0);
