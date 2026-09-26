#!/usr/bin/env node
/** Attach a real file to a page <input type=file> over CDP, with retries. */
import { readFileSync } from "node:fs";

const [, , filePath, selector = 'input[type="file"]'] = process.argv;
if (!filePath) {
  console.error("usage: node file-input-inject.mjs FILE [SELECTOR]");
  process.exit(2);
}
const absolute = filePath.replace(/\//g, "\\");

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

const evalJs = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  return r.result?.value;
};

let ok = false;
for (let attempt = 1; attempt <= 6 && !ok; attempt++) {
  const doc = await send("DOM.getDocument", { depth: -1, pierce: true });
  const node = await send("DOM.querySelector", {
    nodeId: doc.root.nodeId,
    selector,
  });
  if (!node.nodeId) throw new Error(`no element matches ${selector}`);
  await send("DOM.setFileInputFiles", { files: [absolute], nodeId: node.nodeId });
  const count = await evalJs(
    `(document.querySelector(${JSON.stringify(selector)}) || {files:{length:0}}).files.length`,
  );
  if (Number(count) > 0) {
    ok = true;
    break;
  }
  await new Promise((r) => setTimeout(r, 400));
}
if (!ok) throw new Error("file did not attach after 6 attempts");
console.log(`attached ${absolute} to ${selector}`);
socket.close();
process.exit(0);
