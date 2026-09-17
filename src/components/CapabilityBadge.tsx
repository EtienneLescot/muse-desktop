import {
  capabilityDescription,
  capabilityLabel,
  type CapabilityStatus,
} from "../lib/capability";
import { useId } from "react";

interface Props {
  status: CapabilityStatus;
  reason?: string;
}

/** Small, non-alarming state marker for capabilities with different wiring levels. */
export function CapabilityBadge({ status, reason }: Props) {
  const description = capabilityDescription(status, reason);
  const descriptionId = useId();
  return (
    <>
      <span
        className={`capability-badge capability-${status}`}
        title={description}
        aria-describedby={descriptionId}
      >
        {capabilityLabel(status)}
      </span>
      <span id={descriptionId} className="sr-only">
        {description}
      </span>
    </>
  );
}
