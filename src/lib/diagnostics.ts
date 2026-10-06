/** M0-07: bounded, local diagnostics without conversation contents or secrets. */

const MAX_ERROR_CHARS = 500;

export interface DiagnosticsInput {
  workspace: string | null;
  sessionCount: number;
  runningSessionCount: number;
  connectedSessionCount: number;
  pendingApprovalCount: number;
  pendingInputCount: number;
  pendingSendCount: number;
  scheduleCount: number;
  scheduleRunCount: number;
  eventCount: number;
  backendMissing: boolean;
  error: string | null;
  native?: NativeDiagnosticsSnapshot | null;
}

export interface NativeDiagnosticsSnapshot {
  schema: "muse-desktop.native-diagnostics.v1";
  workspaceConfigured: boolean;
  hostCount: number;
  sessionCount: number;
  runningSessionCount: number;
  pendingApprovalCount: number;
  eventBufferCount: number;
  /** M0-14 isolated test mode (debug Windows builds): fixture engines, test profile. */
  testMode?: boolean;
}

export interface DiagnosticsSnapshot {
  schema: "muse-desktop.diagnostics.v1";
  generatedAt: string;
  platform: string;
  userAgent: string;
  workspaceConfigured: boolean;
  counts: Omit<DiagnosticsInput, "workspace" | "backendMissing" | "error" | "native">;
  backend: "web-preview" | "local";
  lastError: string | null;
  native: NativeDiagnosticsSnapshot | null;
}

/** First `end` UTF-16 units, backing off one rather than splitting a surrogate pair. */
export function safeSlice(value: string, end: number): string {
  const last = value.charCodeAt(end - 1);
  return value.slice(0, last >= 0xd800 && last <= 0xdbff ? end - 1 : end);
}

function bounded(value: string, max = MAX_ERROR_CHARS): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= max ? normalized : `${safeSlice(normalized, max)}…`;
}

/** Redact common credential-shaped values before a value leaves the app. */
export function redactDiagnostic(value: string | null): string | null {
  if (!value) return null;
  let output = value.replace(/bearer\s+[^\s,;]+/gi, "Bearer [redacted]");
  output = output.replace(/(["']?(?:token|access_token|refresh_token|api[_-]?key|secret|password)["']?\s*[:=]\s*)(["']?)[^\s,;}"']+\2/gi, "$1[redacted]");
  return bounded(output);
}

function nonNegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

export function buildDiagnosticsSnapshot(
  input: DiagnosticsInput,
  now = new Date(),
  platform = typeof navigator === "undefined" ? "unknown" : navigator.platform || "unknown",
  userAgent = typeof navigator === "undefined" ? "unknown" : navigator.userAgent || "unknown",
): DiagnosticsSnapshot {
  return {
    schema: "muse-desktop.diagnostics.v1",
    generatedAt: now.toISOString(),
    platform: bounded(platform, 120),
    userAgent: bounded(userAgent, 240),
    workspaceConfigured: typeof input.workspace === "string" && input.workspace.trim().length > 0,
    counts: {
      sessionCount: nonNegative(input.sessionCount),
      runningSessionCount: nonNegative(input.runningSessionCount),
      connectedSessionCount: nonNegative(input.connectedSessionCount),
      pendingApprovalCount: nonNegative(input.pendingApprovalCount),
      pendingInputCount: nonNegative(input.pendingInputCount),
      pendingSendCount: nonNegative(input.pendingSendCount),
      scheduleCount: nonNegative(input.scheduleCount),
      scheduleRunCount: nonNegative(input.scheduleRunCount),
      eventCount: nonNegative(input.eventCount),
    },
    backend: input.backendMissing ? "web-preview" : "local",
    lastError: redactDiagnostic(input.error),
    native: input.native ?? null,
  };
}

export function diagnosticsJson(input: DiagnosticsInput, now?: Date, platform?: string, userAgent?: string): string {
  return JSON.stringify(buildDiagnosticsSnapshot(input, now, platform, userAgent), null, 2);
}
