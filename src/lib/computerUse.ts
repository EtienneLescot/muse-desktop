import { hostPlatform, type HostPlatform } from "./platform.ts";
/**
 * Computer use, as the renderer sees it.
 *
 * The engine is the open-source CUA driver, owned and launched by Rust
 * (`src-tauri/src/computer.rs`). This module only interprets what that module
 * reports, and it deliberately carries no tool name of its own: the vocabulary
 * belongs to the installed driver, and a copy here is how the two would drift.
 *
 * What the user gets is one switch and three levels. The previous surface — a
 * list of "apps" (`browser`, `finder`, `terminal`, `editor`) — is gone: three of
 * those four toggles were read by no code at all, and none of them described
 * what the agent may actually do.
 */

/** How far the grant goes. Ordered from the narrowest. */
export const COMPUTER_LEVELS = ["observe", "act"] as const;

export type ComputerLevel = (typeof COMPUTER_LEVELS)[number];

/** The state of the grant, which is not the state of the service. */
export const GRANT_STATES = ["stopped", "active", "expired", "permissions"] as const;

export type GrantState = (typeof GRANT_STATES)[number];

export interface ComputerLevelInfo {
  level: ComputerLevel;
  label: string;
  /** One sentence, addressed to the person deciding. */
  summary: string;
}

export const LEVEL_INFO: Record<ComputerLevel, ComputerLevelInfo> = {
  observe: {
    level: "observe",
    label: "Observe only",
    summary:
      "Muse can take screenshots and read windows and their accessibility tree. It cannot click or type.",
  },
  act: {
    level: "act",
    label: "Observe and act",
    summary:
      "Muse can use the mouse, the keyboard and the clipboard in any application on this computer. The driver adds no limit of its own: turning this on is your consent.",
  },
};

/** One probe from the driver's own `doctor`, so the reason is the driver's. */
export interface ComputerProbe {
  label: string;
  status: string;
  message: string;
}

export interface ComputerStatus {
  driverPath: string | null;
  driverVersion: string | null;
  available: boolean;
  /** How many tools each level would grant with this driver. */
  levelCounts: Record<string, number>;
  /** Tools the driver offers that no level covers: reported, never granted. */
  unclassified: string[];
  grantState: GrantState;
  manifest: unknown;
  manifestDigest: string | null;
  doctor: { ok?: boolean; probes?: ComputerProbe[] } | null;
  /** macOS grants still missing for CuaDriver, while `grantState` is `permissions`. */
  permissions: MacPermissions | null;
}

export interface MacPermissions {
  accessibility: boolean;
  screenRecording: boolean;
}

export type PrivacyPane = keyof MacPermissions;

/** The two macOS grants, in the order the user should give them. */
export const PRIVACY_STEPS: readonly { pane: PrivacyPane; label: string; detail: string }[] = [
  {
    pane: "accessibility",
    label: "Accessibility",
    detail: "Lets Muse click, type and read the controls of other apps.",
  },
  {
    pane: "screenRecording",
    label: "Screen Recording",
    detail: "Lets Muse see the screen to know where to act.",
  },
];

function parsePermissions(raw: unknown): MacPermissions | null {
  if (typeof raw !== "object" || raw === null) return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.accessibility !== "boolean" || typeof value.screenRecording !== "boolean") return null;
  return { accessibility: value.accessibility, screenRecording: value.screenRecording };
}

function isGrantState(value: unknown): value is GrantState {
  return typeof value === "string" && (GRANT_STATES as readonly string[]).includes(value);
}

function isLevel(value: unknown): value is ComputerLevel {
  return typeof value === "string" && (COMPUTER_LEVELS as readonly string[]).includes(value);
}

export function isComputerLevel(value: unknown): value is ComputerLevel {
  return isLevel(value);
}

/** Read the native payload without trusting its shape. */
export function parseComputerStatus(raw: unknown): ComputerStatus | null {
  if (typeof raw !== "object" || raw === null) return null;
  const value = raw as Record<string, unknown>;
  if (!isGrantState(value.grantState)) return null;
  if (typeof value.available !== "boolean") return null;
  const counts: Record<string, number> = {};
  if (typeof value.levelCounts === "object" && value.levelCounts !== null) {
    for (const level of COMPUTER_LEVELS) {
      const count = (value.levelCounts as Record<string, unknown>)[level];
      if (typeof count === "number") counts[level] = count;
    }
  }
  const unclassified = Array.isArray(value.unclassified)
    ? value.unclassified.filter((tool): tool is string => typeof tool === "string")
    : [];
  const probes = (value.doctor as { probes?: unknown } | null)?.probes;
  const doctor = Array.isArray(probes)
    ? {
        ok: (value.doctor as { ok?: unknown }).ok === true,
        probes: probes.flatMap((probe): ComputerProbe[] => {
          if (typeof probe !== "object" || probe === null) return [];
          const row = probe as Record<string, unknown>;
          if (typeof row.label !== "string" || typeof row.status !== "string") return [];
          return [
            {
              label: row.label,
              status: row.status,
              message: typeof row.message === "string" ? row.message : "",
            },
          ];
        }),
      }
    : null;
  return {
    driverPath: typeof value.driverPath === "string" ? value.driverPath : null,
    driverVersion: typeof value.driverVersion === "string" ? value.driverVersion : null,
    available: value.available,
    levelCounts: counts,
    unclassified,
    grantState: value.grantState,
    manifest: value.manifest ?? null,
    manifestDigest: typeof value.manifestDigest === "string" ? value.manifestDigest : null,
    doctor,
    permissions: parsePermissions(value.permissions),
  };
}

/** The tool count a level would grant with the installed driver. */
export function levelToolCount(status: ComputerStatus | null, level: ComputerLevel): number {
  return status?.levelCounts[level] ?? 0;
}

/**
 * One sentence describing the whole feature, for the panel header. Written so
 * that "enabled" never means more than what is true.
 */
export function describeComputerUse(status: ComputerStatus | null): string {
  if (status === null) return "Computer use has not been read yet.";
  if (!status.available) {
    return "The CUA driver is not installed. Muse cannot see or control this computer.";
  }
  switch (status.grantState) {
    case "active":
      return "Muse can use this computer, only through the granted tools, until you turn it off.";
    case "expired":
      return "The grant has lapsed. Turn computer use off and on again to grant it anew.";
    case "permissions":
      return "One more step: macOS must allow CuaDriver, the helper Muse uses to see and control this Mac.";
    default:
      return "Muse cannot control this computer.";
  }
}

/**
 * The driver's own probes, reduced to the ones a person can act on. The driver
 * reports its prerequisites; repeating them in our words would only add a place
 * for the two to disagree.
 */
export function failedProbes(status: ComputerStatus | null): ComputerProbe[] {
  return (status?.doctor?.probes ?? []).filter((probe) => probe.status !== "ok");
}

/** The exact command that installs the driver, for a copy button. */
export const DRIVER_INSTALL_COMMAND = "irm https://cua.ai/driver/install.ps1 | iex";
/** macOS: the driver's official shell installer (CuaDriver.app + ~/.local/bin). */
export const DRIVER_INSTALL_COMMAND_MACOS = '/bin/bash -c "$(curl -fsSL https://cua.ai/driver/install.sh)"';

/** The install command for the host OS. */
export function driverInstallCommand(platform: HostPlatform = hostPlatform()): string {
  return platform === "macos" ? DRIVER_INSTALL_COMMAND_MACOS : DRIVER_INSTALL_COMMAND;
}
export const DRIVER_HOME = "https://github.com/trycua/cua";
