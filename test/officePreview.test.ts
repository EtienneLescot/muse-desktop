import assert from "node:assert/strict";
import test from "node:test";
import { strToU8, zipSync } from "fflate";
import {
  officePreviewForFile,
  MAX_OFFICE_PREVIEW_ROWS,
} from "../src/lib/officePreview.ts";

function encode(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function archive(files: Record<string, string>): string {
  return encode(zipSync(Object.fromEntries(
    Object.entries(files).map(([name, content]) => [name, strToU8(content)]),
  )));
}

test("DOCX preview extracts bounded paragraphs as rows", () => {
  const data = archive({
    "word/document.xml":
      "<w:document><w:body><w:p><w:r><w:t>Hello &amp; world</w:t></w:r></w:p><w:p><w:r><w:t>Second</w:t></w:r></w:p></w:body></w:document>",
  });
  const preview = officePreviewForFile("notes.docx", data);
  assert.deepEqual(preview, {
    kind: "table",
    format: "docx",
    columns: ["Paragraph"],
    rows: [["Hello & world"], ["Second"]],
    truncated: false,
  });
});

test("XLSX preview resolves shared strings and caps columns", () => {
  const data = archive({
    "xl/sharedStrings.xml": "<sst><si><t>Name</t></si><si><t>Ada</t></si></sst>",
    "xl/worksheets/sheet1.xml":
      "<worksheet><sheetData><row r=\"1\"><c r=\"A1\" t=\"s\"><v>0</v></c><c r=\"B1\"><v>Age</v></c></row><row r=\"2\"><c r=\"A2\" t=\"s\"><v>1</v></c><c r=\"B2\"><v>36</v></c></row></sheetData></worksheet>",
  });
  const preview = officePreviewForFile("people.xlsx", data);
  assert.equal(preview?.format, "xlsx");
  assert.deepEqual(preview?.columns, ["Name", "Age"]);
  assert.deepEqual(preview?.rows, [["Ada", "36"]]);
});

test("PPTX preview keeps slide order and text", () => {
  const data = archive({
    "ppt/slides/slide2.xml": "<p:sld><a:t>Second</a:t></p:sld>",
    "ppt/slides/slide1.xml": "<p:sld><a:t>First</a:t><a:t> slide</a:t></p:sld>",
  });
  const preview = officePreviewForFile("deck.pptx", data);
  assert.deepEqual(preview?.rows, [["1", "First slide"], ["2", "Second"]]);
});

test("office preview rejects malformed archives and unsupported files", () => {
  assert.equal(officePreviewForFile("notes.docx", "not-base64"), null);
  assert.equal(officePreviewForFile("notes.txt", "aGVsbG8="), null);
});

test("office preview bounds oversized row sets", () => {
  const paragraphs = Array.from({ length: MAX_OFFICE_PREVIEW_ROWS + 10 }, (_, index) =>
    `<w:p><w:r><w:t>row ${index}</w:t></w:r></w:p>`,
  ).join("");
  const preview = officePreviewForFile(
    "rows.docx",
    archive({ "word/document.xml": `<w:document><w:body>${paragraphs}</w:body></w:document>` }),
  );
  assert.equal(preview?.rows.length, MAX_OFFICE_PREVIEW_ROWS);
  assert.equal(preview?.truncated, true);
});
