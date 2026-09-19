import type { BrowserElementAnchor } from "./browserAnnotate";
import type { HostSkill } from "./hostSkills";

/** Browser actions that may be exposed by a Muse host skill catalogue. */
export type BrowserSkillAction =
  | "observe"
  | "click"
  | "type"
  | "navigate"
  | "openTab"
  | "download";

const SELECTOR_ALIASES: Record<BrowserSkillAction, readonly string[]> = {
  observe: ["browser.observe", "browser/observe", "browser-observe"],
  click: ["browser.click", "browser/click", "browser-click"],
  type: ["browser.type", "browser/type", "browser-type"],
  navigate: [
    "browser.navigate",
    "browser.navigation",
    "browser/navigate",
    "browser/navigation",
    "browser-navigate",
  ],
  openTab: [
    "browser.open-tab",
    "browser.open_tab",
    "browser.openTab",
    "browser/open-tab",
  ],
  download: ["browser.download", "browser/download", "browser-download"],
};

function normalizedSelector(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_]+/g, "-");
}

/** Return a browser skill only when the connected host advertised it. */
export function findBrowserSkill(
  skills: readonly HostSkill[],
  action: BrowserSkillAction,
): HostSkill | null {
  const aliases = new Set(SELECTOR_ALIASES[action].map(normalizedSelector));
  return skills.find((skill) => aliases.has(normalizedSelector(skill.selector))) ?? null;
}

/** Return true only when a selector is both a browser action and host-advertised. */
export function isAdvertisedBrowserSkill(
  skills: readonly HostSkill[],
  selector: string,
): boolean {
  const normalized = normalizedSelector(selector);
  if (normalized.length === 0) return false;
  return (Object.values(SELECTOR_ALIASES) as readonly (readonly string[])[])
    .some((aliases) => aliases.some((alias) => normalizedSelector(alias) === normalized))
    && skills.some((skill) => normalizedSelector(skill.selector) === normalized);
}

function bounded(value: string | undefined, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.replace(/\s+/g, " ").trim();
  return trimmed.length > 0 ? Array.from(trimmed).slice(0, max).join("") : undefined;
}

/**
 * Build the small JSON argument passed to a host-owned browser skill. Page
 * text is never forwarded implicitly: only the URL and the user's explicit
 * selected element/value cross the skill boundary, each with a hard limit.
 */
export function buildBrowserSkillArguments(
  action: BrowserSkillAction,
  url: string,
  element?: BrowserElementAnchor | null,
  value?: string,
): string {
  const payload: Record<string, unknown> = {
    action,
    url: bounded(url, 2_000) ?? "",
  };
  if (element !== null && element !== undefined) {
    payload.element = {
      selector: bounded(element.selector, 320),
      tag: bounded(element.tag, 64),
      ...(bounded(element.role, 120) ? { role: bounded(element.role, 120) } : {}),
      ...(bounded(element.label, 240) ? { label: bounded(element.label, 240) } : {}),
      ...(bounded(element.text, 240) ? { text: bounded(element.text, 240) } : {}),
      ...(bounded(element.href, 2_000) ? { href: bounded(element.href, 2_000) } : {}),
    };
  }
  const text = bounded(value, 2_000);
  if (text !== undefined) payload.value = text;
  const serialized = JSON.stringify(payload);
  if (serialized.length <= 8_000) return serialized;
  // Escaping quotes/backslashes can make the serialized form larger than the
  // per-field character bounds. Keep the JSON valid by rebuilding a smaller
  // explicit projection instead of cutting a serialized string in half.
  const compact: Record<string, unknown> = {
    action,
    url: bounded(url, 1_000) ?? "",
  };
  if (element !== null && element !== undefined) {
    compact.element = {
      selector: bounded(element.selector, 160),
      tag: bounded(element.tag, 64),
    };
  }
  const compactValue = bounded(value, 1_000);
  if (compactValue !== undefined) compact.value = compactValue;
  return JSON.stringify(compact);
}
