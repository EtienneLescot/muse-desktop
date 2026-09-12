/**
 * Pure helpers for suspended input prompts (`userInput/requested`).
 *
 * No imports: safe to unit-test on the built-in node:test runner and to
 * reuse from the hook. The host is the final validator (-32057); these
 * helpers only shape locally-valid payloads.
 */

export interface InputOption {
  label: string;
  description: string;
}

export interface InputQuestion {
  id: string;
  header: string;
  question: string;
  mode: "single" | "multiple";
  minSelections?: number;
  maxSelections?: number;
  options: InputOption[];
}

export interface InputRequest {
  session_id: string;
  input_id: string;
  tool_name: string;
  questions: InputQuestion[];
}

/** One answer in wire shape: exactly one payload key besides questionId. */
export interface InputAnswer {
  questionId: string;
  selectedLabel?: string;
  selectedLabels?: string[];
  freeText?: string;
}

/** User's picks per question: chosen labels plus free text. */
export interface InputPicks {
  labels: string[];
  text: string;
}

/**
 * Parse an `input_request` payload into questions. Returns null when the
 * payload carries no answerable question (caller falls back to a log line).
 */
export function parseInputRequest(sessionId: string, payload: string): InputRequest | null {
  let obj: Record<string, unknown>;
  try {
    const v: unknown = JSON.parse(payload);
    if (typeof v !== "object" || v === null) return null;
    obj = v as Record<string, unknown>;
  } catch {
    return null;
  }
  const inputId =
    (typeof obj.inputId === "string" && obj.inputId) ||
    (typeof obj.request_id === "string" && obj.request_id) ||
    null;
  if (inputId === null) return null;
  const rawQs = Array.isArray(obj.questions) ? obj.questions : [];
  const questions: InputQuestion[] = [];
  for (const raw of rawQs.slice(0, 10)) {
    if (typeof raw !== "object" || raw === null) continue;
    const q = raw as Record<string, unknown>;
    if (typeof q.id !== "string" || q.id.length === 0) continue;
    if (q.mode !== "single" && q.mode !== "multiple") continue;
    const rawOpts = Array.isArray(q.options) ? q.options : [];
    const options: InputOption[] = [];
    for (const rawO of rawOpts.slice(0, 20)) {
      if (typeof rawO !== "object" || rawO === null) continue;
      const o = rawO as Record<string, unknown>;
      if (typeof o.label !== "string" || o.label.length === 0) continue;
      options.push({
        label: o.label,
        description: typeof o.description === "string" ? o.description : "",
      });
    }
    questions.push({
      id: q.id,
      header: typeof q.header === "string" ? q.header : "",
      question: typeof q.question === "string" ? q.question : "",
      mode: q.mode,
      minSelections: typeof q.minSelections === "number" ? q.minSelections : undefined,
      maxSelections: typeof q.maxSelections === "number" ? q.maxSelections : undefined,
      options,
    });
  }
  if (questions.length === 0) return null;
  return {
    session_id: sessionId,
    input_id: inputId,
    tool_name: typeof obj.toolName === "string" ? obj.toolName : "input",
    questions,
  };
}

/**
 * Build wire answers from per-question picks.
 * Single mode takes the first label; multiple takes all labels; no labels
 * means free text (capped at 500 per protocol). Throws on empty questions —
 * every question must be answered.
 */
export function buildAnswers(
  questions: InputQuestion[],
  picks: Record<string, InputPicks>,
): InputAnswer[] {
  return questions.map((q) => {
    const p = picks[q.id] ?? { labels: [], text: "" };
    const labels = [...new Set(p.labels)].filter((l) =>
      q.options.some((o) => o.label === l),
    );
    if (labels.length > 0) {
      return q.mode === "single"
        ? { questionId: q.id, selectedLabel: labels[0] }
        : { questionId: q.id, selectedLabels: labels };
    }
    const text = p.text.trim().slice(0, 500);
    if (text.length === 0) throw new Error(`question "${q.id}" needs an answer`);
    return { questionId: q.id, freeText: text };
  });
}
