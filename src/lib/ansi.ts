/** Small, dependency-free ANSI SGR parser for the terminal preview.
 *
 * The PTY keeps the original bytes; this view only translates common style
 * sequences into data suitable for React. Unknown cursor/control sequences are
 * removed from the visual text instead of being interpreted as markup.
 */

export interface AnsiStyle {
  color?: string;
  backgroundColor?: string;
  fontWeight?: "600";
  opacity?: number;
  textDecoration?: "underline";
}

export interface AnsiChunk {
  text: string;
  style: AnsiStyle;
}

interface AnsiState {
  color: string;
  backgroundColor: string;
  fontWeight?: "600";
  opacity: number;
  textDecoration?: "underline";
}

const COLORS = [
  "#111827", "#ef4444", "#22c55e", "#eab308",
  "#3b82f6", "#a855f7", "#06b6d4", "#e5e7eb",
];
const BRIGHT_COLORS = [
  "#6b7280", "#f87171", "#4ade80", "#fde047",
  "#60a5fa", "#c084fc", "#22d3ee", "#ffffff",
];

function indexedColor(value: number): string {
  if (value < 16) return value < 8 ? COLORS[value] : BRIGHT_COLORS[value - 8];
  if (value >= 232) {
    const gray = 8 + (value - 232) * 10;
    return `rgb(${gray}, ${gray}, ${gray})`;
  }
  const index = value - 16;
  const red = Math.floor(index / 36);
  const green = Math.floor((index % 36) / 6);
  const blue = index % 6;
  const channel = (part: number) => part === 0 ? 0 : 55 + part * 40;
  return `rgb(${channel(red)}, ${channel(green)}, ${channel(blue)})`;
}

function stripControls(value: string): string {
  return value
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[()][0-2A-Z]/g, "")
    .replace(/\x1b./g, "");
}

function styleOf(state: AnsiState): AnsiStyle {
  const style: AnsiStyle = {};
  if (state.color !== "") style.color = state.color;
  if (state.backgroundColor !== "") style.backgroundColor = state.backgroundColor;
  if (state.fontWeight === "600") style.fontWeight = state.fontWeight;
  if (state.opacity !== 1) style.opacity = state.opacity;
  if (state.textDecoration === "underline") style.textDecoration = state.textDecoration;
  return style;
}

function applyCodes(state: AnsiState, raw: string): void {
  const codes = raw === "" ? [0] : raw.split(";").map(Number);
  for (let index = 0; index < codes.length; index += 1) {
    const code = codes[index];
    if (code === 0) {
      state.color = "";
      state.backgroundColor = "";
      state.fontWeight = undefined;
      state.opacity = 1;
      state.textDecoration = undefined;
    } else if (code === 1) state.fontWeight = "600";
    else if (code === 2) state.opacity = 0.68;
    else if (code === 22) { state.fontWeight = undefined; state.opacity = 1; }
    else if (code === 4) state.textDecoration = "underline";
    else if (code === 24) state.textDecoration = undefined;
    else if (code === 39) state.color = "";
    else if (code === 49) state.backgroundColor = "";
    else if (code >= 30 && code <= 37) state.color = COLORS[code - 30];
    else if (code >= 90 && code <= 97) state.color = BRIGHT_COLORS[code - 90];
    else if (code >= 40 && code <= 47) state.backgroundColor = COLORS[code - 40];
    else if (code >= 100 && code <= 107) state.backgroundColor = BRIGHT_COLORS[code - 100];
    else if (code === 38 || code === 48) {
      // Support indexed 256-color form: 38;5;n / 48;5;n.
      const mode = codes[index + 1];
      const value = codes[index + 2];
      if (mode === 5 && Number.isInteger(value) && value >= 0 && value <= 255) {
        const color = indexedColor(value);
        if (code === 38) state.color = color;
        else state.backgroundColor = color;
        index += 2;
      }
    }
  }
}

/** Convert ANSI text into safe, styled chunks. No HTML is interpreted. */
export function parseAnsi(text: string): AnsiChunk[] {
  const chunks: AnsiChunk[] = [];
  const state = {
    color: "",
    backgroundColor: "",
    fontWeight: undefined,
    opacity: 1,
    textDecoration: undefined,
  };
  const sgr = /\x1b\[([0-9;]*)m/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = sgr.exec(text)) !== null) {
    const visible = stripControls(text.slice(last, match.index));
    if (visible) chunks.push({ text: visible, style: styleOf(state) });
    applyCodes(state, match[1]);
    last = match.index + match[0].length;
  }
  const tail = stripControls(text.slice(last));
  if (tail) chunks.push({ text: tail, style: styleOf(state) });
  return chunks;
}
