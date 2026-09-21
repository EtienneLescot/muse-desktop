/**
 * Which Muse credential is in effect, and what to tell the user about it.
 *
 * The desktop cannot authenticate on its own. MSP is a stdio protocol inside the
 * user's session and its schema carries no authentication concept at all, so
 * there is no public Meta/Muse OAuth endpoint an editor could integrate. The
 * Muse CLI owns that flow — `muse login` runs a device-code approval in the
 * browser — and stores the result itself. The desktop's honest job is to report
 * which credential wins and to let the user drive the CLI in the built-in
 * terminal.
 *
 * The precedence rule is why this module exists. `muse login --help` states that
 * `META_API_KEY` always takes priority over the account login. An editor who
 * signs in expecting to spend a subscription can therefore keep spending API
 * credits with no visible signal at all.
 *
 * No secret ever passes through here: the native command reports only whether a
 * credential exists, never its value.
 */

/** Which credential Muse will use. Mirrors the Rust `AuthMode`. */
export type AuthMode = "api_key" | "account" | "none";

/** Where the effective credential came from. Mirrors the Rust `AuthSource`. */
export type AuthSource = "environment" | "stored" | "absent";

/** The native command's payload. Bounded by a Rust test to these five fields. */
export interface AuthStatusPayload {
  mode: AuthMode;
  source: AuthSource;
  apiKeyOverridesLogin: boolean;
  loginCommand: string;
  /** Whether the CLI resolves on the PATH the built-in terminal inherits. */
  cliAvailable: boolean;
}

export type AuthNoticeTone = "neutral" | "warning";

export interface AuthNotice {
  tone: AuthNoticeTone;
  /** One line naming the effective credential. */
  headline: string;
  /** What the user should know or do, when there is something to say. */
  detail: string | null;
  /** Whether offering the sign-in action makes sense in this state. */
  offerSignIn: boolean;
}

/**
 * Turn a reported status into what the UI should say.
 *
 * Kept pure and total so every combination is testable without a runtime, and so
 * an unknown value from a newer host degrades to a neutral message instead of
 * rendering `undefined` at the user.
 */
export function describeAuth(status: AuthStatusPayload | null): AuthNotice {
  if (status === null) {
    return {
      tone: "neutral",
      headline: "Muse authentication status is unavailable.",
      detail: "The desktop could not read which credential Muse is using.",
      offerSignIn: false,
    };
  }

  if (status.mode === "none") {
    return {
      tone: "warning",
      headline: "No Muse credential found.",
      detail:
        "Muse calls will fail until you sign in, or store a provider API key with the Muse CLI.",
      offerSignIn: true,
    };
  }

  if (status.mode === "account") {
    return {
      tone: "neutral",
      headline: "Signed in with a Meta account.",
      detail: "Requests use the account's plan.",
      offerSignIn: false,
    };
  }

  // mode === "api_key"
  if (status.source === "environment") {
    return status.apiKeyOverridesLogin
      ? {
          tone: "warning",
          headline: "A META_API_KEY environment variable is in use.",
          // This is the case worth interrupting for: a stored sign-in exists and
          // is being ignored, so the user may believe they are on a plan.
          detail:
            "META_API_KEY takes priority over the account login, so a signed-in Meta account is being ignored. Requests are billed to the API key. Unset META_API_KEY to use the account instead.",
          offerSignIn: false,
        }
      : {
          tone: "neutral",
          headline: "A META_API_KEY environment variable is in use.",
          detail: "META_API_KEY takes priority over an account login.",
          offerSignIn: true,
        };
  }

  // A stored credential. The CLI records both key kinds under the same field, so
  // this is reported as a stored credential rather than guessed at.
  return {
    tone: "neutral",
    headline: "A Muse credential is stored on this machine.",
    detail:
      "Stored by the Muse CLI. Sign in to replace it with a Meta account, which is what uses a subscription rather than API credits.",
    offerSignIn: true,
  };
}

/**
 * Whether the built-in terminal can drive the CLI at all.
 *
 * `muse login` is only reachable when the CLI is on the PATH the terminal
 * inherits — the terminal spawns without clearing the environment, so this is
 * the same PATH the app sees. The native side reports it, so the action is
 * hidden rather than offered and failing.
 */
export function canOfferSignIn(status: AuthStatusPayload | null): boolean {
  if (status === null) return false;
  if (status.cliAvailable !== true) return false;
  return describeAuth(status).offerSignIn;
}

/**
 * The exact bytes to send to the terminal.
 *
 * Returns null when there is nothing safe to run, so a caller cannot accidentally
 * write a partial command. The trailing carriage return is what the terminal's
 * own send path uses.
 */
export function signInCommand(status: AuthStatusPayload | null): string | null {
  const command = status?.loginCommand;
  // Only the command the native side reported, and only if it matches the one
  // reviewed shape, so a compromised or future payload cannot inject a shell line.
  if (command !== "muse login") return null;
  return `${command}\r`;
}
