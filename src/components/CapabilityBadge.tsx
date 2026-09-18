import {
  capabilityAccessibleLabel,
  capabilityDescription,
  capabilityLabel,
  capabilityNextStep,
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
  const nextStep = capabilityNextStep(status);
  const descriptionId = useId();
  return (
    <>
      <span
        className={`capability-badge capability-${status}`}
        title={`${description} ${nextStep}`}
        aria-label={capabilityAccessibleLabel(status, reason)}
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
