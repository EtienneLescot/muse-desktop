import { useEffect, useRef, useState } from "react";
import {
  buildAnswers,
  type InputAnswer,
  type InputPicks,
  type InputRequest,
} from "../hooks/useMuseSessions";

interface Props {
  requests: InputRequest[];
  onAnswer: (
    sessionId: string,
    inputId: string,
    answers: InputAnswer[],
  ) => void;
  onSkip: (sessionId: string, inputId: string) => void;
}

/**
 * Answerable input prompts for the active session. The turn suspends until
 * answered: single-choice renders one-click buttons, multiple renders
 * checkboxes + submit, option-less questions render a free-text field.
 * Skip declines (the tool call resolves cancelled, model-visible).
 */
export function InputPanel({ requests, onAnswer, onSkip }: Props) {
  if (requests.length === 0) return null;
  return (
    <section className="approvals" role="region" aria-label="Pending input">
      {requests.map((r) => (
        <InputCard
          key={`${r.session_id}:${r.input_id}`}
          request={r}
          onAnswer={onAnswer}
          onSkip={onSkip}
        />
      ))}
    </section>
  );
}

function InputCard({
  request,
  onAnswer,
  onSkip,
}: {
  request: InputRequest;
  onAnswer: Props["onAnswer"];
  onSkip: Props["onSkip"];
}) {
  const [picks, setPicks] = useState<Record<string, InputPicks>>({});
  const [localError, setLocalError] = useState<string | null>(null);
  // US-32: move focus into the new request so it is answerable by keyboard.
  const cardRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = cardRef.current?.querySelector<HTMLElement>(
      "button:not(:disabled), textarea, input:not(:disabled)",
    );
    el?.focus();
    // Focus once per request id; questions are stable per request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request.input_id]);

  function setLabels(qid: string, labels: string[]): void {
    setPicks((cur) => ({
      ...cur,
      [qid]: { labels, text: cur[qid]?.text ?? "" },
    }));
  }

  function setText(qid: string, text: string): void {
    setPicks((cur) => ({
      ...cur,
      [qid]: { labels: cur[qid]?.labels ?? [], text },
    }));
  }

  function submit(): void {
    try {
      setLocalError(null);
      const answers = buildAnswers(request.questions, picks);
      onAnswer(request.session_id, request.input_id, answers);
    } catch (e) {
      setLocalError(String(e instanceof Error ? e.message : e));
    }
  }

  // US-32: Ctrl+Enter answers, Escape skips — full keyboard operation.
  function onCardKeyDown(e: React.KeyboardEvent): void {
    if (e.key === "Enter" && e.ctrlKey) {
      e.preventDefault();
      submit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      onSkip(request.session_id, request.input_id);
    }
  }

  return (
    <div
      className="approval"
      ref={cardRef}
      role="group"
      aria-label={`Input needed${request.tool_name !== "input" ? ` from ${request.tool_name}` : ""}`}
      onKeyDown={onCardKeyDown}
    >
      <div className="approval-text">
        <strong>
          Input needed
          {request.tool_name !== "input" ? `: ${request.tool_name}` : ""}
        </strong>
        {request.questions.map((q) => (
          <div
            key={q.id}
            className="input-question"
            role="group"
            aria-label={q.question}
          >
            {q.header.length > 0 && <div className="muted">{q.header}</div>}
            <div>{q.question}</div>
            {q.options.length > 0 ? (
              q.mode === "single" ? (
                <div
                  className="approval-actions"
                  role="group"
                  aria-label={`${q.question} — choices`}
                >
                  {q.options.map((o) => (
                    <button
                      key={o.label}
                      type="button"
                      className={
                        picks[q.id]?.labels[0] === o.label ? "approve" : ""
                      }
                      title={`${o.description} (Enter to pick)`.trim()}
                      aria-pressed={picks[q.id]?.labels[0] === o.label}
                      onClick={() => setLabels(q.id, [o.label])}
                    >
                      {o.label}
                    </button>
                  ))}
                </div>
              ) : (
                <div className="approval-actions">
                  {q.options.map((o) => (
                    <label
                      key={o.label}
                      className="check"
                      title={o.description}
                    >
                      <input
                        type="checkbox"
                        checked={picks[q.id]?.labels.includes(o.label) ?? false}
                        onChange={(e) => {
                          const cur = picks[q.id]?.labels ?? [];
                          setLabels(
                            q.id,
                            e.target.checked
                              ? [...cur, o.label]
                              : cur.filter((l) => l !== o.label),
                          );
                        }}
                      />
                      {o.label}
                    </label>
                  ))}
                </div>
              )
            ) : (
              <textarea
                rows={2}
                maxLength={500}
                value={picks[q.id]?.text ?? ""}
                onChange={(e) => setText(q.id, e.target.value)}
                placeholder="Votre réponse (500 caractères maximum)…"
                aria-label={q.question}
              />
            )}
          </div>
        ))}
        {localError && (
          <span className="error" role="alert">
            {localError}
          </span>
        )}
      </div>
      <div className="approval-actions">
        <button
          type="button"
          className="approve"
          title="Envoyer la réponse (Ctrl+Enter)"
          onClick={submit}
        >
          Envoyer la réponse
        </button>
        <button
          type="button"
          className="deny"
          title="Ignorer cette demande (Échap)"
          onClick={() => onSkip(request.session_id, request.input_id)}
        >
          Ignorer
        </button>
      </div>
    </div>
  );
}
