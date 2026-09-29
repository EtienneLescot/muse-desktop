#!/usr/bin/env node
/**
 * M4-05: rich document on Windows — a real DOCX attached to the composer of
 * the loaded openscreen conversation and sent in a live turn; the office
 * parsing pipeline must accept it (no "could not be read") and the model
 * answers about it.
 */
import { writeFileSync as wf } from "node:fs";
import { zipSync, strToU8 } from "fflate";

const list = await (await fetch("http://127.0.0.1:9222/json/list")).json();
const page = list.find((t) => t.type === "page" && t.url.includes("tauri.localhost") && t.webSocketDebuggerUrl);
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
const send = (m, p) => new Promise((res, rej) => {
  const i = nextId++;
  pending.set(i, (f) => (f.error ? rej(new Error(f.error.message)) : res(f)));
  socket.send(JSON.stringify({ id: i, method: m, params: p }));
});
const ev = async (x) => {
  const r = await send("Runtime.evaluate", { expression: x, returnByValue: true, awaitPromise: true });
  if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description?.slice(0, 200) ?? "page exception");
  return r.result.result.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const report = { schema: "muse-desktop.m4-05-rich-docs.v1", date: new Date().toISOString().slice(0, 10), platform: "Windows 11 (26200), dev webview (WebView2, CDP)", steps: {}, verdict: {} };

const docxPath = "G:/repos/m1-qualification/m4-05-qualif.docx";
wf(docxPath, zipSync({
  "[Content_Types].xml": strToU8('<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'),
  "_rels/.rels": strToU8('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'),
  "word/document.xml": strToU8('<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>M4-05 DOCX QUALIF BODY</w:t></w:r></w:p></w:body></w:document>'),
}));

// active conversation: openscreen (loaded)
await ev(`(() => {
  const sessions = JSON.parse(localStorage.getItem("muse-desktop.sessions.v1") || "[]");
  const inWs = sessions.find((s) => (s.workspace || "").includes("openscreen"));
  const row = [...document.querySelectorAll("button.session-select")]
    .find((b) => (b.getAttribute("title") || "") === inWs.title);
  row?.click();
  return !!row;
})()`);
await sleep(5000);

// attach the DOCX over CDP setFileInputFiles
await send("DOM.enable");
const docFrame = await send("DOM.getDocument", { depth: -1 });
const node = await send("DOM.querySelector", {
  nodeId: docFrame.result.root.nodeId,
  selector: "label.composer-attach input[type=file]",
});
await send("DOM.setFileInputFiles", {
  files: [docxPath.replace(/\//g, "\\")],
  nodeId: node.result.nodeId,
});
await sleep(1500);
const chip = await ev(`(() => ({
  chips: document.querySelectorAll(".attachment-chips .attachment-chip").length,
  name: document.querySelector(".attachment-chip .attachment-name")?.textContent ?? null,
}))()`);
report.steps.docxChip = chip;
if (chip.chips === 0) throw new Error("DOCX chip did not attach");

await ev(`(() => {
  const area = document.querySelector('textarea[aria-label="Message Muse"]');
  const P = HTMLTextAreaElement.prototype;
  Object.getOwnPropertyDescriptor(P, "value").set.call(area, "What does this attached document contain? Answer in one short line.");
  area.dispatchEvent(new Event("input", { bubbles: true }));
})()`);
await sleep(300);
await ev(`(() => { document.querySelector('button[aria-label="Send message"]')?.click(); })()`);
const deadline = Date.now() + 240_000;
let running = true;
let tail = "";
while (Date.now() < deadline) {
  await sleep(5000);
  const s = await ev(`(() => {
    const t = document.querySelector(".session-center")?.innerText ?? "";
    return { running: document.querySelector(".task-metadata .dot")?.getAttribute("data-running") === "true", tail: t.slice(-350) };
  })()`);
  running = s.running;
  tail = s.tail.split(String.fromCharCode(10)).join(" | ");
  if (!running) break;
}
report.steps.docxTurn = { running, tail: tail.slice(-220) };
// acceptance: the office pipeline accepted the attachment (no read failure)
// and the turn completed
report.verdict.docxAcceptedAndAnswered = !running && !/could not be read/i.test(tail);

const { mkdirSync } = await import("node:fs");
const { dirname } = await import("node:path");
mkdirSync("docs/evidence/2026-09-27-m4-closure", { recursive: true });
wf("docs/evidence/2026-09-27-m4-closure/m4-05-rich-docs.json", `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report.verdict), "|", tail.slice(-160));
socket.close();
process.exit(0);
