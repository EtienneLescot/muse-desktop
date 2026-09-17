/**
 * M4-08 voice input boundary.
 *
 * The browser speech API is used only for an explicit, user-triggered local
 * transcription. Audio is never persisted or sent to the Muse host; the
 * resulting text remains editable in the composer before it is submitted.
 */

export const MAX_VOICE_TRANSCRIPT_CHARS = 8_000;

export interface VoiceRecognitionResult {
  transcript: string;
  isFinal: boolean;
}

export interface VoiceRecognitionEvent {
  resultIndex: number;
  results: ArrayLike<{
    isFinal: boolean;
    0: { transcript: string };
  }>;
}

export interface VoiceRecognitionErrorEvent {
  error?: string;
  message?: string;
}

export interface VoiceRecognition {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: VoiceRecognitionEvent) => void) | null;
  onerror: ((event: VoiceRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
}

export type VoiceRecognitionFactory = new () => VoiceRecognition;

/** Discover the standard or WebKit-prefixed speech recognition constructor. */
export function getVoiceRecognitionFactory(
  scope: unknown = globalThis,
): VoiceRecognitionFactory | null {
  if (typeof scope !== "object" || scope === null) return null;
  const value = scope as Record<string, unknown>;
  const factory = value.SpeechRecognition ?? value.webkitSpeechRecognition;
  return typeof factory === "function" ? (factory as VoiceRecognitionFactory) : null;
}

function normalizeTranscript(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** Append one transcription while preserving an editable draft and a bound. */
export function appendVoiceTranscript(current: string, transcript: string): string {
  const next = normalizeTranscript(transcript);
  if (next.length === 0) return current;
  const separator = current.length === 0 || /\s$/.test(current) ? "" : " ";
  return Array.from(`${current}${separator}${next}`)
    .slice(0, MAX_VOICE_TRANSCRIPT_CHARS)
    .join("");
}

/** Extract the latest visible transcript from a SpeechRecognition result list. */
export function transcriptFromVoiceEvent(event: VoiceRecognitionEvent): string {
  const parts: string[] = [];
  for (let i = 0; i < event.results.length; i += 1) {
    const result = event.results[i];
    const transcript = result?.[0]?.transcript;
    if (typeof transcript === "string") parts.push(transcript);
  }
  return normalizeTranscript(parts.join(" "));
}

/** Keep browser error labels calm and free of raw implementation details. */
export function voiceErrorMessage(event: VoiceRecognitionErrorEvent): string {
  const code = typeof event.error === "string" ? event.error.toLowerCase() : "";
  if (code === "not-allowed" || code === "service-not-allowed") {
    return "Microphone access was denied. You can type the message instead.";
  }
  if (code === "no-speech") return "No speech detected. Try again when you are ready.";
  if (code === "audio-capture") return "No microphone is available. You can type the message instead.";
  return "Voice input stopped. You can edit the transcript or type the message instead.";
}
