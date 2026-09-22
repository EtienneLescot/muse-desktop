#!/usr/bin/env node

/**
 * Capture the app window viewport as PNG through CDP.
 *
 * Usage: node scripts/cdp-shot.mjs <output.png>
 */
import { argv, exit, env } from "node:process";
import { writeFileSync } from "node:fs";

const PORT = Number(env.MUSE_CDP_PORT ?? 9222);
const out = argv[2];
if (!out) {
  process.stderr.write("usage: cdp-shot.mjs <output.png>\n");
  exit(1);
}

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === "page" && typeof t.webSocketDebuggerUrl === "string");
if (!page) throw new Error("no CDP page target");

const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", () => reject(new Error("CDP socket error")), { once: true });
});
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = Math.floor(Math.random() * 1e9);
    const listener = (event) => {
      const frame = JSON.parse(typeof event.data === "string" ? event.data : "");
      if (frame.id !== id) return;
      socket.removeEventListener("message", listener);
      if (frame.error) reject(new Error(JSON.stringify(frame.error)));
      else resolve(frame.result);
    };
    socket.addEventListener("message", listener);
    socket.send(JSON.stringify({ id, method, params }));
  });

const shot = await send("Page.captureScreenshot", { format: "png" });
writeFileSync(out, Buffer.from(shot.data, "base64"));
process.stdout.write(`${JSON.stringify({ saved: out })}\n`);
socket.close();
