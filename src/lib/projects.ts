/**
 * US-3 + US-30 Projects: pure project logic (create, thread attach/detach,
 * instruction prepending, per-project settings override with global diff).
 *
 * Zero imports (no React, no Tauri, no sibling modules) so it stays
 * runnable under the built-in `node:test` runner. Persistence helpers
 * (localStorage keys) live additively in ./persist; the hook keeps the
 * live state in ../hooks/useMuseSessions.
 */

import {
  DEFAULT_REASONING_EFFORT,
  normalizeReasoningEffort,
  type ReasoningEffort,
} from "./reasoning.ts";

/** One project: a named thread group with shared instructions. */
export interface Project {
  id: string;
  name: string;
  instructions: string;
  createdAt: number;
  /** Optional canonical folder used when starting conversations in a project. */
  workspace?: string;
  /** Additional project roots. `workspace` remains the legacy primary root. */
  workspaces?: string[];
  /** True once the user has explicitly reviewed the optional folder choice. */
  workspaceReviewed?: boolean;
  /** Per-project settings override (US-30); absent keys inherit global. */
  settings?: ProjectSettingsOverride;
}

/** Agent/security settings that a project can override (US-30). */
export interface ProjectSettings {
  model: string;
  sandbox: "read-only" | "workspace" | "full";
  networkDefault: "allow" | "prompt" | "deny";
  autoCompact: boolean;
  /** Host-backed reasoning depth applied to subsequent turns. */
  reasoningEffort: ReasoningEffort;
}

/** Global defaults a project inherits from when it overrides nothing. */
export const DEFAULT_PROJECT_SETTINGS: ProjectSettings = {
  model: "default",
  sandbox: "workspace",
  networkDefault: "prompt",
  autoCompact: true,
  reasoningEffort: DEFAULT_REASONING_EFFORT,
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

/** Native observation of a configured project folder. */
export interface WorkspaceRootObservation {
  path: string;
  exists: boolean;
  isDirectory: boolean;
  canonicalPath: string | null;
  reason: string;
}

/** Parse the additive native folder-health response without trusting its shape. */
export function parseWorkspaceRootObservation(raw: unknown): WorkspaceRootObservation | null {
  if (typeof raw !== "object" || raw === null) return null;
  const value = raw as Record<string, unknown>;
  if (
    typeof value.path !== "string" ||
    typeof value.exists !== "boolean" ||
    typeof value.is_directory !== "boolean" ||
    typeof value.reason !== "string"
  ) {
    return null;
  }
  return {
    path: value.path,
    exists: value.exists,
    isDirectory: value.is_directory,
    canonicalPath: typeof value.canonical_path === "string" ? value.canonical_path : null,
    reason: value.reason,
  };
}

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
    && (r.workspaces === undefined || (
      Array.isArray(r.workspaces) &&
      r.workspaces.every((root) => typeof root === "string")
    ))
    && (r.workspaceReviewed === undefined || typeof r.workspaceReviewed === "boolean")
  );
}

/** Normalize project roots while preserving order and removing duplicates. */
export function normalizeProjectWorkspaces(
  workspaces: string[] | undefined,
  legacyWorkspace?: string,
): string[] {
  const candidates = [legacyWorkspace ?? "", ...(workspaces ?? [])];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const candidate of candidates) {
    const root = candidate.trim();
    if (root.length === 0 || seen.has(root)) continue;
    seen.add(root);
    result.push(root);
  }
  return result;
}

/** All roots for a project, including the pre-multi-root `workspace` field. */
export function projectWorkspaces(project: Project): string[] {
  return normalizeProjectWorkspaces(project.workspaces, project.workspace);
}

/** Drop corrupt rows from a restored project list (never throws). */
export function sanitizeProjects(raw: unknown): Project[] {
  if (!Array.isArray(raw)) return [];
  return (raw.filter(isValidProject) as Project[]).slice(0, MAX_PROJECTS);
}

/**
 * Projects restored from the pre-root format have no usable workspace. Keep
 * this predicate in the project model so the migration UI and future import
 * paths share the same definition of an unrooted project.
 */
export function projectsNeedingWorkspace(projects: Project[]): Project[] {
  return projects.filter(
    (project) =>
      projectWorkspaces(project).length === 0 &&
      project.workspaceReviewed !== true,
  );
}

/**
 * A project root that can be selected when starting a new conversation.
 * Keep this projection in the project model so the welcome screen and any
 * future environment switcher use the same filtering and trimming rules.
 */
export interface ProjectWorkspaceOption {
  projectId: string;
  projectName: string;
  workspace: string;
  /** Stable value used by the new-conversation environment selector. */
  optionId: string;
  /** Zero-based root position within the project. */
  rootIndex: number;
}

export function projectWorkspaceOptions(
  projects: Project[],
): ProjectWorkspaceOption[] {
  return projects.flatMap((project) => projectWorkspaces(project).map((workspace, rootIndex) => ({
    projectId: project.id,
    projectName: project.name,
    workspace,
    optionId: `${project.id}:${rootIndex}`,
    rootIndex,
  })));
}

/**
 * Create a project. Refuses with PROJECT_LIMIT_MESSAGE at MAX_PROJECTS,
 * and with a blank-name message when the trimmed name is empty.
 */
export function createProject(
  projects: Project[],
  draft: { name: string; instructions?: string; workspace?: string; workspaces?: string[]; id?: string },
): CreateResult {
  const name = draft.name.trim();
  if (name.length === 0) {
    return { projects, project: null, error: "Project name must not be empty." };
  }
  if (projects.length >= MAX_PROJECTS) {
    return { projects, project: null, error: PROJECT_LIMIT_MESSAGE };
  }
  const roots = normalizeProjectWorkspaces(draft.workspaces, draft.workspace);
  const project: Project = {
    id: draft.id ?? makeId(),
    name,
    instructions: (draft.instructions ?? "").trim(),
    createdAt: Date.now(),
    workspaceReviewed: true,
    ...(roots[0] ? { workspace: roots[0] } : {}),
    ...(roots.length > 1 ? { workspaces: roots } : {}),
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
  patch: { name?: string; instructions?: string; workspace?: string; workspaces?: string[] },
): Project[] {
  return projects.map((p) => {
    if (p.id !== id) return p;
    const name =
      patch.name !== undefined && patch.name.trim().length > 0
        ? patch.name.trim()
        : p.name;
    const roots = patch.workspaces !== undefined
      ? normalizeProjectWorkspaces(patch.workspaces)
      : patch.workspace !== undefined
        ? normalizeProjectWorkspaces(undefined, patch.workspace)
        : projectWorkspaces(p);
    return {
      ...p,
      name,
      instructions:
        patch.instructions !== undefined ? patch.instructions.trim() : p.instructions,
      ...(patch.workspace !== undefined || patch.workspaces !== undefined
        ? {
            workspaceReviewed: true,
            ...(roots[0] ? { workspace: roots[0] } : { workspace: undefined }),
            ...(roots.length > 1 ? { workspaces: roots } : { workspaces: undefined }),
          }
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
  return {
    ...global,
    ...(override ?? {}),
    reasoningEffort: normalizeReasoningEffort(
      override?.reasoningEffort ?? global.reasoningEffort,
      DEFAULT_REASONING_EFFORT,
    ),
  };
}

/**
 * Resolve the effective settings for one attached conversation. Keeping the
 * project lookup beside the merge rule prevents individual UI surfaces from
 * inventing a second inheritance policy.
 */
export function settingsForThread(
  global: ProjectSettings,
  projects: Project[],
  attached: ThreadProjectMap,
  sessionId: string,
): ProjectSettings {
  const projectId = attached[sessionId];
  const project = projectId === undefined
    ? undefined
    : projects.find((candidate) => candidate.id === projectId);
  return resolveProjectSettings(global, project?.settings);
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
