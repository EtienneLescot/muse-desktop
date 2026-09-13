/**
 * US-33: classify backend sidecar/startup failures so the UI shows an
 * explicit message (never a blank screen). Pure helpers, unit-tested.
 *
 * The Rust supervisor surfaces startup failures as `invoke` errors:
 * - missing binary: `sidecar binary not found … (tried <a>, <b>)`
 * - spawn failure: `could not spawn sidecar …` / `sidecar command failed …`
 * - dead handshake: `MSP handshake failed …`
 * The hook prefixes them (`start_session failed: …`), so matching is
 * substring-based and never throws.
 */

export type SidecarErrorKind = "missing" | "start-failed";

/** True when `message` is a sidecar startup failure of any kind. */
export function isSidecarError(message: string | null | undefined): boolean {
  return classifySidecarError(message) !== null;
}

/**
 * Classify a sidecar startup failure: `missing` (binary absent — expected
 * triple-suffixed paths are listed) vs `start-failed` (binary present but
 * spawn/handshake died). Returns null for unrelated errors.
 */
export function classifySidecarError(
  message: string | null | undefined,
): SidecarErrorKind | null {
  if (!message) return null;
  const m = message.toLowerCase();
  if (m.includes("sidecar binary not found")) return "missing";
  if (
    m.includes("could not spawn sidecar") ||
    m.includes("sidecar command failed") ||
    m.includes("msp handshake failed") ||
    m.includes("no sidecar host")
  ) {
    return "start-failed";
  }
  return null;
}

/**
 * Best-effort extraction of the probed paths from a missing-binary message
 * (`… (tried <a>, <b>) …`). Returns [] when the message carries none.
 */
export function extractTriedPaths(message: string): string[] {
  const m = /\(tried ([^)]+)\)/.exec(message);
  if (!m) return [];
  return m[1]
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
