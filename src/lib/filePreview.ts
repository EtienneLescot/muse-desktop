/**
 * Bounded, dependency-free structured file previews for the workspace browser.
 *
 * This parser intentionally stays small and conservative: it only handles
 * CSV/TSV and JSON files, caps the amount of data rendered, and returns null
 * when the input cannot be represented as a useful table.
 */

export const MAX_STRUCTURED_PREVIEW_ROWS = 100;
export const MAX_STRUCTURED_PREVIEW_COLUMNS = 20;
export const MAX_STRUCTURED_PREVIEW_CELL_CHARS = 400;
export const MAX_STRUCTURED_PREVIEW_CHARS = 40_000;

export interface StructuredPreview {
  kind: "table";
  columns: string[];
  rows: string[][];
  truncated: boolean;
  format: "csv" | "tsv" | "json";
}

function extension(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? path;
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
}

function boundedCell(value: unknown): string {
  let text: string;
  if (value === null) text = "null";
  else if (value === undefined) text = "";
  else if (typeof value === "string") text = value;
  else if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") text = String(value);
  else {
    try {
      text = JSON.stringify(value) ?? String(value);
    } catch {
      text = String(value);
    }
  }
  return text.length > MAX_STRUCTURED_PREVIEW_CELL_CHARS
    ? `${text.slice(0, MAX_STRUCTURED_PREVIEW_CELL_CHARS)}…`
    : text;
}

function normalizeColumn(value: string, fallback: string): string {
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, MAX_STRUCTURED_PREVIEW_CELL_CHARS) : fallback;
}

function parseDelimited(content: string, delimiter: "," | "\t"): StructuredPreview | null {
  const input = content.slice(0, MAX_STRUCTURED_PREVIEW_CHARS + 1);
  let field = "";
  let row: string[] = [];
  const rows: string[][] = [];
  let quoted = false;
  let truncated = content.length > MAX_STRUCTURED_PREVIEW_CHARS;

  const pushField = (): void => {
    if (row.length < MAX_STRUCTURED_PREVIEW_COLUMNS) row.push(boundedCell(field));
    else truncated = true;
    field = "";
  };
  const pushRow = (): void => {
    pushField();
    if (row.some((cell) => cell.length > 0) || rows.length > 0) {
      if (rows.length < MAX_STRUCTURED_PREVIEW_ROWS + 1) rows.push(row);
      else truncated = true;
    }
    row = [];
  };

  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    if (quoted) {
      if (character === '"') {
        if (input[index + 1] === '"') {
          field += '"';
          index += 1;
        } else quoted = false;
      } else {
        field += character;
      }
      continue;
    }
    if (character === '"' && field.length === 0) {
      quoted = true;
    } else if (character === delimiter) {
      pushField();
    } else if (character === "\n" || character === "\r") {
      if (character === "\r" && input[index + 1] === "\n") index += 1;
      pushRow();
    } else {
      field += character;
    }
  }
  if (quoted) return null;
  if (field.length > 0 || row.length > 0) pushRow();
  if (rows.length === 0) return null;

  const first = rows.shift() ?? [];
  const width = Math.min(
    MAX_STRUCTURED_PREVIEW_COLUMNS,
    Math.max(first.length, ...rows.map((item) => item.length)),
  );
  if (width === 0) return null;
  const columns = Array.from({ length: width }, (_, index) =>
    normalizeColumn(first[index] ?? "", `Column ${index + 1}`),
  );
  const dataRows = rows.slice(0, MAX_STRUCTURED_PREVIEW_ROWS).map((item) =>
    Array.from({ length: width }, (_, index) => boundedCell(item[index] ?? "")),
  );
  if (rows.length > MAX_STRUCTURED_PREVIEW_ROWS) truncated = true;
  return { kind: "table", columns, rows: dataRows, truncated, format: delimiter === "\t" ? "tsv" : "csv" };
}

function parseJson(content: string): StructuredPreview | null {
  if (content.length > MAX_STRUCTURED_PREVIEW_CHARS) return null;
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    return null;
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return null;
    if (value.every((item) => item !== null && typeof item === "object" && !Array.isArray(item))) {
      const objects = value as Record<string, unknown>[];
      const columns: string[] = [];
      for (const object of objects.slice(0, MAX_STRUCTURED_PREVIEW_ROWS)) {
        for (const key of Object.keys(object)) {
          if (!columns.includes(key)) columns.push(key);
          if (columns.length >= MAX_STRUCTURED_PREVIEW_COLUMNS) break;
        }
        if (columns.length >= MAX_STRUCTURED_PREVIEW_COLUMNS) break;
      }
      if (columns.length === 0) return null;
      const rows = objects.slice(0, MAX_STRUCTURED_PREVIEW_ROWS).map((object) =>
        columns.map((key) => boundedCell(object[key])),
      );
      return {
        kind: "table",
        columns: columns.map((key, index) => normalizeColumn(key, `Column ${index + 1}`)),
        rows,
        truncated: value.length > MAX_STRUCTURED_PREVIEW_ROWS || Object.keys(objects[0] ?? {}).length > MAX_STRUCTURED_PREVIEW_COLUMNS,
        format: "json",
      };
    }
    return {
      kind: "table",
      columns: ["Value"],
      rows: value.slice(0, MAX_STRUCTURED_PREVIEW_ROWS).map((item) => [boundedCell(item)]),
      truncated: value.length > MAX_STRUCTURED_PREVIEW_ROWS,
      format: "json",
    };
  }

  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    const entries = Object.entries(object).slice(0, MAX_STRUCTURED_PREVIEW_ROWS);
    if (entries.length === 0) return null;
    return {
      kind: "table",
      columns: ["Key", "Value"],
      rows: entries.map(([key, item]) => [boundedCell(key), boundedCell(item)]),
      truncated: Object.keys(object).length > MAX_STRUCTURED_PREVIEW_ROWS,
      format: "json",
    };
  }
  return { kind: "table", columns: ["Value"], rows: [[boundedCell(value)]], truncated: false, format: "json" };
}

/** Return a safe table preview for supported file extensions, otherwise null. */
export function structuredPreviewForFile(path: string, content: string): StructuredPreview | null {
  switch (extension(path)) {
    case "csv":
      return parseDelimited(content, ",");
    case "tsv":
      return parseDelimited(content, "\t");
    case "json":
      return parseJson(content);
    default:
      return null;
  }
}
