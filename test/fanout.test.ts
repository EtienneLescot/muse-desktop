/**
 * US-7 fan-out: parent-turn prompt shaping (no spawn endpoint exists).
 *
 * Runs on the built-in node:test runner, no extra framework:
 *   npm test
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildFanoutPrompt,
  FANOUT_DEFAULT_LANES,
  FANOUT_LANES_MAX,
  FANOUT_LANES_MIN,
  FANOUT_MAX_AGENTS,
  fanoutLanes,
  fanoutQueueNote,
  parseFanoutCommand,
} from "../src/lib/fanout.ts";

describe("parseFanoutCommand", () => {
  it("parses /fanout <n> \"<task>\" with double quotes stripped", () => {
    assert.deepEqual(parseFanoutCommand('/fanout 3 "explore the auth flow"'), {
      count: 3,
      task: "explore the auth flow",
    });
  });

  it("parses unquoted and single-quoted tasks", () => {
    assert.deepEqual(parseFanoutCommand("/fanout 2 fix login"), {
      count: 2,
      task: "fix login",
    });
    assert.deepEqual(parseFanoutCommand("/fanout 1 'audit deps'"), {
      count: 1,
      task: "audit deps",
    });
  });

  it("rejects wrong command, bad counts, empty tasks", () => {
    assert.equal(parseFanoutCommand("/compact"), null);
    assert.equal(parseFanoutCommand("/fanout"), null);
    assert.equal(parseFanoutCommand("/fanout many do things"), null);
    assert.equal(parseFanoutCommand("/fanout 0 do things"), null);
    assert.equal(parseFanoutCommand(`/fanout ${FANOUT_MAX_AGENTS + 1} do things`), null);
    assert.equal(parseFanoutCommand('/fanout 2 ""'), null);
    assert.equal(parseFanoutCommand("please /fanout 2 do things"), null);
  });
});

describe("fanoutLanes", () => {
  it("computes cores-2 clamped to 4-8", () => {
    assert.equal(fanoutLanes(8), 6);
    assert.equal(fanoutLanes(4), 4);
    assert.equal(fanoutLanes(2), FANOUT_LANES_MIN);
    assert.equal(fanoutLanes(64), FANOUT_LANES_MAX);
  });

  it("falls back to 6 lanes on unknown input", () => {
    assert.equal(fanoutLanes(), FANOUT_DEFAULT_LANES);
    assert.equal(fanoutLanes(NaN), FANOUT_DEFAULT_LANES);
  });
});

describe("buildFanoutPrompt", () => {
  it("instructs N parallel subagents on the task in one parent prompt", () => {
    const prompt = buildFanoutPrompt({ count: 2, task: "probe the cache" });
    assert.match(prompt, /2 parallel subagents/);
    assert.match(prompt, /agent-1: probe the cache/);
    assert.match(prompt, /agent-2: probe the cache/);
    assert.match(prompt, /merge/i);
  });
});

describe("fanoutQueueNote", () => {
  it("returns null when the count fits the lanes", () => {
    assert.equal(fanoutQueueNote(6), null);
    assert.equal(fanoutQueueNote(2), null);
  });

  it("warns FIFO when n exceeds the lanes", () => {
    const note = fanoutQueueNote(7);
    assert.match(note ?? "", /FIFO/);
    assert.match(note ?? "", /7 agents on 6 parallel lanes/);
  });
});
