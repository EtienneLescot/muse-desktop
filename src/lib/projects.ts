/**
 * US-3 + US-30 Projects: pure project logic (create, thread attach/detach,
 * instruction prepending, per-project settings override with global diff).
 *
 * Zero imports (no React, no Tauri, no sibling modules) so it stays
 * runnable under the built-in `node:test` runner. Persistence helpers
 * (localStorage keys) live additively in ./persist; the hook keeps the
 * live state in ../hooks/useMuseSessions.
 */

/** One project: a named thread group with shared instructions. */
export interface Project {
  id: string;
  name: string;
  instructions: string;
  createdAt: number;
  /** Optional canonical folder used when starting conversations in a project. */
  workspace?: string;
  /** Per-project settings override (US-30); absent keys inherit global. */
  settings?: ProjectSettingsOverride;
}

/** Agent/security settings that a project can override (US-30). */
export interface ProjectSettings {
  model: string;
  sandbox: "read-only" | "workspace" | "full";
  networkDefault: "allow" | "prompt" | "deny";
  autoCompact: boolean;
}

/** Global defaults a project inherits from when it overrides nothing. */
export const DEFAULT_PROJECT_SETTINGS: ProjectSettings = {
  model: "default",
  sandbox: "workspace",
  networkDefault: "prompt",
  autoCompact: true,
};

/** Sparse per-project override: only set keys diverge from global. */
export type ProjectSettingsOverride = Partial<ProjectSettings>;

/** Free-tier client-side cap (US-3 AC: max 5 projects, explicit message). */
export const MAX_PROJECTS = 5;

/** Explicit quota message shown when creation is refused. */
export const PROJECT_LIMIT_MESSAGE =
  "Project limit reached (5 max on this plan): delete a project before creating a new one.";

/** Thread→project attachment map (session id → project id). */
export type ThreadProjectMap = Record<string, string>;

export interface CreateResult {
  projects: Project[];
  project: Project | null;
  /** Human-readable refusal reason (quota / blank name); null on success. */
  error: string | null;
}

function makeId(): string {
  return `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
}

function isValidProject(p: unknown): p is Project {
  if (typeof p !== "object" || p === null) return false;
  const r = p as Record<string, unknown>;
  return (
    typeof r.id === "string" &&
    r.id.length > 0 &&
    typeof r.name === "string" &&
    typeof r.instructions === "string" &&
    typeof r.createdAt === "number" &&
    (r.workspace === undefined || typeof r.workspace === "string")
  );
}

/** Drop corrupt rows from a restored project list (never throws). */
export function sanitizeProjects(raw: unknown): Project[] {
  if (!Array.isArray(raw)) return [];
  return (raw.filter(isValidProject) as Project[]).slice(0, MAX_PROJECTS);
}

/**
 * Create a project. Refuses with PROJECT_LIMIT_MESSAGE at MAX_PROJECTS,
 * and with a blank-name message when the trimmed name is empty.
 */
export function createProject(
  projects: Project[],
  draft: { name: string; instructions?: string; workspace?: string; id?: string },
): CreateResult {
  const name = draft.name.trim();
  if (name.length === 0) {
    return { projects, project: null, error: "Project name must not be empty." };
  }
  if (projects.length >= MAX_PROJECTS) {
    return { projects, project: null, error: PROJECT_LIMIT_MESSAGE };
  }
  const project: Project = {
    id: draft.id ?? makeId(),
    name,
    instructions: (draft.instructions ?? "").trim(),
    createdAt: Date.now(),
    ...(draft.workspace?.trim() ? { workspace: draft.workspace.trim() } : {}),
  };
  return { projects: [...projects, project], project, error: null };
}

/** Delete a project; threads attached to it become ungrouped (no orphan). */
export function deleteProject(
  projects: Project[],
  attached: ThreadProjectMap,
  id: string,
): { projects: Project[]; attached: ThreadProjectMap } {
  return {
    projects: projects.filter((p) => p.id !== id),
    attached: Object.fromEntries(
      Object.entries(attached).filter(([, pid]) => pid !== id),
    ),
  };
}

/** Rename / re-instruct a project (blank rename is ignored). */
export function updateProject(
  projects: Project[],
  id: string,
  patch: { name?: string; instructions?: string; workspace?: string },
): Project[] {
  return projects.map((p) => {
    if (p.id !== id) return p;
    const name =
      patch.name !== undefined && patch.name.trim().length > 0
        ? patch.name.trim()
        : p.name;
    return {
      ...p,
      name,
      instructions:
        patch.instructions !== undefined ? patch.instructions.trim() : p.instructions,
      ...(patch.workspace !== undefined
        ? (patch.workspace.trim() ? { workspace: patch.workspace.trim() } : { workspace: undefined })
        : {}),
    };
  });
}

/**
 * Attach a thread to a project. Unknown project ids detach instead of
 * creating a dangling link; `null` detaches explicitly.
 */
export function attachThread(
  attached: ThreadProjectMap,
  projects: Project[],
  sessionId: string,
  projectId: string | null,
): ThreadProjectMap {
  if (projectId === null || !projects.some((p) => p.id === projectId)) {
    const next = { ...attached };
    delete next[sessionId];
    return next;
  }
  return { ...attached, [sessionId]: projectId };
}

/** Project id a thread is attached to (null = ungrouped). */
export function projectOfThread(
  attached: ThreadProjectMap,
  sessionId: string,
): string | null {
  return attached[sessionId] ?? null;
}

/** Session ids attached to one project. */
export function threadsInProject(
  attached: ThreadProjectMap,
  projectId: string,
): string[] {
  return Object.entries(attached)
    .filter(([, pid]) => pid === projectId)
    .map(([sid]) => sid);
}

/**
 * Prepend project instructions to the outgoing input (US-3 AC): the model
 * receives the project context first, then the user's raw text verbatim.
 * Threads without a project (or with blank instructions) send input
 * untouched.
 */
export function buildProjectInput(
  text: string,
  project: Project | null | undefined,
): string {
  const trimmed = text.trim();
  if (!project || project.instructions.trim().length === 0) return trimmed;
  return (
    `[Project "${project.name}" instructions]\n` +
    `${project.instructions.trim()}\n\n${trimmed}`
  );
}

/** Effective settings for a project: global defaults + set override keys. */
export function resolveProjectSettings(
  global: ProjectSettings,
  override: ProjectSettingsOverride | undefined,
): ProjectSettings {
  return { ...global, ...(override ?? {}) };
}

export interface SettingsDiffEntry {
  key: keyof ProjectSettings;
  global: string | boolean;
  project: string | boolean;
}

/**
 * Global-vs-project diff (US-30 AC): one entry per override key whose
 * value actually diverges from global. Empty = fully inherited.
 */
export function diffProjectSettings(
  global: ProjectSettings,
  override: ProjectSettingsOverride | undefined,
): SettingsDiffEntry[] {
  if (!override) return [];
  const out: SettingsDiffEntry[] = [];
  (Object.keys(override) as (keyof ProjectSettings)[]).forEach((key) => {
    const value = override[key];
    if (value === undefined) return;
    if (value !== global[key]) {
      out.push({ key, global: global[key], project: value });
    }
  });
  return out;
}

/** Set (or clear with `undefined`) one per-project override key. */
export function setProjectOverride(
  projects: Project[],
  id: string,
  key: keyof ProjectSettings,
  value: ProjectSettings[keyof ProjectSettings] | undefined,
): Project[] {
  return projects.map((p) => {
    if (p.id !== id) return p;
    const next: ProjectSettingsOverride = { ...(p.settings ?? {}) };
    if (value === undefined) {
      delete next[key];
    } else {
      (next as Record<string, unknown>)[key] = value;
    }
    return { ...p, settings: next };
  });
}
