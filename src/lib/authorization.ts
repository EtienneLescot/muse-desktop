/**
 * Global authorization posture for tool actions.
 *
 * The product posture is mapped to the closed approval modes exposed by MSP.
 * The host alone decides which actions prompt; the client never answers a
 * host prompt on the user's behalf.
 * This module is deliberately dependency-free and can be tested without a
 * browser or Tauri.
 */

export type AuthorizationMode = "ask" | "workspace" | "yolo";

export type ConnectorTransport = "local" | "remote";

/** Closed values accepted by the MSP `session/*ApprovalMode` methods. */
export type MuseHostApprovalMode =
  | "onRequest"
  | "promptUnmatched"
  | "allowAll";

export const AUTHORIZATION_MODE_KEY = "muse-desktop.authorization-mode.v1";
export const DEFAULT_AUTHORIZATION_MODE: AuthorizationMode = "ask";

export const AUTHORIZATION_MODES: readonly AuthorizationMode[] = [
  "ask",
  "workspace",
  "yolo",
];

export function isAuthorizationMode(value: unknown): value is AuthorizationMode {
  return value === "ask" || value === "workspace" || value === "yolo";
}

export function parseAuthorizationMode(value: unknown): AuthorizationMode {
  return isAuthorizationMode(value) ? value : DEFAULT_AUTHORIZATION_MODE;
}

export function authorizationModeLabel(mode: AuthorizationMode): string {
  switch (mode) {
    case "workspace":
      // Says what the engine does (`onRequest`): the app approves nothing itself.
      return "Ask only for more access";
    case "yolo":
      return "YOLO";
    default:
      return "Ask for approval";
  }
}

/**
 * The engine's own semantic, and no promise beyond the 1.4.2 measurements on
 * Windows (docs/evidence/2026-10-05-roadmap-closure/m0-06-verdict-matrix-1.4.2.json
 * and the in-app runs of m0-05-06-approvals.json): `promptUnmatched` and
 * `onRequest` asked for every shell action measured, none ran unprompted, and
 * `allowAll` never asked while the Isolation sandbox still blocked out-of-root
 * writes and network.
 */
export function authorizationModeDescription(mode: AuthorizationMode): string {
  switch (mode) {
    case "workspace":
      return "The engine's sandbox decides when Muse asks. On Windows it asks for shell commands.";
    case "yolo":
      return "Muse never asks. Your Isolation setting still limits what an action can reach.";
    default:
      return "Muse asks before any action the engine's own rules do not allow.";
  }
}

/**
 * Connector calls are explicit user actions, but they still follow the same
 * global posture as host tools. A remote call is always a network action, so
 * the workspace posture keeps a review even when Isolation allows network.
 */
export function connectorCallRequiresApproval(
  mode: AuthorizationMode,
  transport: ConnectorTransport,
): boolean {
  return mode === "ask" || (mode === "workspace" && transport === "remote");
}

/**
 * Translate product language to the host's stable, closed enum. Host meanings:
 * `promptUnmatched` prompts for anything no rule matches, `onRequest` runs
 * tools sandboxed and prompts only on explicit permission requests,
 * `allowAll` never prompts.
 */
export function hostApprovalMode(mode: AuthorizationMode): MuseHostApprovalMode {
  switch (mode) {
    case "workspace":
      return "onRequest";
    case "yolo":
      return "allowAll";
    default:
      return "promptUnmatched";
  }
}

/**
 * Bring one session to the selector's posture, unless the host already
 * reports it (`effective`). The selector is re-read after each host answer,
 * so a change made while a call was in flight still lands instead of being
 * lost; a host that keeps another mode is an error, never accepted.
 */
export async function projectApprovalMode(
  selector: () => AuthorizationMode,
  setMode: (mode: AuthorizationMode) => Promise<Record<string, unknown>>,
  effective?: unknown,
): Promise<void> {
  for (;;) {
    const mode = selector();
    if (effective === hostApprovalMode(mode)) return;
    const result = await setMode(mode);
    effective = (result.effectiveMode as Record<string, unknown> | undefined)?.mode;
    if (result.status !== "accepted" || effective !== hostApprovalMode(mode)) {
      throw new Error("host did not confirm the requested approval posture");
    }
  }
}

/** Translate a host projection back to the product selector language. */
export function productAuthorizationMode(mode: string): AuthorizationMode | null {
  switch (mode) {
    case "promptUnmatched":
      return "ask";
    case "onRequest":
      return "workspace";
    case "allowAll":
      return "yolo";
    default:
      return null;
  }
}
