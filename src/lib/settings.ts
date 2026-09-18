/**
 * w-settings (US-16 sandbox + US-31 providers): pure settings logic.
 *
 * Zero imports — runnable on the plain node:test runner. Persistence
 * (localStorage under `muse-desktop.*` keys) lives in the hook; everything
 * here is total, validated, and DOM-free.
 *
 * - Sandbox (US-16): workspace-confined is the default. `network` and
 *   `elevated` modes only take effect with their explicit permission toggle
 *   persisted alongside; without it the effective mode falls back to
 *   `workspace` (fail-closed).
 * - Providers (US-31): picker over the live host catalog (`model/list`,
 *   snapshot at call time) with the local sample registry as fallback when
 *   the backend is unreachable. The fallback must be labelled "configured
 *   providers", never a live list. Provider selection persists per project
 *   (project id = workspace path); model choice applies via
 *   `session/setModel` on the active session.
 * - Scope routing: paths outside the workspace root are out-of-scope
 *   attempts and must go through the existing scope-guard prompt path
 *   (`checkScope` in ./scope.ts); `isOutsideWorkspace` is the pure
 *   containment check the panel uses to decide.
 */

export type SandboxMode = "workspace" | "network" | "elevated";

export interface SandboxSettings {
  mode: SandboxMode;
  /** Explicit persisted permission for the network sandbox mode. */
  networkAllowed: boolean;
  /** Explicit persisted permission for the elevated sandbox mode. */
  elevatedAllowed: boolean;
}

/** Project-level security preferences projected onto the host at startup. */
export interface ProjectSandboxPreferences {
  sandbox: "read-only" | "workspace" | "full";
  networkDefault: "allow" | "prompt" | "deny";
}

/** Exact host posture sent with a new workspace host request. */
export interface HostSandboxConfig {
  mode: SandboxMode;
  disableWrite: boolean;
  disableShell: boolean;
}

/** Global sandbox settings live under this localStorage key. */
export const SETTINGS_KEY = "muse-desktop.settings.v1";

/** Per-project provider selections (project id -> provider id). */
export const PROVIDER_MAP_KEY = "muse-desktop.providers.v1";

export const DEFAULT_SANDBOX: SandboxSettings = {
  mode: "workspace",
  networkAllowed: false,
  elevatedAllowed: false,
};

export function isSandboxMode(v: unknown): v is SandboxMode {
  return v === "workspace" || v === "network" || v === "elevated";
}

/** Validate unknown stored data; anything invalid falls back to the default. */
export function parseSandboxSettings(raw: unknown): SandboxSettings {
  if (typeof raw !== "object" || raw === null) return { ...DEFAULT_SANDBOX };
  const o = raw as Record<string, unknown>;
  return {
    mode: isSandboxMode(o.mode) ? o.mode : DEFAULT_SANDBOX.mode,
    networkAllowed:
      typeof o.networkAllowed === "boolean"
        ? o.networkAllowed
        : DEFAULT_SANDBOX.networkAllowed,
    elevatedAllowed:
      typeof o.elevatedAllowed === "boolean"
        ? o.elevatedAllowed
        : DEFAULT_SANDBOX.elevatedAllowed,
  };
}

/**
 * Effective mode: the selected mode only applies with its explicit
 * permission; otherwise confinement falls back to `workspace`.
 */
export function effectiveSandboxMode(s: SandboxSettings): SandboxMode {
  if (s.mode === "network" && !s.networkAllowed) return "workspace";
  if (s.mode === "elevated" && !s.elevatedAllowed) return "workspace";
  return s.mode;
}

/**
 * Resolve the global permission gate and the project override once, before a
 * host is spawned. A project can tighten the global posture (read-only or
 * deny network); it can relax it only when the corresponding global toggle
 * has already granted permission. This keeps the hook as the SSOT while the
 * Rust bridge receives only concrete startup flags.
 */
export function hostSandboxConfigForProject(
  global: SandboxSettings,
  project?: ProjectSandboxPreferences,
): HostSandboxConfig {
  const globalMode = effectiveSandboxMode(global);
  if (project === undefined) {
    return {
      mode: globalMode,
      disableWrite: false,
      disableShell: false,
    };
  }
  const preferences = project;
  const networkEnabled =
    preferences.networkDefault === "allow" && globalMode !== "workspace";
  const mode: SandboxMode =
    preferences.sandbox === "full" && globalMode === "elevated"
      ? "elevated"
      : networkEnabled
        ? "network"
        : "workspace";
  return {
    mode,
    disableWrite: preferences.sandbox === "read-only",
    disableShell: preferences.sandbox === "read-only",
  };
}

/** Whether `mode` may be selected right now (workspace is always allowed). */
export function canSelectMode(s: SandboxSettings, mode: SandboxMode): boolean {
  if (mode === "workspace") return true;
  if (mode === "network") return s.networkAllowed;
  return s.elevatedAllowed;
}

/** True when the settings request more than default confinement. */
export function isRelaxedSandbox(s: SandboxSettings): boolean {
  return effectiveSandboxMode(s) !== "workspace";
}

/** Hidden web-search default: off unless the user opts in elsewhere. */
export const WEB_SEARCH_DEFAULT_NOTE =
  "Web search is off by default. Results are never fetched " +
  "in the background; enabling search is an explicit per-request choice.";

/** One entry of the provider picker (US-31). */
export interface ProviderEntry {
  id: string;
  label: string;
  model: string;
  /** True for local samples, false for live host catalog rows. */
  sample: boolean;
}

/**
 * One row of the live host catalog (`model/list` result `models[]`).
 * Same defensive contract as the Rust `ModelEntry`: only `modelId` is
 * required; everything else falls back. Unknown/invalid rows are dropped.
 */
export interface LiveModel {
  modelId: string;
  displayLabel: string;
  providerId: string;
  profileId: string | null;
  isActive: boolean;
  isDefault: boolean;
}

/** Validate one catalog row; null when it carries no usable model id. */
export function parseLiveModel(raw: unknown): LiveModel | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const id = ["modelId", "model_id", "id"]
    .map((k) => o[k])
    .find(
      (v): v is string => typeof v === "string" && v.trim().length > 0,
    );
  if (id === undefined) return null;
  const str = (keys: string[], fallback: string): string => {
    for (const k of keys) {
      const v = o[k];
      if (typeof v === "string" && v.length > 0) return v;
    }
    return fallback;
  };
  const bool = (keys: string[]): boolean =>
    keys.some((k) => o[k] === true);
  const profile = ["profileId", "profile_id", "profile"]
    .map((k) => o[k])
    .find((v): v is string => typeof v === "string" && v.length > 0) ?? null;
  return {
    modelId: id,
    displayLabel: str(["displayLabel", "display_label", "label"], id),
    providerId: str(["providerId", "provider_id", "provider"], ""),
    profileId: profile,
    isActive: bool(["isActive", "is_active"]),
    isDefault: bool(["isDefault", "is_default"]),
  };
}

/** Validate a whole catalog payload; invalid rows are dropped. */
export function parseModelList(raw: unknown): LiveModel[] {
  if (!Array.isArray(raw)) return [];
  const out: LiveModel[] = [];
  for (const row of raw) {
    const m = parseLiveModel(row);
    if (m !== null) out.push(m);
  }
  return out;
}

/** Project a live catalog onto picker entries (never samples). */
export function liveProviderEntries(live: LiveModel[]): ProviderEntry[] {
  return live.map((m) => ({
    id: `live:${m.modelId}`,
    label: m.displayLabel,
    model: m.modelId,
    sample: false,
  }));
}

/**
 * Local registry file: 3 sample entries. The backend model list is
 * unsourced, so consumers must label this "configured providers".
 */
export const CONFIGURED_PROVIDERS: ProviderEntry[] = [
  { id: "sample-local", label: "Local sample", model: "sample-local-1", sample: true },
  { id: "sample-cloud-a", label: "Sample cloud A", model: "sample-a-large", sample: true },
  { id: "sample-cloud-b", label: "Sample cloud B", model: "sample-b-small", sample: true },
];

export const DEFAULT_PROVIDER_ID: string = CONFIGURED_PROVIDERS[0].id;

/** Look up a registry entry; null for unknown ids. */
export function providerById(
  id: string,
  registry: ProviderEntry[] = CONFIGURED_PROVIDERS,
): ProviderEntry | null {
  return registry.find((p) => p.id === id) ?? null;
}

/** Validate a stored provider id against the registry; default on unknown. */
export function parseProviderId(
  raw: unknown,
  registry: ProviderEntry[] = CONFIGURED_PROVIDERS,
): string {
  const fallback = registry[0]?.id ?? DEFAULT_PROVIDER_ID;
  if (typeof raw !== "string" || raw.length === 0) return fallback;
  return providerById(raw, registry) === null ? fallback : raw;
}

/** Validate a stored per-project provider map (project id -> provider id). */
export function parseProviderMap(
  raw: unknown,
  registry: ProviderEntry[] = CONFIGURED_PROVIDERS,
): Record<string, string> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (k.length === 0 || typeof v !== "string") continue;
    if (providerById(v, registry) === null) continue;
    out[k] = v;
  }
  return out;
}

/** Provider id selected for one project (workspace path); registry default. */
export function providerForProject(
  map: Record<string, string>,
  projectId: string | null,
  registry: ProviderEntry[] = CONFIGURED_PROVIDERS,
): string {
  const fallback = registry[0]?.id ?? DEFAULT_PROVIDER_ID;
  if (projectId === null) return fallback;
  const id = map[projectId];
  if (typeof id !== "string") return fallback;
  return providerById(id, registry) === null ? fallback : id;
}

/**
 * Pure containment check: is `absPath` outside `workspaceRoot`? Either
 * empty means "outside" (fail-closed: route to the scope-guard prompt).
 */
export function isOutsideWorkspace(
  workspaceRoot: string | null,
  absPath: string,
): boolean {
  const target = absPath.trim();
  if (workspaceRoot === null || workspaceRoot.trim().length === 0) return true;
  if (target.length === 0) return true;
  const root = workspaceRoot.replace(/\/+$/, "");
  if (target === root) return false;
  return !target.startsWith(`${root}/`);
}
