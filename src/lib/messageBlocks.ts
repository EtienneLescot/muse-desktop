export type MessageBlock =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string; language: string };

/** Streaming-safe fenced blocks. Unclosed fences render as code while streaming.
 * Raw HTML remains text; rendering never uses innerHTML. */
export function messageBlocks(text: string): MessageBlock[] {
  const blocks: MessageBlock[] = [];
  let lines: string[] = [];
  let language: string | null = null;
  for (const line of text.split("\n")) {
    const fence = /^\s*```([^`]*)$/.exec(line);
    if (fence) {
      if (language === null) {
        if (lines.length) blocks.push({ kind: "text", text: lines.join("\n") });
        language = fence[1].trim();
      } else {
        blocks.push({ kind: "code", text: lines.join("\n"), language });
        language = null;
      }
      lines = [];
    } else lines.push(line);
  }
  if (lines.length)
    blocks.push(
      language === null
        ? { kind: "text", text: lines.join("\n") }
        : { kind: "code", text: lines.join("\n"), language },
    );
  return blocks;
}
