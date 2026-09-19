import type { HostSkill } from "./hostSkills";
import type { DesktopWindow } from "./desktopControl";

export type DesktopSkillAction =
  | "observe"
  | "focus"
  | "click"
  | "type"
  | "key"
  | "screenshot";

const SELECTOR_ALIASES: Record<DesktopSkillAction, readonly string[]> = {
  observe: ["computer.observe", "computer/observe", "computer-observe"],
  focus: ["computer.focus", "computer/focus", "computer-focus"],
  click: ["computer.click", "computer/click", "computer-click"],
  type: ["computer.type", "computer/type", "computer-type"],
  key: ["computer.key", "computer/key", "computer-key", "computer.press"],
  screenshot: [
    "computer.screenshot",
    "computer/screenshot",
    "computer-screenshot",
  ],
};

function normalizedSelector(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_]+/g, "-");
}

export function findDesktopSkill(
  skills: readonly HostSkill[],
  action: DesktopSkillAction,
): HostSkill | null {
  const aliases = new Set(SELECTOR_ALIASES[action].map(normalizedSelector));
  return skills.find((skill) => aliases.has(normalizedSelector(skill.selector))) ?? null;
}

export function isAdvertisedDesktopSkill(
  skills: readonly HostSkill[],
  selector: string,
): boolean {
  const normalized = normalizedSelector(selector);
  return (Object.values(SELECTOR_ALIASES) as readonly (readonly string[])[])
    .some((aliases) => aliases.some((alias) => normalizedSelector(alias) === normalized))
    && skills.some((skill) => normalizedSelector(skill.selector) === normalized);
}

function bounded(value: string | undefined, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.replace(/\s+/g, " ").trim();
  return trimmed.length > 0 ? Array.from(trimmed).slice(0, max).join("") : undefined;
}

export function buildDesktopSkillArguments(
  action: DesktopSkillAction,
  window: DesktopWindow,
  value?: string,
  x?: number,
  y?: number,
): string {
  const payload: Record<string, unknown> = {
    action,
    window: {
      id: bounded(window.id, 80) ?? "",
      title: bounded(window.title, 240) ?? "",
      bounds: window.bounds,
    },
  };
  if (Number.isInteger(x) && Number.isInteger(y)) payload.point = { x, y };
  const boundedValue = bounded(value, 2_000);
  if (boundedValue !== undefined) payload.value = boundedValue;
  const serialized = JSON.stringify(payload);
  return serialized.length <= 8_000
    ? serialized
    : JSON.stringify({ action, window: { id: bounded(window.id, 80) ?? "" } });
}

