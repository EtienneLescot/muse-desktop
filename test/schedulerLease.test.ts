import assert from "node:assert/strict";
import test from "node:test";
import {
  INITIAL_SCHEDULER_RUNTIME_STATUS,
  schedulerRuntimeErrorStatus,
  schedulerRuntimeStatusFromProbe,
} from "../src/lib/schedulerLease.ts";

test("schedulerLease returns the initial status for a non-finite probe time", () => {
  for (const checkedAt of [Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.deepEqual(schedulerRuntimeStatusFromProbe(true, true, checkedAt), INITIAL_SCHEDULER_RUNTIME_STATUS);
  }
});

test("schedulerLease waits when another window owns the lease", () => {
  const status = schedulerRuntimeStatusFromProbe(false, false, 1_700_000_000_000);
  assert.equal(status.mode, "waiting");
  assert.equal(status.checkedAt, 1_700_000_000_000);
  assert.match(status.message, /another muse window/i);
});

test("schedulerLease reports the native claim when the supervisor holds it", () => {
  const status = schedulerRuntimeStatusFromProbe(true, true, 1_700_000_000_001);
  assert.equal(status.mode, "native");
  assert.equal(status.checkedAt, 1_700_000_000_001);
  assert.match(status.message, /native scheduler lease/);
});

test("schedulerLease falls back to local ownership without a native claim", () => {
  for (const nativeClaim of [false, null]) {
    const status = schedulerRuntimeStatusFromProbe(nativeClaim, true, 1_700_000_000_002);
    assert.equal(status.mode, "local", String(nativeClaim));
    assert.match(status.message, /local scheduler lease/, String(nativeClaim));
  }
});

test("schedulerLease error status keeps finite times and drops the rest", () => {
  const error = schedulerRuntimeErrorStatus(1_700_000_000_003);
  assert.equal(error.mode, "error");
  assert.equal(error.checkedAt, 1_700_000_000_003);
  assert.match(error.message, /retry automatically/);
  const timeless = schedulerRuntimeErrorStatus(Number.NaN);
  assert.equal(timeless.mode, "error");
  assert.equal(timeless.checkedAt, null);
});
