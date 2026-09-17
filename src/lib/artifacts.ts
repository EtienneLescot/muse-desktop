/**
 * US-12 + US-21: thread summary recap + versioned artifacts.
 *
 * Dependency-light and runnable under node:test with no framework.
 *
 * - `buildThreadRecap` derives an auto recap from a thread log (message
 *   counts per role, files mentioned, decision-like lines). Local and
 *   extractive, like compact.ts — no model call.
 * - Assistant fenced code blocks (```lang … ```) are extracted as
 *   artifacts. Blocks tagged with a prose language (md/markdown/txt/text
 *   or untagged) become `doc` artifacts, the rest become `code`.
 * - Blocks sharing (kind, lang) across assistant messages of one thread
 *   accumulate as versions v1..vN of a single artifact; identical
 *   re-emissions do not create a new version.
 * - Each version carries an anchored `comment` (persisted with the
 *   artifact). Restoring a version means copying its text into the
 *   composer via the US-4 prefill plumbing (see the hook).
 *
 * Persisted per thread under `muse-desktop.artifacts.v1.<sessionId>`.
 */

import { readStorageJson, removeStorageKey, writeStorageJson } from "./storage.ts";

/** Minimal log shape (structural: accepts persist.ts LogEntry). */
export interface ArtifactLogEntry {
  id: string;
  role: string;
  text: string;
}

export type ArtifactKind = "code" | "doc";

export interface ArtifactVersion {
  /** 1-based position within the artifact (v1..vN, renumbered on prune). */
  v: number;
  text: string;
  lang: string;
  createdAt: number;
  /** Assistant log entry this version was extracted from. */
  sourceEntryId: string;
  /** Anchored per-version comment (user note, persisted). */
  comment: string;
}

export interface Artifact {
  id: string;
  sessionId: string;
  title: string;
  kind: ArtifactKind;
  lang: string;
  versions: ArtifactVersion[];
  createdAt: number;
  updatedAt: number;
}

export interface ExtractedBlock {
  kind: ArtifactKind;
  lang: string;
  title: string;
  text: string;
}

export interface ThreadRecap {
  sessionId: string;
  total: number;
  counts: {
    user: number;
    assistant: number;
    subagent: number;
    tool: number;
    system: number;
  };
  filesMentioned: string[];
  decisions: string[];
}

/** Max versions kept per artifact (oldest pruned, survivors renumbered). */
export const MAX_VERSIONS_PER_ARTIFACT = 20;

/** Max artifacts kept per thread (oldest pruned past the cap). */
export const MAX_ARTIFACTS_PER_THREAD = 50;

/** Max items kept per recap section. */
export const MAX_RECAP_ITEMS = 12;

/** Max chars kept per recap line. */
export const MAX_RECAP_LINE = 200;

/** Languages treated as prose (`doc`), including the untagged fence. */
const DOC_LANGS = new Set(["", "md", "markdown", "txt", "text", "rst"]);

/** File extensions recognized when scanning for mentioned files. */
const FILE_EXT =
  "tsx|ts|jsx|js|mjs|cjs|py|rs|go|java|rb|php|css|scss|html|json|yaml|yml|toml|md|txt|sh|sql|xml|vue|svelte";

const FILE_RE = new RegExp(
  `(?:^|[\\s"'\\\`\\(\\[])([\\w.\\-~][\\w.\\-/]*\\.(${FILE_EXT})(?![\\w-])|(?:[\\w.\\-]+(?:\\/[\\w.\\-]+)+\\.\\w+))`,
  "g",
);

const DECISION_RE =
  /décision|decision|decided|décidé|approved|approuv|conclu|retenu|choisi|choice|outcome/i;

function clip(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

function newArtifactId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
  }
}

/**
 * Extract fenced blocks from one assistant message. Unclosed fences are
 * ignored. Returns blocks in source order.
 */
export function extractBlocks(text: string): ExtractedBlock[] {
  const out: ExtractedBlock[] = [];
  const re = /```(\w*)\s*\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const lang = (m[1] ?? "").toLowerCase();
    const body = (m[2] ?? "").replace(/\s+$/g, "");
    if (body.length === 0) continue;
    const kind: ArtifactKind = DOC_LANGS.has(lang) ? "doc" : "code";
    const firstLine = body.split("\n").find((l) => l.trim().length > 0) ?? "";
    const title =
      firstLine.length > 0
        ? clip(firstLine, 80)
        : `${lang !== "" ? lang : "text"} ${kind} block`;
    out.push({ kind, lang, title, text: body });
  }
  return out;
}

/**
 * Grouping key: same kind + lang = new version of one artifact. A refined
 * snippet usually rewrites its first line too, so the title (kept from the
 * creating block) cannot be part of the key; distinct languages stay apart.
 */
function blockKey(b: Pick<ExtractedBlock, "kind" | "lang">): string {
  return `${b.kind}:${b.lang}`;
}

function artifactKey(a: Artifact): string {
  return `${a.kind}:${a.lang}`;
}

export interface AssistantMessage {
  entryId: string;
  text: string;
  ts: number;
}

/**
 * Merge assistant-message blocks into existing artifacts (pure: inputs are
 * never mutated). Idempotent: re-merging the same messages changes nothing
 * (entries whose id already anchors a version are skipped, and a block
 * identical to the latest version adds no version).
 */
export function mergeAssistantBlocks(
  existing: Artifact[],
  sessionId: string,
  messages: AssistantMessage[],
  now: number = Date.now(),
): Artifact[] {
  const processed = new Set<string>();
  for (const a of existing) {
    for (const ver of a.versions) processed.add(ver.sourceEntryId);
  }
  let next: Artifact[] = existing.map((a) => ({
    ...a,
    versions: a.versions.map((v) => ({ ...v })),
  }));
  const byKey = new Map<string, Artifact>();
  for (const a of next) byKey.set(artifactKey(a), a);

  for (const msg of messages) {
    if (processed.has(msg.entryId)) continue;
    processed.add(msg.entryId);
    for (const b of extractBlocks(msg.text)) {
      const key = blockKey(b);
      const found = byKey.get(key);
      if (found !== undefined) {
        const latest = found.versions[found.versions.length - 1];
        if (latest !== undefined && latest.text === b.text) continue;
        found.versions = [
          ...found.versions,
          {
            v: found.versions.length + 1,
            text: b.text,
            lang: b.lang,
            createdAt: msg.ts > 0 ? msg.ts : now,
            sourceEntryId: msg.entryId,
            comment: "",
          },
        ].slice(-MAX_VERSIONS_PER_ARTIFACT);
        found.versions.forEach((ver, i) => {
          ver.v = i + 1;
        });
        found.updatedAt = now;
      } else {
        const created = msg.ts > 0 ? msg.ts : now;
        const artifact: Artifact = {
          id: newArtifactId(),
          sessionId,
          title: b.title,
          kind: b.kind,
          lang: b.lang,
          versions: [
            {
              v: 1,
              text: b.text,
              lang: b.lang,
              createdAt: created,
              sourceEntryId: msg.entryId,
              comment: "",
            },
          ],
          createdAt: created,
          updatedAt: now,
        };
        next = [...next, artifact];
        byKey.set(key, artifact);
      }
    }
  }
  if (next.length > MAX_ARTIFACTS_PER_THREAD) {
    const keep = next.slice(-MAX_ARTIFACTS_PER_THREAD);
    const ids = new Set(keep.map((a) => a.id));
    for (const a of next) {
      if (!ids.has(a.id)) byKey.delete(artifactKey(a));
    }
    next = keep;
  }
  return next;
}

/** Text of one version (the restore payload for the composer prefill). */
export function findVersionText(
  artifacts: Artifact[],
  artifactId: string,
  v: number,
): string | null {
  const a = artifacts.find((x) => x.id === artifactId);
  if (a === undefined) return null;
  const ver = a.versions.find((x) => x.v === v);
  return ver !== undefined ? ver.text : null;
}

/**
 * Set the anchored comment of one version (pure: returns a new array,
 * inputs untouched). Unknown artifact/version ids leave the list equal.
 */
export function setVersionComment(
  artifacts: Artifact[],
  artifactId: string,
  v: number,
  comment: string,
): Artifact[] {
  return artifacts.map((a) => {
    if (a.id !== artifactId) return a;
    return {
      ...a,
      versions: a.versions.map((ver) =>
        ver.v === v ? { ...ver, comment } : ver,
      ),
    };
  });
}

/**
 * Build the auto thread recap for the summary tab: per-role counts, files
 * mentioned (deduped, order-kept), decision-like lines.
 */
export function buildThreadRecap(
  sessionId: string,
  log: ArtifactLogEntry[],
): ThreadRecap {
  const counts = { user: 0, assistant: 0, subagent: 0, tool: 0, system: 0 };
  const files: string[] = [];
  const decisions: string[] = [];

  for (const e of log) {
    if (e.role === "user") counts.user += 1;
    else if (e.role === "assistant") counts.assistant += 1;
    else if (e.role === "subagent") counts.subagent += 1;
    else if (e.role === "tool") counts.tool += 1;
    else if (e.role === "system") counts.system += 1;

    const text = e.text;
    if (text.trim().length === 0) continue;

    FILE_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = FILE_RE.exec(text)) !== null) {
      const f = m[1].replace(/^[./]+/, "");
      if (f.length > 0 && !files.includes(f) && files.length < MAX_RECAP_ITEMS) {
        files.push(f);
      }
    }

    // Tool/system lines record outcomes (approvals, input answers), like
    // compact.ts isDecisionLike; other roles need a decision keyword.
    const decisionLike =
      e.role === "tool" || e.role === "system"
        ? true
        : DECISION_RE.test(text);
    if (decisions.length < MAX_RECAP_ITEMS && decisionLike) {
      const clipped = clip(text, MAX_RECAP_LINE);
      if (!decisions.includes(clipped)) decisions.push(clipped);
    }
  }

  return { sessionId, total: log.length, counts, filesMentioned: files, decisions };
}

const artifactsKey = (sessionId: string) =>
  `muse-desktop.artifacts.v1.${sessionId}`;

function read<T>(key: string, fallback: T): T {
  return readStorageJson(key, fallback);
}

function write(key: string, value: unknown): void {
  writeStorageJson(key, value);
}

function isValidVersion(v: unknown): v is ArtifactVersion {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.v === "number" &&
    typeof r.text === "string" &&
    typeof r.lang === "string" &&
    typeof r.createdAt === "number" &&
    typeof r.sourceEntryId === "string" &&
    typeof r.comment === "string"
  );
}

function isValidArtifact(a: unknown): a is Artifact {
  if (typeof a !== "object" || a === null) return false;
  const r = a as Record<string, unknown>;
  return (
    typeof r.id === "string" &&
    r.id.length > 0 &&
    typeof r.sessionId === "string" &&
    typeof r.title === "string" &&
    (r.kind === "code" || r.kind === "doc") &&
    typeof r.lang === "string" &&
    Array.isArray(r.versions) &&
    (r.versions as unknown[]).every(isValidVersion) &&
    (r.versions as unknown[]).length > 0 &&
    typeof r.createdAt === "number" &&
    typeof r.updatedAt === "number"
  );
}

export function loadArtifacts(sessionId: string): Artifact[] {
  const raw = read<unknown>(artifactsKey(sessionId), []);
  if (!Array.isArray(raw)) return [];
  return raw.filter(isValidArtifact).slice(-MAX_ARTIFACTS_PER_THREAD);
}

export function saveArtifacts(sessionId: string, artifacts: Artifact[]): void {
  write(artifactsKey(sessionId), artifacts.slice(-MAX_ARTIFACTS_PER_THREAD));
}

export function dropArtifacts(sessionId: string): void {
  removeStorageKey(artifactsKey(sessionId));
}
