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
    { label: "Sidecar", check: probe.sidecar },
    ...(probe.wsl ? [{ label: "WSL", check: probe.wsl }] : []),
    ...(probe.museCli ? [{ label: "Muse CLI", check: probe.museCli }] : []),
    ...(probe.workspace ? [{ label: "Workspace", check: probe.workspace }] : []),
  ];
}

