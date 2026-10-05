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
      return "Approve on my behalf";
    case "yolo":
      return "YOLO";
    default:
      return "Ask for approval";
  }
}

export function authorizationModeDescription(mode: AuthorizationMode): string {
  switch (mode) {
    case "workspace":
      return "Tools run in the sandbox without asking. Muse asks when one needs more, such as network or elevated access.";
    case "yolo":
      return "Muse never asks. Every action runs.";
    default:
      return "Muse asks before any action its rules do not already allow.";
  }
}

/**
 * Connector calls are explicit user actions, but they still follow the same
 * global posture as host tools. A remote call is always a network action,
 * which the workspace posture treats as an escalation, so it keeps a review.
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
