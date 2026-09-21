/**
 * Which transient popover, if any, an outside interaction should dismiss.
 *
 * Why this exists, and why it is this shape. The app uses `<details>` for two
 * different jobs that must behave oppositely:
 *
 *   * **Transient popovers** — the model, reasoning-effort and authorization-mode
 *     pickers. They open over other content to make one choice, so clicking
 *     anywhere else must close them, which is what every other tool does.
 *   * **Content disclosures** — an approval card, a writer result, an engine
 *     error, a project group. These hold information the user deliberately
 *     expanded and often needs to read *while* clicking elsewhere. Closing them
 *     would discard that work, so they carry no marker and are never touched.
 *
 * HTML gives `<details>` no outside-click behaviour at all, which is why this has
 * to be added rather than relied upon.
 *
 * The rule is expressed over plain data rather than DOM nodes so it is testable
 * in this repo's Node-only test setup — no jsdom, no fake document.
 */

/** Attribute marking a `<details>` as a transient popover. */
export const POPOVER_ATTRIBUTE = "data-popover";

export interface OpenPopover {
  /** Stable identity, used only to name the winner. */
  id: string;
  /** Whether the interaction happened inside this popover or its trigger. */
  containsTarget: boolean;
}

/**
 * Pick the popover an outside interaction should close, or `null` for none.
 *
 * At most one is returned: popovers are opened one at a time, and closing every
 * open popover would fight the disclosure elements if the marker were ever
 * misapplied.
 */
export function popoverToDismiss(open: readonly OpenPopover[]): OpenPopover | null {
  // An interaction inside ANY popover is not an outside interaction for that
  // popover, and the controls are mutually exclusive in practice. Returning null
  // keeps a click on an option from also dismissing the popover it belongs to —
  // the option's own handler does that, exactly once.
  if (open.some((candidate) => candidate.containsTarget)) return null;
  return open.length > 0 ? open[0] : null;
}
