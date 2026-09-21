import { useEffect } from "react";
import { POPOVER_ATTRIBUTE, popoverToDismiss, type OpenPopover } from "../lib/popovers";

/** Read the transient popovers currently open, with containment resolved. */
function openPopoversFrom(target: EventTarget | null): OpenPopover[] {
  const node = target instanceof Node ? target : null;
  return [...document.querySelectorAll<HTMLDetailsElement>(`details[open][${POPOVER_ATTRIBUTE}]`)].map(
    (details, index) => ({
      id: details.className || `popover-${index}`,
      containsTarget: node !== null && details.contains(node),
    }),
  );
}

/**
 * Dismiss transient popovers on an outside click or on Escape.
 *
 * Mounted once for the whole app: any `<details data-popover>` gets the
 * behaviour, so a new picker cannot be added without it by forgetting a
 * per-control effect. Content disclosures carry no marker and are never closed.
 */
export function useDismissablePopovers(): void {
  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const stale = popoverToDismiss(openPopoversFrom(event.target));
      if (stale === null) return;
      for (const details of document.querySelectorAll<HTMLDetailsElement>(`details[open][${POPOVER_ATTRIBUTE}]`)) {
        details.removeAttribute("open");
      }
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // Escape closes every open popover and is not consumed here, so the
      // surrounding Escape handlers (the find bar, dialogs) still receive it.
      for (const details of document.querySelectorAll<HTMLDetailsElement>(`details[open][${POPOVER_ATTRIBUTE}]`)) {
        details.removeAttribute("open");
      }
    };

    // Capture phase: an option that stops propagation must not be able to keep a
    // different popover open.
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, []);
}

/**
 * Keep `aria-expanded` on each popover's trigger in step with its `<details>`.
 *
 * A `<summary>` is not a button and exposes no expanded state, so without this
 * the trigger announces nothing and a screen-reader user cannot tell an open
 * picker from a closed one.
 */
export function usePopoverExpandedState(): void {
  useEffect(() => {
    const sync = (details: HTMLDetailsElement) => {
      const summary = details.querySelector("summary");
      if (summary === null) return;
      summary.setAttribute("aria-expanded", details.hasAttribute("open") ? "true" : "false");
    };
    const syncAll = () => {
      for (const details of document.querySelectorAll<HTMLDetailsElement>(`details[${POPOVER_ATTRIBUTE}]`)) {
        sync(details);
      }
    };
    syncAll();
    // `toggle` does not bubble, so it is observed in the capture phase.
    const onToggle = (event: Event) => {
      if (event.target instanceof HTMLDetailsElement) sync(event.target);
    };
    document.addEventListener("toggle", onToggle, true);
    // Popovers mount later, as panels and tabs open. The observer keeps their
    // announced state honest without every control having to remember.
    const observer = new MutationObserver(syncAll);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => {
      document.removeEventListener("toggle", onToggle, true);
      observer.disconnect();
    };
  }, []);
}
