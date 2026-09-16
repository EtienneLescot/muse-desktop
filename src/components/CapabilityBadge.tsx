import {
  capabilityDescription,
  capabilityLabel,
  type CapabilityStatus,
} from "../lib/capability";

interface Props {
  status: CapabilityStatus;
  reason?: string;
}

/** Small, non-alarming state marker for capabilities with different wiring levels. */
export function CapabilityBadge({ status, reason }: Props) {
  return (
    <span
      className={`capability-badge capability-${status}`}
      title={capabilityDescription(status, reason)}
    >
      {capabilityLabel(status)}
    </span>
  );
}
