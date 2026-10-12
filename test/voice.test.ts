import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  abortVoiceRecognition,
  appendVoiceTranscript,
  getVoiceRecognitionFactory,
  requestVoicePermission,
  transcriptFromVoiceEvent,
  voiceErrorMessage,
  VOICE_SERVICE_NOTE,
  type VoiceRecognition,
} from "../src/lib/voice.ts";

describe("voice input boundary", () => {
  it("discovers standard and WebKit constructors", () => {
    class FakeRecognition implements Record<string, never> {}
    assert.equal(
      getVoiceRecognitionFactory({ SpeechRecognition: FakeRecognition } as unknown) !== null,
      true,
    );
    assert.equal(
      getVoiceRecognitionFactory({ webkitSpeechRecognition: FakeRecognition } as unknown) !== null,
      true,
    );
    assert.equal(getVoiceRecognitionFactory({}), null);
  });

  it("appends bounded editable transcript text", () => {
    assert.equal(appendVoiceTranscript("Draft", "  add   this "), "Draft add this");
    assert.equal(appendVoiceTranscript("Draft ", "next"), "Draft next");
    assert.equal(appendVoiceTranscript("Draft", "   "), "Draft");
    assert.ok(appendVoiceTranscript("", "x".repeat(9_000)).length <= 8_000);
  });

  it("extracts result text and keeps calm microphone errors", () => {
    assert.equal(
      transcriptFromVoiceEvent({
        resultIndex: 0,
        results: [
          { isFinal: true, 0: { transcript: "one" } },
          { isFinal: false, 0: { transcript: " two " } },
        ],
      }),
      "one two",
    );
    assert.match(voiceErrorMessage({ error: "not-allowed" }), /Microphone access was denied/);
    assert.match(voiceErrorMessage({ error: "no-speech" }), /No speech detected/);
  });

  it("preflights microphone permission and stops the temporary stream", async () => {
    let stopped = 0;
    const granted = await requestVoicePermission({
      navigator: {
        mediaDevices: {
          getUserMedia: async () => ({ getTracks: () => [{ stop: () => { stopped += 1; } }] }),
        },
      },
    });
    assert.equal(granted, "granted");
    assert.equal(stopped, 1);
    assert.equal(await requestVoicePermission({}), "unavailable");
    assert.equal(await requestVoicePermission({
      navigator: { mediaDevices: { getUserMedia: async () => { throw new Error("denied"); } } },
    }), "denied");
  });

  it("reports a missing microphone apart from a denial", async () => {
    for (const name of ["NotFoundError", "OverconstrainedError"]) {
      assert.equal(await requestVoicePermission({
        navigator: { mediaDevices: { getUserMedia: async () => { throw new DOMException("none", name); } } },
      }), "no-microphone");
    }
  });

  it("aborts recognition without letting a late result reach the draft", () => {
    let aborted = 0;
    const recognition = {
      onresult: () => assert.fail("late result"),
      onerror: () => assert.fail("late error"),
      onend: () => assert.fail("late end"),
      abort: () => { aborted += 1; },
    } as unknown as VoiceRecognition;
    abortVoiceRecognition(recognition);
    assert.equal(aborted, 1);
    assert.equal(recognition.onresult, null);
    assert.equal(recognition.onerror, null);
    assert.equal(recognition.onend, null);
    abortVoiceRecognition(null);
  });

  it("says where dictation audio goes on Windows", () => {
    assert.match(VOICE_SERVICE_NOTE, /Windows.*Microsoft's online speech recognition/);
  });
});
