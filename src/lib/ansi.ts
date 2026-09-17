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
  fontStyle?: "italic";
  opacity?: number;
  textDecoration?: "underline" | "line-through" | "underline line-through";
  filter?: "invert(1)";
}

export interface AnsiChunk {
  text: string;
  style: AnsiStyle;
}

interface AnsiState {
  color: string;
  backgroundColor: string;
  fontWeight?: "600";
  fontStyle?: "italic";
  opacity: number;
  underline: boolean;
  strike: boolean;
  inverse: boolean;
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
  if (state.fontStyle === "italic") style.fontStyle = state.fontStyle;
  if (state.opacity !== 1) style.opacity = state.opacity;
  if (state.underline || state.strike) {
    style.textDecoration = state.underline && state.strike
      ? "underline line-through"
      : state.underline ? "underline" : "line-through";
  }
  if (state.inverse) style.filter = "invert(1)";
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
      state.fontStyle = undefined;
      state.opacity = 1;
      state.underline = false;
      state.strike = false;
      state.inverse = false;
    } else if (code === 1) state.fontWeight = "600";
    else if (code === 2) state.opacity = 0.68;
    else if (code === 3) state.fontStyle = "italic";
    else if (code === 22) { state.fontWeight = undefined; state.opacity = 1; }
    else if (code === 4) state.underline = true;
    else if (code === 7) state.inverse = true;
    else if (code === 9) state.strike = true;
    else if (code === 23) state.fontStyle = undefined;
    else if (code === 24) {
      state.underline = false;
    }
    else if (code === 27) state.inverse = false;
    else if (code === 29) {
      state.strike = false;
    }
    else if (code === 39) state.color = "";
    else if (code === 49) state.backgroundColor = "";
    else if (code >= 30 && code <= 37) state.color = COLORS[code - 30];
    else if (code >= 90 && code <= 97) state.color = BRIGHT_COLORS[code - 90];
    else if (code >= 40 && code <= 47) state.backgroundColor = COLORS[code - 40];
    else if (code >= 100 && code <= 107) state.backgroundColor = BRIGHT_COLORS[code - 100];
    else if (code === 38 || code === 48) {
      // Support indexed 256-color and truecolor forms:
      // 38;5;n / 48;5;n and 38;2;r;g;b / 48;2;r;g;b.
      const mode = codes[index + 1];
      const value = codes[index + 2];
      if (mode === 5 && Number.isInteger(value) && value >= 0 && value <= 255) {
        const color = indexedColor(value);
        if (code === 38) state.color = color;
        else state.backgroundColor = color;
        index += 2;
      } else if (mode === 2) {
        const red = codes[index + 2];
        const green = codes[index + 3];
        const blue = codes[index + 4];
        const channels = [red, green, blue];
        if (channels.every((channel) => Number.isInteger(channel) && channel >= 0 && channel <= 255)) {
          const color = `rgb(${red}, ${green}, ${blue})`;
          if (code === 38) state.color = color;
          else state.backgroundColor = color;
          index += 4;
        }
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
    fontStyle: undefined,
    opacity: 1,
    underline: false,
    strike: false,
    inverse: false,
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
