#!/usr/bin/env node
/**
 * M4-05: place an XLSX in the workspace, open the Files panel on the active
 * conversation, click the file, and verify the structured office preview.
 */
import { writeFileSync as wf, mkdirSync, rmSync } from "node:fs";
import { zipSync, strToU8 } from "fflate";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
const report = { schema: "muse-desktop.m4-05-files-xlsx.v1", date: new Date().toISOString().slice(0, 10), steps: {}, verdict: {} };

// build a minimal valid XLSX in the ACTIVE workspace (openscreen)
const dir = join("G:/repos/openscreen", ".muse-qualif");
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
const xlsxPath = join(dir, "m4-05-qualif.xlsx");
const xlsx = zipSync({
  "[Content_Types].xml": strToU8('<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>'),
  "_rels/.rels": strToU8('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/workbook" Target="xl/workbook.xml"/></Relationships>'),
  "xl/workbook.xml": strToU8('<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheets><sheet name="Qualif" sheetId="1" r:id="rId1" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/></sheets></workbook>'),
  "xl/worksheets/sheet1.xml": strToU8('<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>M4-05</t></is></c><c r="B1" t="inlineStr"><is><t>QUALIF-OK</t></is></c></row></sheetData></worksheet>'),
});
wf(xlsxPath, xlsx);
report.steps.fixture = { xlsxPath };

// open Files panel on the active conversation (already openscreen)
await ev(`(() => {
  document.querySelector('button[aria-label="Show work panel"]')?.click();
})()`);
await sleep(600);
await ev(`(() => {
  const b = [...document.querySelectorAll("nav.work-tabs button")].find((x) => x.textContent.trim() === "Files");
  b?.click();
})()`);
await sleep(1500);
// navigate into .muse-qualif and click the xlsx
await ev(`(() => {
  const row = [...document.querySelectorAll(".files-list .file-row")]
    .find((r) => r.textContent.includes(".muse-qualif"));
  row?.click();
})()`);
await sleep(1500);
await ev(`(() => {
  const row = [...document.querySelectorAll(".files-list .file-row")]
    .find((r) => r.textContent.includes("m4-05-qualif.xlsx"));
  row?.click();
})()`);
await sleep(3500);
const preview = await ev(`(() => {
  const article = document.querySelector(".file-preview");
  const text = article?.innerText ?? "";
  return {
    head: article?.querySelector(".file-preview-head strong")?.textContent ?? null,
    table: !!article?.querySelector("table"),
    tableRows: article?.querySelectorAll("table tr").length ?? 0,
    sample: text.slice(0, 220),
  };
})()`);
report.steps.xlsxPreview = preview;
report.verdict.xlsxStructuredPreview =
  preview.head !== null && preview.head.endsWith("m4-05-qualif.xlsx") && preview.tableRows > 0 && preview.table !== false;
const { writeFileSync: w2, mkdirSync: mk2 } = await import("node:fs");
const { dirname } = await import("node:path");
mk2(dirname("docs/evidence/2026-09-27-m4-closure/m4-05-files-xlsx.json"), { recursive: true });
w2("docs/evidence/2026-09-27-m4-closure/m4-05-files-xlsx.json", `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report.verdict), "|", JSON.stringify(preview).slice(0, 220));
rmSync(dir, { recursive: true, force: true });
socket.close();
process.exit(0);
