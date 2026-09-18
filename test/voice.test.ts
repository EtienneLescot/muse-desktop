import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  appendVoiceTranscript,
  getVoiceRecognitionFactory,
  requestVoicePermission,
  transcriptFromVoiceEvent,
  voiceErrorMessage,
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
});
