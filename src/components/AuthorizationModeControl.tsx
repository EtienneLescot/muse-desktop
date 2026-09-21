import { Icon } from "./Icon";
import {
  AUTHORIZATION_MODES,
  authorizationModeDescription,
  authorizationModeLabel,
  type AuthorizationMode,
} from "../lib/authorization";

interface Props {
  mode: AuthorizationMode;
  onChange: (mode: AuthorizationMode) => void;
  /** Smaller sizing for the chat composer and welcome composer. */
  compact?: boolean;
}

/**
 * Shared authorization posture selector. It intentionally lives alongside
 * the message composer so the current posture is visible at the moment the
 * user asks Muse to act, including before a conversation has started.
 */
export function AuthorizationModeControl({ mode, onChange, compact = false }: Props) {
  return (
    <details
      className={`authorization-mode-control${compact ? " authorization-mode-control-compact" : ""}`}
      data-popover
    >
      <summary
        className="authorization-mode-trigger"
        aria-label={`Authorization mode: ${authorizationModeLabel(mode)}`}
        title={authorizationModeDescription(mode)}
      >
        <Icon name="shield" />
        <span>{authorizationModeLabel(mode)}</span>
        <span className="authorization-mode-chevron" aria-hidden="true" />
      </summary>
      <div className="authorization-mode-popover" role="menu" aria-label="Authorization mode">
        {AUTHORIZATION_MODES.map((candidate) => {
          const selected = candidate === mode;
          return (
            <button
              key={candidate}
              type="button"
              role="menuitemradio"
              aria-checked={selected}
              className="authorization-mode-option"
              data-selected={selected}
              onClick={(e) => {
                e.currentTarget.closest("details")?.removeAttribute("open");
                onChange(candidate);
              }}
            >
              <span className="authorization-mode-option-check" aria-hidden="true">
                {selected ? "✓" : ""}
              </span>
              <span>
                <strong>{authorizationModeLabel(candidate)}</strong>
                <small>{authorizationModeDescription(candidate)}</small>
              </span>
            </button>
          );
        })}
      </div>
    </details>
  );
}
