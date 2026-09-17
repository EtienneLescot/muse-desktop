/**
 * Ephemeral composer attachment recovery (M1-08).
 *
 * The text draft already lives in sessionStorage. This companion keeps the
 * same lifecycle for selected attachments while bounding the serialized
 * payload. Text and small images retain their content; larger images retain
 * metadata only and are surfaced as "Reselect" rows after a reload. Nothing
 * here is sent to the host or written to localStorage.
 */

import type { ComposerAttachment } from "./attachments";

export const ATTACHMENT_DRAFT_PREFIX = "muse-desktop.attachment-draft.v1.";
/** Keep recovery values below common WebView sessionStorage quotas. */
export const MAX_ATTACHMENT_DRAFT_PAYLOAD_CHARS = 700_000;

export interface AttachmentDraftLoad {
  attachments: ComposerAttachment[];
  /** True when at least one payload was omitted due to the bound. */
  truncated: boolean;
}

interface StoredAttachment {
  id: string;
  name: string;
  mediaType: string;
  size: number;
  kind: "image" | "text";
  content?: string;
  base64Data?: string;
  width?: number;
  height?: number;
}

function sessionStore(): Storage | null {
  try {
    const candidate = (globalThis as Record<string, unknown>).sessionStorage;
    if (
      candidate !== null &&
      typeof candidate === "object" &&
      typeof (candidate as Storage).getItem === "function" &&
      typeof (candidate as Storage).setItem === "function"
    ) {
      return candidate as Storage;
    }
  } catch {
    // Private browsing and restricted webviews can deny sessionStorage.
  }
  return null;
}

function storageKey(draftKey: string): string {
  return `${ATTACHMENT_DRAFT_PREFIX}${encodeURIComponent(draftKey).slice(0, 180)}`;
}

function isStoredAttachment(value: unknown): value is StoredAttachment {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.id === "string" && row.id.length > 0 &&
    typeof row.name === "string" && row.name.length > 0 &&
    typeof row.mediaType === "string" &&
    typeof row.size === "number" && Number.isFinite(row.size) && row.size >= 0 &&
    (row.kind === "text" || row.kind === "image") &&
    (row.content === undefined || typeof row.content === "string") &&
    (row.base64Data === undefined || typeof row.base64Data === "string") &&
    (row.width === undefined || (typeof row.width === "number" && Number.isFinite(row.width))) &&
    (row.height === undefined || (typeof row.height === "number" && Number.isFinite(row.height)))
  );
}

function fromStored(row: StoredAttachment): ComposerAttachment {
  const hasPayload = row.kind === "text"
    ? typeof row.content === "string"
    : typeof row.base64Data === "string" && row.base64Data.length > 0;
  return {
    ...row,
    ...(hasPayload ? {} : { missing: true }),
  };
}

/** Parse a serialized attachment draft without ever throwing. */
export function parseAttachmentDraft(raw: string | null): AttachmentDraftLoad {
  if (raw === null || raw.length === 0) return { attachments: [], truncated: false };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return { attachments: [], truncated: false };
    const attachments: ComposerAttachment[] = [];
    let truncated = false;
    for (const value of parsed.slice(0, 8)) {
      if (!isStoredAttachment(value)) continue;
      const row = fromStored(value);
      if (row.missing === true) truncated = true;
      attachments.push(row);
    }
    return { attachments, truncated };
  } catch {
    return { attachments: [], truncated: false };
  }
}

/** Serialize rows while retaining metadata for payloads that do not fit. */
export function serializeAttachmentDraft(
  attachments: readonly ComposerAttachment[],
): { raw: string; truncated: boolean } {
  let payloadChars = 0;
  let truncated = false;
  const rows: StoredAttachment[] = attachments.slice(0, 8).map((attachment) => {
    const row: StoredAttachment = {
      id: attachment.id,
      name: attachment.name,
      mediaType: attachment.mediaType,
      size: attachment.size,
      kind: attachment.kind,
      ...(attachment.width !== undefined ? { width: attachment.width } : {}),
      ...(attachment.height !== undefined ? { height: attachment.height } : {}),
    };
    const payload = attachment.kind === "text"
      ? attachment.content
      : attachment.base64Data;
    if (payload !== undefined && payloadChars + payload.length <= MAX_ATTACHMENT_DRAFT_PAYLOAD_CHARS) {
      payloadChars += payload.length;
      if (attachment.kind === "text") row.content = payload;
      else row.base64Data = payload;
    } else if (payload !== undefined) {
      truncated = true;
    }
    return row;
  });
  return { raw: JSON.stringify(rows), truncated };
}

/** Load one conversation's ephemeral attachment draft. */
export function loadAttachmentDraft(draftKey: string): AttachmentDraftLoad {
  const store = sessionStore();
  if (store === null) return { attachments: [], truncated: false };
  try {
    return parseAttachmentDraft(store.getItem(storageKey(draftKey)));
  } catch {
    return { attachments: [], truncated: false };
  }
}

/** Persist one conversation's attachment draft; failures leave memory intact. */
export function saveAttachmentDraft(
  draftKey: string,
  attachments: readonly ComposerAttachment[],
): boolean {
  const store = sessionStore();
  if (store === null) return false;
  try {
    if (attachments.length === 0) {
      store.removeItem(storageKey(draftKey));
      return true;
    }
    store.setItem(storageKey(draftKey), serializeAttachmentDraft(attachments).raw);
    return true;
  } catch {
    return false;
  }
}
