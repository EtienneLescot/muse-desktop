/** Shared vocabulary for surfaces that are real, local-only, manual, or unavailable. */
export type CapabilityStatus = "available" | "local" | "manual" | "unavailable";

const LABELS: Record<CapabilityStatus, string> = {
  available: "Available",
  local: "Local",
  manual: "Manual",
  unavailable: "Not connected",
};

const DEFAULT_DETAILS: Record<CapabilityStatus, string> = {
  available: "This capability is connected and ready to use.",
  local: "This capability runs locally and does not call a remote service.",
  manual: "This capability prepares an action for you to run or confirm manually.",
  unavailable: "This capability is not connected in this build.",
};

export function capabilityLabel(status: CapabilityStatus): string {
  return LABELS[status];
}

export function capabilityDescription(
  status: CapabilityStatus,
  reason?: string,
): string {
  const trimmed = reason?.trim();
  return trimmed ? trimmed : DEFAULT_DETAILS[status];
}
