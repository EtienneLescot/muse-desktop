/**
 * MSP conformance surface: the methods our Rust sidecar client sends and the
 * notifications it routes, checked at compile time against the official
 * Meta SDK wire types.
 *
 * Source of truth: `@muse-code/sdk` (pinned 0.1.1, Developer Preview, MIT)
 * `dist/src/msp.d.ts` — generated from `schema/msp/stable/msp.schema.json`.
 * Only `import type` is used here, so this module adds zero runtime
 * dependencies and zero bytes for the SDK to the bundle: a typo or a
 * removed/renamed method fails `tsc` instead of failing at runtime against
 * the host. Bump the pinned SDK version deliberately; re-run `tsc` and the
 * conformance test to re-validate.
 *
 * Follow-up (not done here): pin `EXPECTED_SCHEMA_FINGERPRINT` against the
 * bundled `muse` binary via the SDK's `checkServedFingerprint`.
 */
import type {
  MspMethod,
  MspNotification,
} from "@muse-code/sdk/dist/src/msp.js";

/** Every MSP method `src-tauri/src/main.rs` sends through `MspClient`. */
export const MSP_METHODS_SENT: MspMethod[] = [
  "initialize",
  "session/start",
  "session/list",
  "turn/start",
  "turn/interrupt",
  "approval/decide",
  "userInput/answer",
  "userInput/cancel",
];

/**
 * Every host notification `route_notification` handles (unknown ones are
 * ignored by additive schema design — see main.rs).
 */
export const MSP_NOTIFICATIONS_HANDLED: MspNotification[] = [
  "initialized",
  "item/started",
  "item/delta",
  "item/completed",
  "item/updated",
  "approval/requested",
  "approval/updated",
  "approval/resolved",
  "turn/started",
  "turn/completed",
  "turn/retracted",
  "turn/retryScheduled",
  "turn/unqueued",
  "userInput/requested",
  "userInput/settled",
];

/** Host error codes our UI interprets (kinds per the SDK error registry). */
export const MSP_ERROR_APPROVAL_REQUIREMENT_STALE = -32053;
export const MSP_ERROR_USER_INPUT_ANSWER_INVALID = -32057;
