/** Normalize additive host shapes for streamed transcript chunks.
 *
 * The Rust bridge normally emits `{ text, itemId }`, but older and newer
 * hosts may use `delta`, `content`, `message`, or a nested `item` snapshot.
 * Keeping this parser pure lets the renderer keep one lane/SSOT path and
 * prevents transport JSON from leaking into the conversation transcript.
 */

export interface ParsedStreamChunk {
  itemId?: string;
  turnId?: string;
  outputRef?: string;
  text: string;
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.length > 0 ? value : undefined;
}

function textValue(value: unknown): string | undefined {
  const direct = nonEmptyString(value);
  if (direct !== undefined) return direct;
  if (Array.isArray(value)) {
    const parts = value
      .map((part) => nonEmptyString(part))
      .filter((part): part is string => part !== undefined);
    return parts.length > 0 ? parts.join("\n") : undefined;
  }
  return undefined;
}

function field(obj: Record<string, unknown>, nested: Record<string, unknown> | null, ...keys: string[]): unknown {
  for (const key of keys) {
    if (obj[key] !== undefined) return obj[key];
    if (nested?.[key] !== undefined) return nested[key];
  }
  return undefined;
}

/** Parse a bounded JSON or plain-text stream payload without throwing. */
export function parseStreamChunk(payload: string): ParsedStreamChunk {
  const trimmed = payload.trim();
  if (!trimmed.startsWith("{")) return { text: payload };
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { text: payload };
    }
    const obj = parsed as Record<string, unknown>;
    const nested = typeof obj.item === "object" && obj.item !== null && !Array.isArray(obj.item)
      ? obj.item as Record<string, unknown>
      : null;
    const itemIdValue = field(obj, nested, "itemId", "item_id", "id");
    const turnIdValue = field(obj, nested, "turnId", "turn_id");
    const outputRefValue = field(obj, nested, "outputRef", "output_ref");
    const itemId = typeof itemIdValue === "string" && itemIdValue.trim() !== ""
      ? itemIdValue.trim()
      : undefined;
    const turnId = typeof turnIdValue === "string" && turnIdValue.trim() !== ""
      ? turnIdValue.trim()
      : undefined;
    const outputRef = typeof outputRefValue === "string" && outputRefValue.trim() !== ""
      ? outputRefValue.trim()
      : undefined;
    const text = textValue(field(obj, nested, "text", "delta", "content", "output", "message", "summary")) ?? "";
    return {
      ...(itemId === undefined ? {} : { itemId }),
      ...(turnId === undefined ? {} : { turnId }),
      ...(outputRef === undefined ? {} : { outputRef }),
      text,
    };
  } catch {
    return { text: payload };
  }
}
