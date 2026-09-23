import { hostPlatform, type HostPlatform } from "./platform.ts";
/**
 * US-33: classify backend sidecar/startup failures so the UI shows an
 * explicit message (never a blank screen). Pure helpers, unit-tested.
 *
 * The Rust supervisor surfaces startup failures as `invoke` errors:
 * - missing binary: `sidecar binary not found … (tried <a>, <b>)`
 * - spawn failure: `could not spawn sidecar …` / `sidecar command failed …`
 * - dead handshake: `MSP handshake failed …`
 * The hook prefixes them (`start_session failed: …`), so matching is
 * substring-based and never throws.
 */

export type SidecarErrorKind = "missing" | "start-failed";

export interface SidecarRecoveryStep {
  title: string;
  detail: string;
}

/** True when `message` is a sidecar startup failure of any kind. */
export function isSidecarError(message: string | null | undefined): boolean {
  return classifySidecarError(message) !== null;
}

/**
 * Classify a sidecar startup failure: `missing` (binary absent — expected
 * triple-suffixed paths are listed) vs `start-failed` (binary present but
 * spawn/handshake died). Returns null for unrelated errors.
 */
export function classifySidecarError(
  message: string | null | undefined,
): SidecarErrorKind | null {
  if (!message) return null;
  const m = message.toLowerCase();
  if (m.includes("sidecar binary not found")) return "missing";
  if (
    m.includes("could not spawn sidecar") ||
    m.includes("sidecar command failed") ||
    m.includes("msp handshake failed") ||
    m.includes("no sidecar host")
  ) {
    return "start-failed";
  }
  return null;
}

/**
 * Best-effort extraction of the probed paths from a missing-binary message
 * (`… (tried <a>, <b>) …`). Returns [] when the message carries none.
 */
export function extractTriedPaths(message: string): string[] {
  const m = /\(tried ([^)]+)\)/.exec(message);
  if (!m) return [];
  return m[1]
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Turn the bounded startup error into a short, platform-aware recovery path.
 * On Windows the bridge remains responsible for probing WSL/Muse; this helper only
 * explains the evidence already returned by that probe and never claims that
 * a dependency was installed or authenticated.
 */
export function startupRecoverySteps(
  kind: SidecarErrorKind,
  message: string,
  platform: HostPlatform = hostPlatform(),
): SidecarRecoveryStep[] {
  if (platform === "macos") return macRecoverySteps(kind, message);
  const lower = message.toLowerCase();
  const steps: SidecarRecoveryStep[] = [];
  const add = (title: string, detail: string) => {
    if (!steps.some((step) => step.title === title)) steps.push({ title, detail });
  };

  if (kind === "missing") {
    add(
      "Provide the matching sidecar",
      "For a packaged build, reinstall the Windows bundle. For development, place the triple-suffixed binary in src-tauri/binaries/.",
    );
  }
  if (
    lower.includes("wsl") ||
    lower.includes("cannot open this workspace") ||
    lower.includes("distribution")
  ) {
    add(
      "Check WSL",
      "Open PowerShell and run `wsl --status`. Start a default distribution and make sure the selected folder is reachable from it.",
    );
  }
  if (
    lower.includes("install muse") ||
    lower.includes(".local/bin/muse") ||
    lower.includes("muse command")
  ) {
    add(
      "Check Muse in WSL",
      "Inside the default WSL distribution, verify `~/.local/bin/muse --version` and install the Muse CLI if it is missing.",
    );
  }
  if (
    lower.includes("auth") ||
    lower.includes("login") ||
    lower.includes("unauthenticated") ||
    lower.includes("credential")
  ) {
    add(
      "Sign in to Muse",
      "Authenticate the Muse CLI inside WSL, then return here and retry. Credentials stay in WSL and are never bundled by the app.",
    );
  }
  if (lower.includes("workspace") || lower.includes("path")) {
    add(
      "Choose an accessible folder",
      "Pick a local project folder with a stable Windows path. The folder must be visible to the WSL distribution used by the bridge.",
    );
  }
  if (steps.length === 0) {
    add(
      "Verify the installation",
      "Check that the sidecar and its dependencies match this app build, then retry the connection.",
    );
  }
  add(
    "Retry the connection",
    "After correcting the reported issue, choose Try again. The current conversation and its local history remain available.",
  );
  return steps;
}

/**
 * macOS runs the native `muse` CLI directly as the sidecar: there is no WSL
 * layer, so recovery points at the bundled binary, the CLI's own sign-in and
 * the macOS folder permissions instead.
 */
function macRecoverySteps(kind: SidecarErrorKind, message: string): SidecarRecoveryStep[] {
  const lower = message.toLowerCase();
  const steps: SidecarRecoveryStep[] = [];
  const add = (title: string, detail: string) => {
    if (!steps.some((step) => step.title === title)) steps.push({ title, detail });
  };
  if (kind === "missing") {
    add(
      "Install the Muse CLI",
      "Choose Install Muse CLI above, or run `curl -fsSL https://dev.meta.ai/install.sh | bash` in Terminal. Muse-Desktop uses ~/.local/bin/muse.",
    );
  }
  if (
    lower.includes("install muse") ||
    lower.includes(".local/bin/muse") ||
    lower.includes("muse command")
  ) {
    add(
      "Check the Muse CLI",
      "In Terminal, run `muse --version` and install the Muse CLI if it is missing.",
    );
  }
  if (
    lower.includes("auth") ||
    lower.includes("login") ||
    lower.includes("unauthenticated") ||
    lower.includes("credential")
  ) {
    add(
      "Sign in to Muse",
      "Authenticate the Muse CLI from Terminal, then return here and retry. Credentials stay with the CLI and are never bundled by the app.",
    );
  }
  if (
    lower.includes("workspace") ||
    lower.includes("path") ||
    lower.includes("operation not permitted") ||
    lower.includes("permission denied")
  ) {
    add(
      "Choose an accessible folder",
      "Pick a local project folder. Folders under Desktop, Documents or Downloads may require allowing Muse-Desktop in System Settings › Privacy & Security › Files and Folders.",
    );
  }
  if (lower.includes("damaged") || lower.includes("quarantine") || lower.includes("cannot be opened")) {
    add(
      "Allow the sidecar to run",
      "macOS Gatekeeper blocked an unsigned binary. Open System Settings › Privacy & Security and choose Open Anyway, or reinstall a signed build.",
    );
  }
  if (steps.length === 0) {
    add(
      "Verify the installation",
      "Check that the sidecar and its dependencies match this app build, then retry the connection.",
    );
  }
  add(
    "Retry the connection",
    "After correcting the reported issue, choose Try again. The current conversation and its local history remain available.",
  );
  return steps;
}
