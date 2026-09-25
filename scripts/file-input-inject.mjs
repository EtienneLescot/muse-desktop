#!/usr/bin/env node
/** Attach a real file to the Settings import <input type=file> over CDP. */
import { readFileSync } from "node:fs";

const [, , filePath, selector = 'input[type="file"]'] = process.argv;
if (!filePath) {
  console.error("usage: node file-input-inject.mjs FILE [SELECTOR]");
  process.exit(2);
}
const list = await (await fetch("http://127.0.0.1:9222/json/list")).json();
const page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
if (!page) throw new Error("no CDP page target");

const socket = new WebSocket(page.webSocketDebuggerUrl);
let nextId = 1;
const pending = new Map();
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
socket.addEventListener("message", (event) => {
  const frame = JSON.parse(event.data);
  if (frame.id && pending.has(frame.id)) {
    const { resolve, reject } = pending.get(frame.id);
    pending.delete(frame.id);
    frame.error ? reject(new Error(frame.error.message)) : resolve(frame.result);
  }
});
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", () => reject(new Error("CDP socket error")), { once: true });
});

await send("DOM.enable");
const doc = await send("DOM.getDocument", { depth: -1, pierce: true });
const node = await send("DOM.querySelector", {
  nodeId: doc.root.nodeId,
  selector,
});
if (!node.nodeId) throw new Error(`no element matches ${selector}`);
await send("DOM.setFileInputFiles", {
  files: [filePath],
  nodeId: node.nodeId,
});
console.log(`attached ${filePath} to ${selector}`);
socket.close();
process.exit(0);
