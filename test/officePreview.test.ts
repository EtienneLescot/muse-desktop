import assert from "node:assert/strict";
import test from "node:test";
import { strToU8, zipSync } from "fflate";
import {
  officePreviewForFile,
  MAX_OFFICE_ENTRY_BYTES,
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

test("ODT preview extracts headings and paragraphs", () => {
  const data = archive({
    "content.xml":
      "<office:document-content><office:body><office:text><text:h>Title</text:h><text:p>Hello <text:span>world</text:span></text:p></office:text></office:body></office:document-content>",
  });
  const preview = officePreviewForFile("notes.odt", data);
  assert.deepEqual(preview, {
    kind: "table",
    format: "odt",
    columns: ["Paragraph"],
    rows: [["Title"], ["Hello world"]],
    truncated: false,
  });
});

test("ODS preview extracts bounded rows and repeated cells", () => {
  const data = archive({
    "content.xml":
      "<office:document-content><table:table><table:table-row><table:table-cell><text:p>Name</text:p></table:table-cell><table:table-cell><text:p>Age</text:p></table:table-cell></table:table-row><table:table-row><table:table-cell table:number-columns-repeated=\"2\"><text:p>Ada</text:p></table:table-cell></table:table-row></table:table></office:document-content>",
  });
  const preview = officePreviewForFile("people.ods", data);
  assert.equal(preview?.format, "ods");
  assert.deepEqual(preview?.columns, ["Name", "Age"]);
  assert.deepEqual(preview?.rows, [["Ada", "Ada"]]);
});

test("ODP preview extracts slide text in document order", () => {
  const data = archive({
    "content.xml":
      "<office:document-content><draw:page><text:p>First</text:p><text:p>slide</text:p></draw:page><draw:page><text:p>Second</text:p></draw:page></office:document-content>",
  });
  const preview = officePreviewForFile("deck.odp", data);
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

test("office preview rejects an oversized XML entry before inflating it", () => {
  const oversized = strToU8("x".repeat(MAX_OFFICE_ENTRY_BYTES + 1));
  const data = encode(zipSync({ "word/document.xml": oversized }));
  assert.equal(officePreviewForFile("oversized.docx", data), null);
});
