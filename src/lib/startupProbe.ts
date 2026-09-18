/** Shared first-launch prerequisite types and presentation helpers. */

export interface StartupCheck {
  status: "ready" | "missing" | "blocked" | "unknown";
  detail: string;
}

export interface StartupProbe {
  platform: string;
  sidecar: StartupCheck;
  wsl: StartupCheck | null;
  museCli: StartupCheck | null;
  workspace: StartupCheck | null;
  checkedAt: number;
}

export interface StartupProbeRow {
  label: string;
  check: StartupCheck;
}

const INVISIBLE_STARTUP_MARKERS = /[\u0000-\u001f\u007f-\u009f\u200b\u200c\u200d\u2060\ufeff\ufffd]/;

/** Keep legacy/preview probe payloads readable without changing the SSOT. */
export function sanitizeStartupText(value: string, maxChars = 240): string {
  return Array.from(value ?? "")
    .map((character) => (INVISIBLE_STARTUP_MARKERS.test(character) ? " " : character))
    .join("")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxChars);
}

/** Stable text for the check state; colour remains a secondary cue. */
export function startupCheckStatusLabel(status: StartupCheck["status"]): string {
  switch (status) {
    case "ready":
      return "Ready";
    case "missing":
      return "Needs attention";
    case "blocked":
      return "Blocked";
    case "unknown":
      return "Not verified";
  }
}

/** Convert an optional probe payload into a stable display order. */
export function startupProbeRows(probe: StartupProbe): StartupProbeRow[] {
  return [
    { label: "Sidecar", check: { ...probe.sidecar, detail: sanitizeStartupText(probe.sidecar.detail) } },
    ...(probe.wsl
      ? [{ label: "WSL", check: { ...probe.wsl, detail: sanitizeStartupText(probe.wsl.detail) } }]
      : []),
    ...(probe.museCli
      ? [{ label: "Muse CLI", check: { ...probe.museCli, detail: sanitizeStartupText(probe.museCli.detail) } }]
      : []),
    ...(probe.workspace
      ? [{ label: "Workspace", check: { ...probe.workspace, detail: sanitizeStartupText(probe.workspace.detail) } }]
      : []),
  ];
}


/** True when at least one available prerequisite needs user attention. */
export function startupProbeNeedsAttention(probe: StartupProbe): boolean {
  return startupProbeRows(probe).some(({ check }) => check.status !== "ready");
}

/** Compact summary for first-launch surfaces; never relies on colour alone. */
export function startupProbeSummary(probe: StartupProbe): string {
  const rows = startupProbeRows(probe);
  if (rows.length === 0) return "No checks available";
  const ready = rows.filter(({ check }) => check.status === "ready").length;
  return startupProbeNeedsAttention(probe)
    ? `${ready}/${rows.length} checks ready · attention needed`
    : `${ready}/${rows.length} checks ready`;
}
