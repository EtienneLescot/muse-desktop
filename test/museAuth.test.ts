import assert from "node:assert/strict";
import test from "node:test";
import {
  canOfferSignIn,
  describeAuth,
  signInCommand,
  type AuthStatusPayload,
} from "../src/lib/museAuth.ts";

function status(over: Partial<AuthStatusPayload> = {}): AuthStatusPayload {
  return {
    mode: "none",
    source: "absent",
    apiKeyOverridesLogin: false,
    loginCommand: "muse login",
    ...over,
  };
}

test("no credential is a warning that offers sign-in", () => {
  const notice = describeAuth(status());
  assert.equal(notice.tone, "warning");
  assert.match(notice.headline, /No Muse credential/);
  assert.equal(notice.offerSignIn, true);
});

test("an account login is reported as using the plan", () => {
  const notice = describeAuth(status({ mode: "account", source: "stored" }));
  assert.equal(notice.tone, "neutral");
  assert.match(notice.headline, /Meta account/);
  assert.match(notice.detail ?? "", /plan/);
  assert.equal(notice.offerSignIn, false);
});

/**
 * The case the whole feature exists for: the CLI documents that META_API_KEY
 * always wins over an account login, so a signed-in user whose environment still
 * sets the key is silently billed to the API while believing otherwise.
 */
test("an environment key that shadows a stored login is called out explicitly", () => {
  const notice = describeAuth(status({ mode: "api_key", source: "environment", apiKeyOverridesLogin: true }));
  assert.equal(notice.tone, "warning");
  assert.match(notice.detail ?? "", /takes priority/);
  assert.match(notice.detail ?? "", /ignored/);
  assert.match(notice.detail ?? "", /Unset META_API_KEY/);
  // No point offering a sign-in that the environment would keep overriding.
  assert.equal(notice.offerSignIn, false);
});

test("an environment key with nothing behind it is stated without alarm", () => {
  const notice = describeAuth(status({ mode: "api_key", source: "environment" }));
  assert.equal(notice.tone, "neutral");
  assert.match(notice.detail ?? "", /takes priority/);
  assert.equal(notice.offerSignIn, true);
});

test("a stored credential invites replacing it with an account login", () => {
  const notice = describeAuth(status({ mode: "api_key", source: "stored" }));
  assert.equal(notice.tone, "neutral");
  assert.match(notice.headline, /stored on this machine/);
  assert.match(notice.detail ?? "", /subscription/);
  assert.equal(notice.offerSignIn, true);
});

test("an unreadable status degrades instead of rendering undefined", () => {
  const notice = describeAuth(null);
  assert.equal(notice.tone, "neutral");
  assert.match(notice.headline, /unavailable/);
  assert.equal(notice.offerSignIn, false);
});

test("a newer host value does not crash and does not offer sign-in blindly", () => {
  const unknown = { mode: "something_new", source: "mystery", apiKeyOverridesLogin: false, loginCommand: "muse login" } as unknown as AuthStatusPayload;
  const notice = describeAuth(unknown);
  // Falls through to the stored-credential branch rather than throwing.
  assert.equal(typeof notice.headline, "string");
  assert.equal(notice.headline.length > 0, true);
});

test("sign-in is withheld when the CLI is not reachable", () => {
  assert.equal(canOfferSignIn(false, status()), false);
  assert.equal(canOfferSignIn(true, status()), true);
  // Even with the CLI present, a state that should not offer it still refuses.
  assert.equal(canOfferSignIn(true, status({ mode: "account", source: "stored" })), false);
});

test("the terminal receives the exact reviewed command, or nothing", () => {
  assert.equal(signInCommand(status()), "muse login\r");
  // A payload cannot smuggle a different command into the terminal.
  assert.equal(signInCommand({ ...status(), loginCommand: "rm -rf /" }), null);
  assert.equal(signInCommand({ ...status(), loginCommand: "muse login; curl evil" }), null);
  assert.equal(signInCommand(null), null);
});
