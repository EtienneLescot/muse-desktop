/**
 * Global authorization posture for tool actions.
 *
 * The product posture is mapped to the closed approval modes exposed by MSP.
 * The host remains the authority for the effective policy; the client keeps
 * its local scope guard and allowlist as a second, conservative layer.
 * This module is deliberately dependency-free and can be tested without a
 * browser or Tauri.
 */

export type AuthorizationMode = "ask" | "workspace" | "yolo";

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

export interface ApprovalChoiceLike {
  choiceId: string;
  decision: string;
  scope: string;
}

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
      return "Approve local workspace actions; ask before network or elevated access.";
    case "yolo":
      return "Approve every non-denied action automatically in this trusted workspace.";
    default:
      return "Always ask before a tool changes files or uses external services.";
  }
}

/** Translate product language to the host's stable, closed enum. */
export function hostApprovalMode(mode: AuthorizationMode): MuseHostApprovalMode {
  switch (mode) {
    case "workspace":
      return "promptUnmatched";
    case "yolo":
      return "allowAll";
    default:
      return "onRequest";
  }
}

/** Translate a host projection back to the product selector language. */
export function productAuthorizationMode(mode: string): AuthorizationMode | null {
  switch (mode) {
    case "onRequest":
      return "ask";
    case "promptUnmatched":
      return "workspace";
    case "allowAll":
      return "yolo";
    default:
      return null;
  }
}

/**
 * Network, URL and elevated scopes always remain explicit in the balanced
 * posture. The matcher is intentionally conservative: an unknown scope is
 * treated as local, while recognizable external or privileged scopes prompt.
 */
export function isRiskyApprovalScope(scope: string): boolean {
  const value = scope.trim();
  if (value.length === 0) return false;
  return (
    /^(?:network|elevated|sudo|root|admin|privileged)\b/i.test(value) ||
    /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ||
    /^[a-z0-9.-]+\.[a-z]{2,}(?::\d+)?(?:\/.*)?$/i.test(value)
  );
}

/**
 * Return the host choice that may be decided automatically, or null when the
 * current posture requires the user to review the request.
 */
export function automaticApprovalChoice(
  mode: AuthorizationMode,
  choices: readonly ApprovalChoiceLike[],
): ApprovalChoiceLike | null {
  if (mode === "ask") return null;
  const choice = choices.find((candidate) => !candidate.decision.startsWith("denied"));
  if (choice === undefined) return null;
  if (
    mode === "workspace" &&
    choices.some((candidate) => isRiskyApprovalScope(candidate.scope))
  ) {
    return null;
  }
  return choice;
}
