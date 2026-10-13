#!/usr/bin/env node
/**
 * M4-05 on macOS: produce and read images and rich documents, in WKWebView.
 * One isolated instance (scripts/macos/test-instance.mjs) on the pinned engine.
 *
 * The Windows criteria (roadmap M4-05: m4-05-files-xlsx.json and the DOCX
 * composer run of cdp-m4-05-rich-docs.mjs), replayed:
 *   1. an image attached to the first message is read by the real engine
 *      (one live turn: the model names the colour of a generated PNG);
 *   2. Files panel: a real XLSX renders the structured office preview (the
 *      Windows ☑ criterion), and so does a real DOCX;
 *   3. Files panel: a PDF in WKWebView's own reader (the <object> fallback
 *      text stays hidden) and a PNG as an image;
 *   4. the composer and a DOCX: what the attach path does with it.
 * Every file is built here byte for byte (stored ZIP, minimal PDF, zlib PNG),
 * so nothing depends on an office suite.
 *
 * WKWebView's file picker (NSOpenPanel) cannot be driven over the bridge, and
 * the bridge has no DOM.setFileInputFiles: the files reach the composer's
 * <input type=file> through its `files` setter (a DataTransfer built in the
 * page from the same bytes), then its change event, the path the picker ends
 * in.
 *
 *   node scripts/macos/m4-05-rich-docs.mjs --exe ~/muse-proofs/app/08b291d/muse-desktop [--port 9475] [--base <dir>] [--out <json>]
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { INSTALL_IPC_TRACE, argValue, redactor, sleep, waitFor } from "../cdp-harness.mjs";
import { transcript } from "./smoke-real-turn.mjs";
import { launch } from "./test-instance.mjs";

const EXE = resolve(argValue("--exe", "src-tauri/target/debug/muse-desktop"));
const PORT = Number(argValue("--port", "9475"));
const BASE = resolve(argValue("--base", join(tmpdir(), "muse-proofs-g7", "m4-05")));
const OUT = argValue("--out", "docs/evidence/2026-10-13-macos-closure/m4-05-rich-docs-macos.json");
const ID = Date.now().toString(36);

// ---- files, byte for byte ---------------------------------------------------------
function zip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, text] of Object.entries(entries)) {
    const data = Buffer.from(text, "utf8");
    const nameBytes = Buffer.from(name, "utf8");
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 6); local.writeUInt16LE(0, 8);
    local.writeUInt32LE(0, 10); local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26); local.writeUInt16LE(0, 28);
    locals.push(local, nameBytes, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0, 8); central.writeUInt16LE(0, 10);
    central.writeUInt32LE(0, 12); central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28); central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const dir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(centrals.length / 2, 8); end.writeUInt16LE(centrals.length / 2, 10);
  end.writeUInt32LE(dir.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
}
const XML = '<?xml version="1.0" encoding="UTF-8"?>';
const DOCX_TEXT = `M4-05 DOCX BODY ${ID}`;
const XLSX_CELL = `QUALIF-${ID}`;
const docx = () => zip({
  "[Content_Types].xml": `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
  "_rels/.rels": `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
  "word/document.xml": `${XML}<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${DOCX_TEXT}</w:t></w:r></w:p><w:p><w:r><w:t>Second paragraph</w:t></w:r></w:p></w:body></w:document>`,
});
const xlsx = () => zip({
  "[Content_Types].xml": `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`,
  "_rels/.rels": `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
  "xl/workbook.xml": `${XML}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Qualif" sheetId="1" r:id="rId1"/></sheets></workbook>`,
  "xl/_rels/workbook.xml.rels": `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
  "xl/worksheets/sheet1.xml": `${XML}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Ticket</t></is></c><c r="B1" t="inlineStr"><is><t>Result</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>M4-05</t></is></c><c r="B2" t="inlineStr"><is><t>${XLSX_CELL}</t></is></c></row></sheetData></worksheet>`,
});
function pdf(text) {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    null,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  const stream = `BT /F1 18 Tf 20 70 Td (${text}) Tj ET`;
  objects[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  let body = "%PDF-1.4\n";
  const offsets = [];
  objects.forEach((obj, i) => { offsets.push(body.length); body += `${i + 1} 0 obj\n${obj}\nendobj\n`; });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}
function png(width, height, [r, g, b]) {
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: width }, () => [r, g, b]).flat())]);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.concat(Array(height).fill(row)))), chunk("IEND", Buffer.alloc(0))]);
}

// ---- page helpers ------------------------------------------------------------------
async function click(app, expr) {
  const at = await app.ev(`(() => { const el = ${expr}; if (!el) return null; el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  if (!at) throw new Error(`nothing to click: ${expr}`);
  await app.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: at.x, y: at.y });
  await app.send("Input.dispatchMouseEvent", { type: "mousePressed", x: at.x, y: at.y, button: "left", buttons: 1, clickCount: 1 });
  await app.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: at.x, y: at.y, button: "left", buttons: 0, clickCount: 1 });
  await sleep(250);
}
/** The file reaches the <input type=file> as the picker would leave it: `files`, then `change`. */
const attach = (app, inputSelector, name, type, bytes) => app.ev(`(() => {
  const input = document.querySelector(${JSON.stringify(inputSelector)});
  if (!input) return 'no input';
  const bin = atob(${JSON.stringify(bytes.toString("base64"))});
  const data = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) data[i] = bin.charCodeAt(i);
  const transfer = new DataTransfer();
  transfer.items.add(new File([data], ${JSON.stringify(name)}, { type: ${JSON.stringify(type)} }));
  input.files = transfer.files;
  const count = input.files.length;
  input.dispatchEvent(new Event('change', { bubbles: true }));
  return 'set ' + count;
})()`);
const chips = (app) => app.ev(`({ chips: [...document.querySelectorAll('.attachment-chips .attachment-chip')].map((n) => n.innerText.replace(/\\s+/g, ' ').trim()), error: document.querySelector('.attachment-error')?.innerText ?? null })`);
async function openFile(app, name) {
  await click(app, `[...document.querySelectorAll('.files-list .file-row')].find((r) => r.querySelector('.file-name')?.textContent.trim() === ${JSON.stringify(name)})`);
  await waitFor(() => app.ev(`(document.querySelector('.file-preview-head strong')?.textContent || '').endsWith(${JSON.stringify(name)})`), 10_000, 150);
  await sleep(1_200);
  return app.ev(`(() => {
    const article = document.querySelector('.file-preview');
    const object = article.querySelector('object');
    const fallback = object?.querySelector('p');
    const img = article.querySelector('img');
    return {
      head: article.querySelector('.file-preview-head strong')?.textContent ?? null,
      label: article.querySelector('.file-preview-actions > span')?.textContent ?? null,
      table: article.querySelector('table') ? [...article.querySelectorAll('table tr')].map((tr) => [...tr.children].map((c) => c.textContent.trim())) : null,
      caption: article.querySelector('table caption, .structured-caption')?.textContent ?? null,
      text: article.innerText.replace(/\\s+/g, ' ').trim().slice(0, 400),
      pdfObject: object ? { type: object.type, width: Math.round(object.getBoundingClientRect().width), height: Math.round(object.getBoundingClientRect().height), fallbackRendered: Boolean(fallback && fallback.getClientRects().length > 0 && fallback.offsetHeight > 0) } : null,
      image: img ? { naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight, complete: img.complete } : null,
    };
  })()`);
}

// ---- scenario --------------------------------------------------------------------
const project = join(BASE, `project-${ID}`);
mkdirSync(project, { recursive: true });
const files = { "m4-05.docx": docx(), "m4-05.xlsx": xlsx(), "m4-05.pdf": pdf(`M4-05 PDF ${ID}`), "m4-05.png": png(256, 192, [0, 90, 255]) };
for (const [name, bytes] of Object.entries(files)) writeFileSync(join(project, name), bytes);
const platform = execFileSync("sw_vers", [], { encoding: "utf8" }).trim().split("\n").map((l) => l.split(":")[1].trim());
const report = {
  schema: "muse-desktop.m4-05-rich-docs-macos.v1",
  ticket: "M4-05",
  date: new Date().toISOString().slice(0, 10),
  commit: "08b291d",
  platform: `${platform[0]} ${platform[1]} (${platform[2]}), arm64, Apple Silicon; debug build with embedded frontend, WKWebView through the test bridge`,
  harness: "scripts/macos/m4-05-rich-docs.mjs on scripts/macos/test-instance.mjs",
  liveTurns: 0,
  method: "One isolated test instance (fresh data folder, its own WKWebView store, pinned engine with auto-update off). The DOCX, XLSX, PDF and PNG are built by the script (stored ZIP with OOXML parts, a one-page PDF, a zlib PNG) in the project folder. A blue PNG is attached to the first message on the welcome screen and sent with Enter (one live turn): the model is asked for its colour. The Files work panel then opens each file with the bridge's trusted mouse; the preview is read from the DOM (table cells, the PDF <object> and whether its fallback text is laid out, the image's decoded size). Last, a DOCX is put on the conversation composer's file input. NSOpenPanel cannot be driven over the bridge and the bridge has no DOM.setFileInputFiles, so the files reach <input type=file> through its files setter (a DataTransfer built in the page from the same bytes) and its change event.",
  limits: [
    "The file picker itself (NSOpenPanel, and whether it greys out files outside the input's accept list) is not driven: the files enter at the input's files setter.",
    "The PDF reader is checked through the DOM (the <object> keeps its size and its fallback text is not laid out, so WebKit's PDF view took it); its pixels are not compared.",
    "The composer refuses a DOCX on every platform at 08b291d: readAttachment (src/lib/attachments.ts) takes images and text extensions only and the input's accept list has no office type. The Windows run of cdp-m4-05-rich-docs.mjs that the roadmap cites (m4-05-rich-docs.json) is not in the repository; its verdict tested the transcript tail against /could not be read/, which the refusal text does not match. The criterion is recorded here as measured, false.",
    "Model variance, measured while writing this proof: with a 48x32 PNG the model answered blue once, white once and once started a shell tool to look for the file; with the 256x192 PNG of the recorded run it answered blue. The image part was on the wire (send_input carried an image part) every time.",
    "Generation of an image or a document by the engine is not part of the criteria and is not measured; neither is Open in app (it would open another application on the desktop).",
  ],
  checks: {},
};
const inst = await launch({ exe: EXE, port: PORT, data: join(BASE, `data-${ID}`) });
report.engine = inst.engineVersion;
report.isolation = inst.isolation;
const app = inst.app;
try {
  // 1. An image read by the engine, attached to the first message.
  await waitFor(() => app.ev(`document.querySelectorAll('.primary-nav button[aria-label="New conversation"]').length > 0`), 60_000);
  await app.ev(INSTALL_IPC_TRACE);
  await app.ev(`(window.__baselineIpc.dialogQueue.push(${JSON.stringify(project)}), true)`);
  await click(app, `document.querySelector('.primary-nav button[aria-label="New conversation"]')`);
  await waitFor(() => app.ev(`Boolean(document.querySelector('details.project-picker-control'))`), 8_000, 100);
  await app.ev(`(document.querySelector('details.project-picker-control').open = true, true)`);
  await waitFor(() => app.ev(`Boolean(document.querySelector('.project-option-new'))`), 8_000, 100);
  await click(app, `document.querySelector('.project-option-new')`);
  await waitFor(() => app.ev(`(document.querySelector('.welcome-project-note')?.innerText || '').length > 0`), 8_000, 100);
  const welcomeAttach = await attach(app, "label.composer-attach input[type=file]", "m4-05.png", "image/png", files["m4-05.png"]);
  await sleep(800);
  const welcomeChips = await chips(app);
  const prompt = "The image is attached inline to this message; look at it directly and do not use any tool. What is its dominant colour? Answer with one lowercase English colour word only.";
  await click(app, `document.querySelector('textarea[aria-label="Your first message"]')`);
  await app.send("Input.insertText", { text: prompt });
  await waitFor(() => app.ev(`(() => { const b = document.querySelector('button.welcome-send'); return document.activeElement?.value === ${JSON.stringify(prompt)} && b && !b.disabled; })()`), 10_000, 100);
  await app.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", text: "\r" });
  await app.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter" });
  const start = await waitFor(async () => (await app.ev("window.__baselineIpc.calls.filter((c) => c.cmd === 'start_session' && c.ok !== undefined)"))[0] ?? null, 60_000, 200);
  const sid = start?.ok ? JSON.parse(start.result).session_id : null;
  if (!sid) throw new Error(`no session: ${start?.result ?? "no start_session"}`);
  report.liveTurns = 1;
  await waitFor(() => app.ev("window.__baselineIpc.calls.some((c) => c.cmd === 'send_input')"), 30_000, 200);
  const sentParts = await app.ev(`window.__baselineIpc.calls.filter((c) => /send_input|start_turn|turn/.test(c.cmd)).map((c) => ({ cmd: c.cmd, parts: JSON.stringify(c.args || {}).match(/"type":"(\\w+)"/g) }))`);
  const answer = await waitFor(async () => {
    const running = await app.ev(`document.querySelector('.task-metadata .dot')?.getAttribute('data-running') === 'true'`).catch(() => true);
    const last = (await transcript(app, sid)).filter((e) => e.role === "assistant").at(-1);
    return !running && last && String(last.text).trim() ? String(last.text).trim() : null;
  }, 240_000, 1_000);
  const userEntry = (await transcript(app, sid)).find((e) => e.role === "user");
  report.checks.imageRead = { attach: welcomeAttach, chips: welcomeChips, sentParts, userEntryAttachments: userEntry?.attachments?.map((a) => ({ name: a.name, mediaType: a.mediaType, kind: a.kind })) ?? null, answer, transcriptRoles: (await transcript(app, sid)).map((e) => `${e.role}:${String(e.text ?? "").slice(0, 60)}`), runningDot: await app.ev(`document.querySelector('.task-metadata .dot')?.getAttribute('data-running') ?? null`).catch(() => "unreadable") };

  // 2-3. Files panel previews.
  if (!(await app.ev(`Boolean(document.querySelector('nav.work-tabs'))`))) await click(app, `document.querySelector('button[aria-label="Show work panel"]')`);
  await waitFor(() => app.ev(`Boolean(document.querySelector('nav.work-tabs'))`), 5_000, 100);
  await click(app, `[...document.querySelectorAll('nav.work-tabs button')].find((b) => b.textContent.trim() === 'Files')`);
  await waitFor(() => app.ev(`document.querySelectorAll('.files-list .file-row').length >= 4`), 15_000, 200);
  report.checks.files = {};
  for (const name of ["m4-05.xlsx", "m4-05.docx", "m4-05.pdf", "m4-05.png"]) report.checks.files[name] = await openFile(app, name);
  const shot = await app.send("Page.captureScreenshot", { format: "png" }).catch((e) => ({ error: e.message }));
  if (shot?.data) writeFileSync(join(BASE, `m4-05-png-preview-${ID}.png`), Buffer.from(shot.data, "base64"));
  await openFile(app, "m4-05.pdf");
  const pdfShot = await app.send("Page.captureScreenshot", { format: "png" }).catch((e) => ({ error: e.message }));
  if (pdfShot?.data) writeFileSync(join(BASE, `m4-05-pdf-preview-${ID}.png`), Buffer.from(pdfShot.data, "base64"));
  report.checks.screenshots = { taken: Boolean(shot?.data && pdfShot?.data), keptOutsideTheRepository: "the screenshots show the temp folder path, so they stay in the proof folder; on the 13/10 run the PDF screenshot showed the PDF's own text drawn in the Files preview" };

  // 4. The composer and a DOCX.
  const composerAttach = await attach(app, "label.composer-attach input[type=file]", "m4-05.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", files["m4-05.docx"]);
  await sleep(800);
  report.checks.composerDocx = { attach: composerAttach, ...(await chips(app)), acceptList: await app.ev(`document.querySelector('label.composer-attach input[type=file]')?.getAttribute('accept') ?? null`) };
} catch (error) {
  report.failure = String(error?.message ?? error).slice(0, 400);
} finally {
  report.consoleErrors = app.errors.slice(0, 20);
  report.stop = await inst.stop();
}

const c = report.checks;
const f = c.files ?? {};
report.verdicts = {
  "1 an attached image is read by the engine": (c.imageRead?.chips?.chips ?? []).length === 1 && /blue/i.test(c.imageRead?.answer ?? ""),
  "2 XLSX: structured office preview in Files": JSON.stringify(f["m4-05.xlsx"]?.table ?? []).includes(XLSX_CELL) && /XLSX/.test(f["m4-05.xlsx"]?.text ?? ""),
  "2 DOCX: structured office preview in Files": JSON.stringify(f["m4-05.docx"]?.table ?? []).includes(DOCX_TEXT),
  "3 PDF: rendered by WKWebView's reader": Boolean(f["m4-05.pdf"]?.pdfObject) && f["m4-05.pdf"].pdfObject.fallbackRendered === false && f["m4-05.pdf"].pdfObject.height > 50,
  "3 PNG: rendered as an image": f["m4-05.png"]?.image?.naturalWidth === 256 && f["m4-05.png"].image.naturalHeight === 192,
  "4 DOCX on the composer: accepted as an attachment": (c.composerDocx?.chips ?? []).some((t) => t.includes("m4-05.docx")),
  "clean stop": report.stop?.leftAfterQuit?.length === 0 && report.stop.defaultStoresUnchangedAtEnd === true && report.stop.testStoreDeleted === true && !report.failure,
};
report.passed = Object.values(report.verdicts).every(Boolean);
const redact = redactor([[BASE, "<proof>"], [BASE.replace(/^\/var\//, "/private/var/"), "<proof>"], [homedir(), "<home>"]]);
mkdirSync(resolve(OUT, ".."), { recursive: true });
writeFileSync(OUT, `${JSON.stringify(redact(report), null, 2)}\n`);
console.log(JSON.stringify({ verdicts: report.verdicts, failure: report.failure ?? null }, null, 2));
process.exit(report.passed ? 0 : 1);
