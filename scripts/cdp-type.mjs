#!/usr/bin/env node
/**
 * Type real keystrokes (CDP Input.dispatchKeyEvent) into the focused composer
 * and optionally submit. Synthetic value-setters + input events are ignored by
 * the React composer in some states (button stays disabled); per-character CDP
 * key events are the measured-reliable path (same technique as
 * ux-run-in-muse.mjs).
 *
 * Usage: node scripts/cdp-type.mjs [--port 9222] [--enter] [--click <text>] "text"
 *   --enter        press Enter after typing (real key event)
 *   --click <text> first focus an element whose text contains <text> (e.g. the
 *                  textarea itself is focused by default when present)
 */
import { argv, exit } from "node:process";

const args = argv.slice(2);
const portFlag = args.indexOf("--port");
const port = portFlag >= 0 ? Number(args[portFlag + 1]) : 9222;
const enter = args.includes("--enter");
const textArg = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--port" && args[i - 1] !== "--click").join(" ");

async function pageTarget() {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = list.find((t) => t.type === "page" && /^https?:/.test(t.url || ""));
  if (!page) throw new Error("no http page target");
  return page;
}

function connect(url) {
  const ws = new WebSocket(url);
  let seq = 0;
  const pending = new Map();
  ws.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    }
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  return { ws, send, ready: new Promise((done) => ws.addEventListener("open", done)) };
}

const target = await pageTarget();
const client = connect(target.webSocketDebuggerUrl);
await client.ready;

// Focus the composer (textarea) so key events land in it.
await client.send("Runtime.evaluate", {
  expression: `(() => { const f = document.querySelector('textarea') || document.querySelector('input[type="text"]'); if (!f) return false; f.focus(); return true; })()`,
});

for (const ch of textArg) {
  await client.send("Input.dispatchKeyEvent", { type: "keyDown", text: ch });
  await client.send("Input.dispatchKeyEvent", { type: "keyUp" });
}
if (enter) {
  await client.send("Input.dispatchKeyEvent", { type: "rawKeyDown", windowsVirtualKeyCode: 13, key: "Enter", code: "Enter" });
  await client.send("Input.dispatchKeyEvent", { type: "keyUp", windowsVirtualKeyCode: 13, key: "Enter", code: "Enter" });
}
const state = await client.send("Runtime.evaluate", {
  expression: `(() => { const f = document.querySelector('textarea'); const b = document.querySelector('button.send') || [...document.querySelectorAll('button')].find(x => /^start conversation/i.test((x.innerText||'').trim())); return { fieldLen: f ? f.value.length : null, btnDisabled: b ? b.disabled : null }; })()`,
  returnByValue: true,
});
process.stdout.write(`${JSON.stringify(state.result.value, null, 2)}\n`);
client.ws.close();
exit(0);
