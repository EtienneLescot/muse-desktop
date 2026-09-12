import { useState } from "react";
import {
  buildAnswers,
  type InputAnswer,
  type InputPicks,
  type InputRequest,
} from "../hooks/useMuseSessions";

interface Props {
  requests: InputRequest[];
  onAnswer: (sessionId: string, inputId: string, answers: InputAnswer[]) => void;
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
    <section className="approvals" aria-label="Pending input">
      {requests.map((r) => (
        <InputCard key={`${r.session_id}:${r.input_id}`} request={r} onAnswer={onAnswer} onSkip={onSkip} />
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

  function setLabels(qid: string, labels: string[]): void {
    setPicks((cur) => ({ ...cur, [qid]: { labels, text: cur[qid]?.text ?? "" } }));
  }

  function setText(qid: string, text: string): void {
    setPicks((cur) => ({ ...cur, [qid]: { labels: cur[qid]?.labels ?? [], text } }));
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

  return (
    <div className="approval">
      <div className="approval-text">
        <strong>Input needed{request.tool_name !== "input" ? `: ${request.tool_name}` : ""}</strong>
        {request.questions.map((q) => (
          <div key={q.id} className="input-question">
            {q.header.length > 0 && <div className="muted">{q.header}</div>}
            <div>{q.question}</div>
            {q.options.length > 0 ? (
              q.mode === "single" ? (
                <div className="approval-actions">
                  {q.options.map((o) => (
                    <button
                      key={o.label}
                      className={picks[q.id]?.labels[0] === o.label ? "approve" : ""}
                      title={o.description}
                      onClick={() => setLabels(q.id, [o.label])}
                    >
                      {o.label}
                    </button>
                  ))}
                </div>
              ) : (
                <div className="approval-actions">
                  {q.options.map((o) => (
                    <label key={o.label} className="check" title={o.description}>
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
                placeholder="Type your answer (max 500 chars)…"
                aria-label={q.question}
              />
            )}
          </div>
        ))}
        {localError && <span className="error">{localError}</span>}
      </div>
      <div className="approval-actions">
        <button className="approve" onClick={submit}>
          Send answer
        </button>
        <button
          className="deny"
          onClick={() => onSkip(request.session_id, request.input_id)}
        >
          Skip
        </button>
      </div>
    </div>
  );
}
