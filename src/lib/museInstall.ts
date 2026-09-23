/**
 * First-run Muse CLI installation (macOS). The native side owns the command;
 * the renderer only starts, observes, answers Enter and cancels it.
 */
export type InstallState = "idle" | "running" | "succeeded" | "failed" | "cancelled";

export type MuseTask = "install" | "login";

export interface InstallStatus {
  kind: MuseTask;
  state: InstallState;
  log: string;
  exitCode: number | null;
  awaitingEnter: boolean;
  cliPath: string;
  installed: boolean;
  /** Device code to confirm in the browser during `muse login`. */
  signInCode: string | null;
}

const STATES: readonly InstallState[] = ["idle", "running", "succeeded", "failed", "cancelled"];

/** Validate an untrusted native payload; null when it is not an install status. */
export function parseInstallStatus(raw: unknown): InstallStatus | null {
  if (typeof raw !== "object" || raw === null) return null;
  const value = raw as Record<string, unknown>;
  if (!STATES.includes(value.state as InstallState)) return null;
  const code = typeof value.signInCode === "string" && /^[A-Za-z0-9-]{1,32}$/.test(value.signInCode)
    ? value.signInCode
    : null;
  return {
    kind: value.kind === "login" ? "login" : "install",
    signInCode: code,
    state: value.state as InstallState,
    log: typeof value.log === "string" ? value.log.slice(-64_000) : "",
    exitCode: typeof value.exitCode === "number" ? value.exitCode : null,
    awaitingEnter: value.awaitingEnter === true,
    cliPath: typeof value.cliPath === "string" ? value.cliPath : "",
    installed: value.installed === true,
  };
}

/** Short status line for the install panel. */
export function installHeadline(status: InstallStatus | null): string {
  if (status?.kind === "login") {
    switch (status.state) {
      case "running":
        return status.signInCode
          ? "Confirm this code on the Meta page, then come back here."
          : "Starting the sign-in…";
      case "succeeded":
        return "Signed in. Starting Muse…";
      case "failed":
        return "The sign-in did not complete. Try again.";
      case "cancelled":
        return "Sign-in cancelled.";
      default:
        return "Sign in with your Meta account to use Muse.";
    }
  }
  switch (status?.state) {
    case "running":
      return status.awaitingEnter
        ? "Sign in to Meta to finish downloading Muse."
        : "Installing the Muse CLI…";
    case "succeeded":
      return "Muse CLI installed. Starting Muse…";
    case "failed":
      return `The installer stopped${status.exitCode !== null ? ` (exit code ${status.exitCode})` : ""}. Check the log, then try again.`;
    case "cancelled":
      return "Installation cancelled.";
    default:
      return "Muse-Desktop runs on the Muse CLI, which is not installed yet.";
  }
}
