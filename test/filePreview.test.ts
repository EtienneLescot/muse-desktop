import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_STRUCTURED_PREVIEW_ROWS,
  structuredPreviewForFile,
} from "../src/lib/filePreview.ts";

describe("structuredPreviewForFile", () => {
  it("renders CSV headers, quoted values, and uneven rows", () => {
    const preview = structuredPreviewForFile(
      "people.csv",
      "name,notes,active\nAda,\"likes, commas\",true\nGrace,,false",
    );
    assert.deepEqual(preview, {
      kind: "table",
      columns: ["name", "notes", "active"],
      rows: [
        ["Ada", "likes, commas", "true"],
        ["Grace", "", "false"],
      ],
      truncated: false,
      format: "csv",
    });
  });

  it("supports TSV and rejects an unclosed quoted field", () => {
    const preview = structuredPreviewForFile("data.tsv", "key\tvalue\na\t1");
    assert.equal(preview?.format, "tsv");
    assert.deepEqual(preview?.rows, [["a", "1"]]);
    assert.equal(structuredPreviewForFile("data.csv", "key,\"value"), null);
  });

  it("maps JSON object arrays to a stable union of columns", () => {
    const preview = structuredPreviewForFile(
      "items.json",
      JSON.stringify([{ id: 1, name: "one" }, { id: 2, extra: true }]),
    );
    assert.deepEqual(preview?.columns, ["id", "name", "extra"]);
    assert.deepEqual(preview?.rows, [["1", "one", ""], ["2", "", "true"]]);
    assert.equal(preview?.format, "json");
  });

  it("renders JSON objects and caps oversized arrays", () => {
    const object = structuredPreviewForFile("config.json", '{"mode":"yolo","enabled":true}');
    assert.deepEqual(object?.columns, ["Key", "Value"]);
    assert.deepEqual(object?.rows, [["mode", "yolo"], ["enabled", "true"]]);

    const values = Array.from({ length: MAX_STRUCTURED_PREVIEW_ROWS + 2 }, (_, index) => index);
    const capped = structuredPreviewForFile("values.json", JSON.stringify(values));
    assert.equal(capped?.rows.length, MAX_STRUCTURED_PREVIEW_ROWS);
    assert.equal(capped?.truncated, true);
  });

  it("leaves unsupported or malformed files in the plain text preview", () => {
    assert.equal(structuredPreviewForFile("notes.md", "# hello"), null);
    assert.equal(structuredPreviewForFile("broken.json", "not json"), null);
  });
});
