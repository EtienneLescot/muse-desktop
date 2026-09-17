/**
 * Bounded previews for the three common Office Open XML containers.
 *
 * This is a read-only inspection helper. It never evaluates macros, formulas,
 * relationships or embedded media. XML is treated as text and only a small
 * allowlist of document parts is extracted from an archive capped by the
 * caller's file-read boundary.
 */
import { strFromU8, unzipSync } from "fflate";

export const MAX_OFFICE_PREVIEW_BYTES = 5 * 1024 * 1024;
export const MAX_OFFICE_PREVIEW_ROWS = 100;
export const MAX_OFFICE_PREVIEW_COLUMNS = 20;
export const MAX_OFFICE_XML_CHARS = 1_000_000;
/** Never inflate more XML than the parser can inspect, even when a ZIP entry
 * advertises a much larger uncompressed size than the compressed payload. */
export const MAX_OFFICE_ENTRY_BYTES = MAX_OFFICE_XML_CHARS * 4;
export const MAX_OFFICE_ARCHIVE_BYTES = MAX_OFFICE_ENTRY_BYTES * 2;
export const MAX_OFFICE_ARCHIVE_ENTRIES = 500;

export type OfficeFormat = "docx" | "xlsx" | "pptx";

export interface OfficePreview {
  kind: "table";
  format: OfficeFormat;
  columns: string[];
  rows: string[][];
  truncated: boolean;
}

function extension(path: string): OfficeFormat | null {
  const name = path.split(/[\\/]/).pop() ?? path;
  const value = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  return value === "docx" || value === "xlsx" || value === "pptx" ? value : null;
}

function decodeBase64(value: string): Uint8Array | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  try {
    const binary = atob(trimmed);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    return null;
  }
}

function xmlPart(archive: Record<string, Uint8Array>, name: string): string | null {
  const bytes = archive[name];
  if (!bytes || bytes.length > MAX_OFFICE_XML_CHARS * 4) return null;
  const xml = strFromU8(bytes);
  return xml.length > MAX_OFFICE_XML_CHARS ? xml.slice(0, MAX_OFFICE_XML_CHARS) : xml;
}

function decodeXmlText(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => {
      const point = Number.parseInt(code, 16);
      return Number.isFinite(point) ? String.fromCodePoint(Math.min(point, 0x10ffff)) : "";
    })
    .replace(/&#(\d+);/g, (_, code: string) => {
      const point = Number.parseInt(code, 10);
      return Number.isFinite(point) ? String.fromCodePoint(Math.min(point, 0x10ffff)) : "";
    })
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function textTags(xml: string, tag: string): string[] {
  const pattern = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "gi");
  return Array.from(xml.matchAll(pattern), (match) => decodeXmlText(match[1] ?? ""))
    .filter((text) => text.length > 0);
}

function boundedCell(value: unknown): string {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > 400 ? `${text.slice(0, 400)}…` : text;
}

function boundedRows(
  rows: string[][],
  format: OfficeFormat,
  columns?: string[],
  truncated = false,
): OfficePreview | null {
  if (rows.length === 0 && (!columns || columns.length === 0)) return null;
  const width = Math.min(
    MAX_OFFICE_PREVIEW_COLUMNS,
    Math.max(1, columns?.length ?? 0, ...rows.map((row) => row.length)),
  );
  const headers = Array.from({ length: width }, (_, index) =>
    boundedCell(columns?.[index] || `Column ${index + 1}`),
  );
  return {
    kind: "table",
    format,
    columns: headers,
    rows: rows.slice(0, MAX_OFFICE_PREVIEW_ROWS).map((row) =>
      Array.from({ length: width }, (_, index) => boundedCell(row[index] ?? "")),
    ),
    truncated: truncated || rows.length > MAX_OFFICE_PREVIEW_ROWS || (columns?.length ?? 0) > width,
  };
}

function parseDocx(archive: Record<string, Uint8Array>): OfficePreview | null {
  const xml = xmlPart(archive, "word/document.xml");
  if (!xml) return null;
  const paragraphs = Array.from(xml.matchAll(/<w:p\b[^>]*>([\s\S]*?)<\/w:p>/gi), (match) =>
    textTags(match[1] ?? "", "w:t").join(""),
  ).filter((text) => text.length > 0);
  return boundedRows(paragraphs.map((text) => [text]), "docx", ["Paragraph"]);
}

function columnIndex(reference: string): number | null {
  const letters = /^[A-Z]+/i.exec(reference)?.[0].toUpperCase();
  if (!letters) return null;
  let result = 0;
  for (const letter of letters) result = result * 26 + letter.charCodeAt(0) - 64;
  return result - 1;
}

function parseXlsx(archive: Record<string, Uint8Array>): OfficePreview | null {
  const namesXml = xmlPart(archive, "xl/sharedStrings.xml");
  const shared = namesXml
    ? Array.from(namesXml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/gi), (match) =>
      textTags(match[1] ?? "", "t").join(""),
    )
    : [];
  const sheetName = Object.keys(archive)
    .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(name))
    .sort()[0];
  if (!sheetName) return null;
  const xml = xmlPart(archive, sheetName);
  if (!xml) return null;
  const rows: string[][] = [];
  let truncated = false;
  for (const rowMatch of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/gi)) {
    const cells: string[] = [];
    for (const cellMatch of (rowMatch[1] ?? "").matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/gi)) {
      const attributes = cellMatch[1] ?? "";
      const body = cellMatch[2] ?? "";
      const reference = /\br\s*=\s*["']([^"']+)["']/i.exec(attributes)?.[1] ?? "";
      const index = columnIndex(reference);
      if (index === null || index >= MAX_OFFICE_PREVIEW_COLUMNS) {
        truncated = true;
        continue;
      }
      const type = /\bt\s*=\s*["']([^"']+)["']/i.exec(attributes)?.[1] ?? "";
      const raw = textTags(body, type === "inlineStr" ? "t" : "v")[0] ?? "";
      const value = type === "s" ? shared[Number.parseInt(raw, 10)] ?? raw : raw;
      while (cells.length <= index) cells.push("");
      cells[index] = value;
    }
    if (cells.some((cell) => cell.length > 0)) rows.push(cells);
    if (rows.length >= MAX_OFFICE_PREVIEW_ROWS + 1) {
      truncated = true;
      break;
    }
  }
  if (rows.length === 0) return null;
  const header = rows.shift() ?? [];
  return boundedRows(rows, "xlsx", header, truncated);
}

function parsePptx(archive: Record<string, Uint8Array>): OfficePreview | null {
  const slides = Object.keys(archive)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const rows: string[][] = [];
  let truncated = false;
  for (const [index, name] of slides.entries()) {
    const xml = xmlPart(archive, name);
    if (!xml) continue;
    const text = textTags(xml, "a:t").join(" ");
    if (text) rows.push([String(index + 1), text]);
    if (rows.length >= MAX_OFFICE_PREVIEW_ROWS) {
      truncated = slides.length > rows.length;
      break;
    }
  }
  return boundedRows(rows, "pptx", ["Slide", "Text"], truncated);
}

function isPreviewPart(format: OfficeFormat, name: string): boolean {
  if (format === "docx") return name === "word/document.xml";
  if (format === "xlsx") {
    return name === "xl/sharedStrings.xml" || /^xl\/worksheets\/sheet\d+\.xml$/i.test(name);
  }
  return /^ppt\/slides\/slide\d+\.xml$/i.test(name);
}

/** Parse one bounded DOCX/XLSX/PPTX payload into a safe table preview. */
export function officePreviewForFile(path: string, base64Data: string): OfficePreview | null {
  const format = extension(path);
  if (!format) return null;
  const bytes = decodeBase64(base64Data);
  if (!bytes || bytes.length === 0 || bytes.length > MAX_OFFICE_PREVIEW_BYTES) return null;
  let archive: Record<string, Uint8Array>;
  let entryCount = 0;
  let extractedBytes = 0;
  let rejectedEntry = false;
  try {
    archive = unzipSync(bytes, {
      // Office containers include many relationships, thumbnails and media
      // parts. They are not needed for a text preview and must never be
      // inflated into renderer memory.
      filter: (entry) => {
        entryCount += 1;
        if (entryCount > MAX_OFFICE_ARCHIVE_ENTRIES) {
          rejectedEntry = true;
          return false;
        }
        if (!isPreviewPart(format, entry.name)) return false;
        const size = entry.originalSize;
        if (!Number.isSafeInteger(size) || size < 0 || size > MAX_OFFICE_ENTRY_BYTES) {
          rejectedEntry = true;
          return false;
        }
        if (extractedBytes + size > MAX_OFFICE_ARCHIVE_BYTES) {
          rejectedEntry = true;
          return false;
        }
        extractedBytes += size;
        return true;
      },
    });
  } catch {
    return null;
  }
  if (rejectedEntry || Object.keys(archive).length > MAX_OFFICE_ARCHIVE_ENTRIES) return null;
  if (format === "docx") return parseDocx(archive);
  if (format === "xlsx") return parseXlsx(archive);
  return parsePptx(archive);
}
