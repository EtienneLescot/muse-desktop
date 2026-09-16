/**
 * M1-08 attachment intake for the composer.
 *
 * The embedded Muse schema exposes only `text`, `image` and `skill` turn
 * input parts. Text files therefore become explicitly labelled text parts;
 * images retain their MIME and base64 payload and are sent as real image
 * parts. This module stays browser-only and is deliberately independent of
 * React so limits and serialization can be tested without a webview.
 */

export const MAX_ATTACHMENTS = 8;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_TEXT_BYTES = 512 * 1024;
export const MAX_TEXT_CHARS = 120_000;

export type TurnInputPart =
  | { type: "text"; text: string }
  | {
      type: "image";
      mediaType: string;
      base64Data: string;
      width?: number;
      height?: number;
    };

export interface ComposerAttachment {
  id: string;
  name: string;
  mediaType: string;
  size: number;
  kind: "image" | "text";
  content?: string;
  base64Data?: string;
}

export interface AttachmentFailure {
  name: string;
  message: string;
}

const TEXT_EXTENSIONS = new Set([
  "c",
  "cc",
  "cpp",
  "css",
  "csv",
  "go",
  "h",
  "hpp",
  "html",
  "ini",
  "java",
  "js",
  "json",
  "jsx",
  "md",
  "mdx",
  "mjs",
  "py",
  "rb",
  "rs",
  "sh",
  "sql",
  "swift",
  "toml",
  "ts",
  "tsx",
  "txt",
  "xml",
  "yaml",
  "yml",
]);

function extension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
}

export function isTextAttachment(file: Pick<File, "name" | "type">): boolean {
  return file.type.startsWith("text/") || TEXT_EXTENSIONS.has(extension(file.name));
}

function readAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("could not read the file"));
    reader.onabort = () => reject(new Error("file reading was cancelled"));
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
    reader.readAsText(file);
  });
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("could not read the image"));
    reader.onabort = () => reject(new Error("image reading was cancelled"));
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
    reader.readAsDataURL(file);
  });
}

function attachmentId(file: File): string {
  return `${file.name}:${file.size}:${file.lastModified}:${file.type}`;
}

function imagePayload(dataUrl: string, mediaType: string): string {
  const comma = dataUrl.indexOf(",");
  if (comma < 0 || !dataUrl.slice(0, comma).toLowerCase().includes(";base64")) {
    throw new Error("image data is not base64 encoded");
  }
  const payload = dataUrl.slice(comma + 1);
  if (payload.length === 0) throw new Error("image data is empty");
  const header = dataUrl.slice(0, comma);
  const declared = /^data:([^;]+);base64$/i.exec(header)?.[1] ?? mediaType;
  if (!declared.startsWith("image/")) throw new Error("attachment is not an image");
  return payload;
}

/** Read one browser file into a bounded, protocol-ready draft. */
export async function readAttachment(file: File): Promise<ComposerAttachment> {
  if (file.size <= 0) throw new Error("the file is empty");
  if (file.type.startsWith("image/")) {
    if (file.size > MAX_IMAGE_BYTES) {
      throw new Error(`image exceeds the ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)} MB limit`);
    }
    const mediaType = file.type.toLowerCase();
    const base64Data = imagePayload(await readAsDataUrl(file), mediaType);
    return { id: attachmentId(file), name: file.name, mediaType, size: file.size, kind: "image", base64Data };
  }
  if (!isTextAttachment(file)) {
    throw new Error("only text files and images can be attached");
  }
  if (file.size > MAX_TEXT_BYTES) {
    throw new Error(`text file exceeds the ${Math.round(MAX_TEXT_BYTES / 1024)} KB limit`);
  }
  const content = await readAsText(file);
  if (content.includes("\0")) throw new Error("binary content cannot be attached as text");
  if (content.length > MAX_TEXT_CHARS) {
    throw new Error(`text file exceeds the ${MAX_TEXT_CHARS.toLocaleString()} character limit`);
  }
  return {
    id: attachmentId(file),
    name: file.name,
    mediaType: file.type || "text/plain",
    size: file.size,
    kind: "text",
    content,
  };
}

/**
 * Convert the composer draft to the exact stable MSP input parts. The first
 * part is always the prompt; attached text is labelled and images remain
 * binary image parts. No local path is sent as a pretend file attachment.
 */
export function buildTurnInputParts(
  text: string,
  attachments: ComposerAttachment[],
): TurnInputPart[] {
  const parts: TurnInputPart[] = text.trim().length > 0 ? [{ type: "text", text }] : [];
  for (const attachment of attachments) {
    if (attachment.kind === "text" && attachment.content !== undefined) {
      parts.push({
        type: "text",
        text: `\n\n<attached-file name="${escapeAttribute(attachment.name)}" media-type="${escapeAttribute(attachment.mediaType)}">\n${attachment.content}\n</attached-file>`,
      });
    } else if (attachment.kind === "image" && attachment.base64Data !== undefined) {
      parts.push({ type: "image", mediaType: attachment.mediaType, base64Data: attachment.base64Data });
    }
  }
  return parts;
}

function escapeAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function attachmentKey(attachments: ComposerAttachment[]): string {
  return attachments.map((a) => a.id).join("|");
}
