/**
 * US-27 thread sharing + US-28 channel stub: pure share-bundle logic.
 *
 * - A thread is shared via an exportable *bundle*: a local snapshot of the
 *   session log rendered as markdown or JSON, addressable by a local bundle
 *   id (`share-<short>`). "Copy link" copies that local id; there is no
 *   remote host, so a revoked bundle resolves to null (the local equivalent
 *   of a 404 after un-share).
 * - Share modes (OpenCode §3.10: manual default / auto / disabled):
 *   manual = share only on explicit action, auto = eligible for auto-share
 *   on turn end, disabled = sharing refused (share calls return null).
 * - US-28 channels (Zed-like persistent co-editing) are transport-
 *   unspecified ([TROU] SPEC §3.10: CRDT/relay internals never inspected),
 *   so this module ships only an explicit experimental stub behind a flag
 *   with an honest "not connected" state — no fake realtime.
 *
 * Dependency-free (no imports): unit-tested under `node:test`.
 * Persistence lives under `muse-desktop.sharing.v1` (mode + bundles);
 * the helpers below touch only the `localStorage` global (best-effort).
 */

export type ShareMode = "manual" | "auto" | "disabled";

export type BundleFormat = "markdown" | "json";

/** Minimal log shape needed to render a bundle (subset of LogEntry). */
export interface ShareableEntry {
  role: string;
  text: string;
  ts: number;
}

/** One exported thread snapshot. `revoked=true` = un-shared (404). */
export interface ShareBundle {
  bundleId: string;
  sessionId: string;
  title: string;
  format: BundleFormat;
  createdAt: number;
  revoked: boolean;
  body: string;
}

export interface ShareState {
  mode: ShareMode;
  bundles: Record<string, ShareBundle>;
}

/** Default mode (mirrors OpenCode `/share` default: manual). */
export const DEFAULT_SHARE_MODE: ShareMode = "manual";

/**
 * US-28: co-editing channels are an explicit experimental stub. The flag
 * defaults to off; even when on, the transport is unspecified so the
 * channel reports "not connected" — never a fake live session.
 */
export const CHANNELS_EXPERIMENTAL = false;
export const CHANNEL_STATUS_OFF = "disabled";
export const CHANNEL_STATUS_NOT_CONNECTED = "not connected";

export interface ChannelStub {
  enabled: boolean;
  connected: false;
  status: string;
}

export function describeChannel(experimentalFlag: boolean): ChannelStub {
  if (!experimentalFlag) {
    return { enabled: false, connected: false, status: CHANNEL_STATUS_OFF };
  }
  return { enabled: true, connected: false, status: CHANNEL_STATUS_NOT_CONNECTED };
}

export function isShareMode(v: unknown): v is ShareMode {
  return v === "manual" || v === "auto" || v === "disabled";
}

/** Empty share state (fresh profile / corrupt storage fallback). */
export function emptyShareState(): ShareState {
  return { mode: DEFAULT_SHARE_MODE, bundles: {} };
}

function isValidBundle(b: unknown): b is ShareBundle {
  if (typeof b !== "object" || b === null) return false;
  const r = b as Record<string, unknown>;
  return (
    typeof r.bundleId === "string" &&
    r.bundleId.length > 0 &&
    typeof r.sessionId === "string" &&
    typeof r.title === "string" &&
    (r.format === "markdown" || r.format === "json") &&
    typeof r.createdAt === "number" &&
    typeof r.revoked === "boolean" &&
    typeof r.body === "string"
  );
}

function readKey(key: string): unknown {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return null;
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function writeKey(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // best-effort like persist.ts
  }
}

export const SHARING_KEY = "muse-desktop.sharing.v1";

export function loadShareState(): ShareState {
  const raw = readKey(SHARING_KEY);
  if (typeof raw !== "object" || raw === null) return emptyShareState();
  const r = raw as Record<string, unknown>;
  const mode = isShareMode(r.mode) ? r.mode : DEFAULT_SHARE_MODE;
  const bundles: Record<string, ShareBundle> = {};
  if (typeof r.bundles === "object" && r.bundles !== null) {
    for (const [k, v] of Object.entries(r.bundles as Record<string, unknown>)) {
      if (isValidBundle(v)) bundles[k] = v;
    }
  }
  return { mode, bundles };
}

export function saveShareState(state: ShareState): void {
  writeKey(SHARING_KEY, state);
}

/** Local bundle id: `share-<8 base36>`; `rand` is injectable for tests. */
export function makeBundleId(rand: () => number = Math.random): string {
  const n = Math.floor(rand() * 36 ** 8);
  return `share-${n.toString(36).padStart(8, "0")}`;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Render a thread snapshot as markdown (download / copy body). */
export function buildBundleMarkdown(
  sessionId: string,
  title: string,
  log: ShareableEntry[],
): string {
  const lines: string[] = [
    `# ${title || sessionId.slice(0, 8)}`,
    "",
    `_Session ${sessionId}, exported ${new Date().toISOString()}_`,
    "",
  ];
  for (const e of log) {
    const text = e.text.trim();
    if (text.length === 0) continue;
    lines.push(`## ${e.role}`, "", text, "");
  }
  return lines.join("\n").trimEnd() + "\n";
}

/** Render a thread snapshot as JSON (download / copy body). */
export function buildBundleJson(
  sessionId: string,
  title: string,
  log: ShareableEntry[],
): string {
  return (
    JSON.stringify(
      {
        sessionId,
        title,
        exportedAt: new Date().toISOString(),
        entries: log.map((e) => ({ role: e.role, text: e.text, ts: e.ts })),
      },
      null,
      2,
    ) + "\n"
  );
}

export function buildBundleBody(
  format: BundleFormat,
  sessionId: string,
  title: string,
  log: ShareableEntry[],
): string {
  return format === "json"
    ? buildBundleJson(sessionId, title, log)
    : buildBundleMarkdown(sessionId, title, log);
}

/** Bundles for one session, newest first, excluding revoked ones. */
export function listSessionBundles(state: ShareState, sessionId: string): ShareBundle[] {
  return Object.values(state.bundles)
    .filter((b) => b.sessionId === sessionId && !b.revoked)
    .sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * Share a thread: snapshot the log into a bundle. Returns null (no bundle)
 * when sharing is disabled, or when there is nothing to share (empty log).
 * Never mutates the input state.
 */
export function shareThread(
  state: ShareState,
  sessionId: string,
  title: string,
  log: ShareableEntry[],
  format: BundleFormat,
  opts?: { now?: number; rand?: () => number },
): { state: ShareState; bundle: ShareBundle } | null {
  if (state.mode === "disabled") return null;
  if (log.length === 0) return null;
  const bundle: ShareBundle = {
    bundleId: makeBundleId(opts?.rand),
    sessionId,
    title: oneLine(title) || `Session ${sessionId.slice(0, 8)}`,
    format,
    createdAt: opts?.now ?? Date.now(),
    revoked: false,
    body: buildBundleBody(format, sessionId, title, log),
  };
  return {
    state: { ...state, bundles: { ...state.bundles, [bundle.bundleId]: bundle } },
    bundle,
  };
}

/**
 * True when the current mode allows auto-sharing this turn end
 * (US-27 AC: auto/disabled respected — manual never auto-shares).
 */
export function shouldAutoShare(state: ShareState): boolean {
  return state.mode === "auto";
}

/**
 * Un-share: mark the bundle revoked (local 404). Unknown ids are a no-op
 * returning the state unchanged. Never deletes: revocation stays visible
 * in history as revoked.
 */
export function revokeBundle(state: ShareState, bundleId: string): ShareState {
  const cur = state.bundles[bundleId];
  if (!cur || cur.revoked) return state;
  return {
    ...state,
    bundles: { ...state.bundles, [bundleId]: { ...cur, revoked: true } },
  };
}

/**
 * Resolve a copied bundle link id. Returns the bundle, or null when the id
 * is unknown or was revoked (the local equivalent of a 404 after un-share).
 */
export function resolveBundle(state: ShareState, bundleId: string): ShareBundle | null {
  const cur = state.bundles[bundleId];
  if (!cur || cur.revoked) return null;
  return cur;
}

/** Switch share mode (toggle in the panel). Bundles are kept. */
export function setShareMode(state: ShareState, mode: ShareMode): ShareState {
  if (state.mode === mode) return state;
  return { ...state, mode };
}
