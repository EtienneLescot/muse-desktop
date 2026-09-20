/**
 * Contract tests for the pure helpers inside `scripts/msp-probe.mjs`.
 *
 * The probe is an executable, not a module: it exports nothing and runs
 * `await main()` when it is loaded, so a test cannot import it — with the
 * Windows sidecar present in `src-tauri/binaries/` the import would spawn a real
 * `muse serve` host, and without it the probe sets `process.exitCode = 1` and
 * would fail the whole run even though every test passed. The helpers are
 * loaded from the script text by `test/scriptSource.ts`, which evaluates the
 * named declaration only: no child process, no socket, no filesystem scratch.
 *
 * Recommended follow-up (deliberately not applied here, the script is under
 * review): add `export` to these declarations and drop the source harness.
 *
 * Runs on the built-in node:test runner, no extra framework:
 *   npm test
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadDeclarations } from "./scriptSource.ts";

type Uuidv7 = () => string;
type Bounded = (value: unknown, max?: number) => string | undefined;
type Reason = (error: unknown) => string | undefined;
type ArgvHelpers = {
  has: (name: string) => boolean;
  value: (name: string) => string | undefined;
};

const { uuidv7 } = loadDeclarations<{ uuidv7: Uuidv7 }>("msp-probe.mjs", ["uuidv7"]);
const { bounded, reason } = loadDeclarations<{ bounded: Bounded; reason: Reason }>(
  "msp-probe.mjs",
  ["bounded", "reason"],
);

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** The 48-bit timestamp in the leading field of a canonical identifier. */
const timestampOf = (id: string) => Number.parseInt(id.replaceAll("-", "").slice(0, 12), 16);

/**
 * Wait for the wall clock to leave the millisecond it is currently in, plus a
 * margin, so two identifiers are guaranteed to be stamped differently even on a
 * platform whose clock only ticks every ~16 ms.
 */
async function waitForClockTick(): Promise<void> {
  const started = Date.now();
  let current = started;
  for (let attempt = 0; attempt < 200 && current === started; attempt += 1) {
    await sleep(2);
    current = Date.now();
  }
  assert.ok(current > started, "the system clock did not advance within 400ms");
  await sleep(10);
}

describe("msp-probe command identifiers", () => {
  it("emits canonical lower-case UUIDs with version 7 and an RFC 4122 variant", () => {
    // A single sample would pass by luck if the version or variant masking were
    // dropped (1 in 16 and 4 in 16), so the invariant is checked on many draws.
    const seen = new Set<string>();
    for (let index = 0; index < 64; index += 1) {
      const id = uuidv7();
      assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      assert.equal(id.length, 36);
      assert.equal(id[14], "7", `version nibble of ${id}`);
      assert.match(id[19], /[89ab]/, `variant nibble of ${id}`);
      seen.add(id);
    }
    assert.equal(seen.size, 64, "identifiers must not repeat");
  });

  it("stamps the current millisecond clock big-endian in the leading 48 bits", () => {
    for (let index = 0; index < 8; index += 1) {
      const before = Date.now();
      const id = uuidv7();
      const after = Date.now();
      const stamp = timestampOf(id);
      // Anything but a 48-bit big-endian millisecond clock fails here: a
      // timestamp shifted right (the pre-fix form), a second-based clock or a
      // little-endian write all land outside [before, after].
      assert.ok(stamp > 0, `timestamp of ${id} must not be zero`);
      assert.ok(
        stamp >= before && stamp <= after,
        `timestamp ${stamp} of ${id} is outside [${before}, ${after}]`,
      );
    }
  });

  it("stays time-sortable across calls separated in time", async () => {
    const first = uuidv7();
    await waitForClockTick();
    const second = uuidv7();
    const firstStamp = timestampOf(first);
    const secondStamp = timestampOf(second);
    assert.ok(secondStamp > firstStamp, `${secondStamp} must sort after ${firstStamp}`);
    assert.ok(second > first, "lexical order must follow the timestamp");
  });
});

describe("msp-probe bounded report values", () => {
  it("refuses everything that is not a string", () => {
    for (const value of [undefined, null, 42, true, {}, [], new Error("boom")]) {
      assert.equal(bounded(value), undefined, `${String(value)} must not be reported`);
    }
  });

  it("collapses whitespace runs and trims the value", () => {
    assert.equal(bounded("  first\n\tsecond   third  "), "first second third");
  });

  it("measures the limit after cleaning, so padding never truncates", () => {
    assert.equal(bounded("   ab   ", 2), "ab");
  });

  it("keeps a value that exactly fills the limit and truncates past it", () => {
    assert.equal(bounded("a".repeat(160)), "a".repeat(160));
    assert.equal(bounded("a".repeat(161)), `${"a".repeat(160)}…`);
  });

  it("appends a single-character ellipsis past an explicit limit", () => {
    const clipped = bounded("x".repeat(200), 10);
    assert.equal(clipped, "xxxxxxxxxx…");
    assert.equal(clipped?.length, 11);
  });

  it("keeps whitespace-only input as an empty string instead of dropping it", () => {
    assert.equal(bounded("   \n\t "), "");
  });
});

describe("msp-probe failure reasons", () => {
  it("prefers the message of a real Error", () => {
    assert.equal(reason(new Error("host is closed")), "host is closed");
  });

  it("stringifies anything that is not an Error", () => {
    assert.equal(reason("plain failure"), "plain failure");
    assert.equal(reason(42), "42");
  });

  it("bounds a long message to 200 characters through bounded", () => {
    const long = reason(new Error("z".repeat(500)));
    assert.equal(long, `${"z".repeat(200)}…`);
    assert.equal(long?.length, 201);
  });

  it("flattens a multi-line message so the report stays one line per field", () => {
    assert.equal(reason(new Error("line one\n\tline two")), "line one line two");
  });
});

describe("msp-probe argument helpers", () => {
  const withArgv = (argv: string[]) =>
    loadDeclarations<ArgvHelpers>("msp-probe.mjs", ["has", "value"], { argv });

  it("matches flags exactly", () => {
    const { has } = withArgv(["--live", "--no-live"]);
    assert.equal(has("--live"), true);
    assert.equal(has("--no-live"), true);
    assert.equal(has("--livex"), false);
    assert.equal(has("live"), false);
  });

  it("reads the token that follows a flag", () => {
    const { value } = withArgv(["--binary", "C:\\muse.exe", "--live"]);
    assert.equal(value("--binary"), "C:\\muse.exe");
    assert.equal(value("--missing"), undefined);
  });

  it("never mistakes the next flag for a value", () => {
    const { value } = withArgv(["--binary", "--live"]);
    assert.equal(value("--binary"), undefined);
  });

  it("returns undefined for a trailing flag with no value", () => {
    const { value } = withArgv(["--live", "--binary"]);
    assert.equal(value("--binary"), undefined);
  });
});
