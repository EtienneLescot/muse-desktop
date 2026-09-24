/**
 * Slash-command completion for the composer.
 *
 * The Extensions page had a Run button per skill, which sent `/name` into
 * whichever conversation happened to be open — a skill launched from a
 * settings screen, with no visible destination. The composer is where the
 * message is written, so the completion belongs here: the user types `/`
 * and picks, instead of having to know the names by heart.
 *
 * A slash command is only a command when it opens the message, the way the
 * host parses it. `/compact` written mid-sentence is text, and this must not
 * offer to complete it.
 *
 * Dependency-free so it runs under `node:test` without React or Tauri.
 */

export interface SlashCommand {
  /** Name without the leading slash (`plan`, `create-skill`). */
  name: string;
  /** One line shown under the name; may be empty. */
  description: string;
  /** Where it comes from, shown as a badge (`host`, `workspace`). */
  origin: string;
}

/** The `/query` token being typed, or null when the caret is not in one. */
export interface SlashToken {
  query: string;
  start: number;
  end: number;
}

/** Characters a command name can hold; anything else closes the token. */
const NAME_RE = /^[A-Za-z0-9_:-]*$/;

/**
 * The slash token under `caret`, or null. Only the token opening the text
 * counts (leading whitespace allowed), and only while the caret sits inside
 * it: once a space is typed the command is chosen and the completion closes.
 */
export function activeSlashToken(text: string, caret: number): SlashToken | null {
  const lead = text.length - text.trimStart().length;
  if (text[lead] !== "/") return null;
  const start = lead;
  let end = start + 1;
  while (end < text.length && NAME_RE.test(text[end])) end += 1;
  if (caret < start + 1 || caret > end) return null;
  return { query: text.slice(start + 1, end), start, end };
}

/**
 * The commands matching `query`, best first: names that start with it before
 * names that merely contain it, each group alphabetical. An empty query lists
 * everything, so typing `/` alone shows what exists.
 */
export function matchSlashCommands(
  commands: readonly SlashCommand[],
  query: string,
  limit = 8,
): SlashCommand[] {
  const needle = query.toLowerCase();
  const byName = new Map<string, SlashCommand>();
  for (const command of commands) {
    if (command.name.trim() === "") continue;
    // Host and workspace can expose the same name; the first wins, as the
    // host skill is the one the engine will actually run.
    if (!byName.has(command.name)) byName.set(command.name, command);
  }
  const all = [...byName.values()];
  const rank = (command: SlashCommand): number => {
    const name = command.name.toLowerCase();
    if (needle === "") return 0;
    if (name.startsWith(needle)) return 0;
    if (name.includes(needle)) return 1;
    return 2;
  };
  return all
    .filter((command) => rank(command) < 2)
    .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
    .slice(0, limit);
}

/** Replace the token with the chosen command, and the caret after it. */
export function applySlashCommand(
  text: string,
  token: SlashToken,
  command: SlashCommand,
): { text: string; caret: number } {
  const head = `${text.slice(0, token.start)}/${command.name} `;
  return { text: head + text.slice(token.end), caret: head.length };
}
