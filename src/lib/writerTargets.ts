/** Durable, workspace-scoped declarations for the M2-08 writer pre-flight. */

import { readStorageJson, writeStorageJson } from "./storage.ts";

export const WRITER_TARGETS_KEY = "muse-desktop.writer-targets.v1";
export const MAX_WRITER_TARGET_WORKSPACES = 40;
export const MAX_WRITER_TARGET_AGENTS = 64;
export const MAX_WRITER_TARGET_TEXT = 4_000;

export type WriterTargetMap = Record<string, string>;
export type WriterTargetStore = Record<string, WriterTargetMap>;

function cleanWorkspace(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const workspace = value.trim();
  return workspace.length > 0 && workspace.length <= 1_000 ? workspace : null;
}

function cleanAgent(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const agent = value.trim();
  return agent.length > 0 && agent.length <= 160 ? agent : null;
}

/** Preserve the editable declaration, but keep storage bounded and scalar. */
export function normalizeWriterTargetText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (text.length === 0) return "";
  return text.slice(0, MAX_WRITER_TARGET_TEXT);
}

/** Defensively normalize one agent map read from storage or an input object. */
export function normalizeWriterTargets(value: unknown): WriterTargetMap {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const result: WriterTargetMap = {};
  for (const [rawAgent, rawText] of Object.entries(value as Record<string, unknown>)) {
    const agent = cleanAgent(rawAgent);
    const text = normalizeWriterTargetText(rawText);
    if (agent === null || text === null || text.length === 0) continue;
    result[agent] = text;
    if (Object.keys(result).length >= MAX_WRITER_TARGET_AGENTS) break;
  }
  return result;
}

/** Normalize a whole workspace store, dropping malformed or empty entries. */
export function normalizeWriterTargetStore(value: unknown): WriterTargetStore {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const result: WriterTargetStore = {};
  for (const [rawWorkspace, rawTargets] of Object.entries(value as Record<string, unknown>)) {
    const workspace = cleanWorkspace(rawWorkspace);
    const targets = normalizeWriterTargets(rawTargets);
    if (workspace === null || Object.keys(targets).length === 0) continue;
    result[workspace] = targets;
  }
  const entries = Object.entries(result);
  return Object.fromEntries(entries.slice(-MAX_WRITER_TARGET_WORKSPACES));
}

/** Pure update used by the persistence wrapper and tests. */
export function updateWriterTargetStore(
  store: WriterTargetStore,
  workspace: string,
  targets: WriterTargetMap,
): WriterTargetStore {
  const key = cleanWorkspace(workspace);
  if (key === null) return normalizeWriterTargetStore(store);
  const next = normalizeWriterTargetStore(store);
  const normalized = normalizeWriterTargets(targets);
  if (Object.keys(normalized).length === 0) {
    delete next[key];
  } else {
    next[key] = normalized;
  }
  return Object.fromEntries(Object.entries(next).slice(-MAX_WRITER_TARGET_WORKSPACES));
}

export function loadWriterTargets(workspace: string): WriterTargetMap {
  const key = cleanWorkspace(workspace);
  if (key === null) return {};
  const store = normalizeWriterTargetStore(readStorageJson<unknown>(WRITER_TARGETS_KEY, {}));
  return store[key] ?? {};
}

export function saveWriterTargets(workspace: string, targets: WriterTargetMap): void {
  const store = readStorageJson<unknown>(WRITER_TARGETS_KEY, {});
  writeStorageJson(
    WRITER_TARGETS_KEY,
    updateWriterTargetStore(normalizeWriterTargetStore(store), workspace, targets),
  );
}
