# Muse authentication in the editor — why, and how (21 September 2026)

The question asked: "the application handles PowerShell and Bash, so why not use the CLI to authenticate?" **That is the right answer to the problem**, and this document explains why, with the measurements that establish it.

## The problem, stated correctly

The desktop app **cannot** authenticate on its own:

| Finding | Proof |
|---|---|
| MSP is a local `stdio` protocol, in the user's session | `muse serve --help`: "The client owns this process's stdin and stdout and is its only connection" |
| The MSP schema has **no** notion of authentication | Exhaustive search in `@muse-code/sdk`: the only occurrences of "token" are the SS5 approval token and LLM consumption (`windowTokens`, `outputTokens`) |
| No public Meta/Muse OAuth endpoint is exposed | Nothing in the schema, nothing in the CLI's help |
| The CLI is **already** authenticated | `~/.config/muse/auth.json` |

So a native OAuth inside the editor would require an API that does not exist. But **the CLI already has the flow**:

```
muse login     Log in with your Meta account: approve a code in your browser.
               META_API_KEY always takes priority over the account login.
muse auth      Store provider API credentials
```

## The CLI can be driven — measured

| Check | Result |
|---|---|
| Does `muse login` work without a TTY? | **Yes** — writes to stdout, identical across three runs |
| Is the output usable? | **Yes**: URL and code on separate lines |
| Can the PTY run a command? | **Yes** — `writeTerminal(id, cmd + "\r")`, the "Send" button's path |
| Does the PTY see the CLI's `PATH`? | **Yes** — `CommandBuilder` with no `env_clear`, hence full inheritance |

Real output captured:

```
Open this page to sign in:
  https://auth.meta.com/oauth/device/?code=RVWJ-BCKT
confirm this code matches:
  RVWJ-BCKT

Waiting for approval…
```

The process was killed while waiting: **`auth.json` carries `mtime = 2026-09-19T18:47:36Z`**, predating this session. The check modified nothing.

## Why this is better than storing the credentials

The token **never passes through the editor**. The user approves in their browser, and the CLI writes to its own storage itself. The application only launches a command and reads a classification.

That is structurally safer than any alternative in which the editor would become the custodian of a secret.

## The trap the feature exists to expose

`muse login --help` documents that **`META_API_KEY` always wins** over the account login. An editor that signs in to use its subscription can therefore **keep consuming API credits with no signal at all**.

That is the case the interface distinguishes explicitly:

| Situation | Message |
|---|---|
| `META_API_KEY` **and** a stored credential | **Warning**: the signed-in account is ignored, remove the variable |
| `META_API_KEY` alone | Neutral: the key wins over a login |
| A stored credential alone | Neutral: signing in replaces it with an account, which uses the subscription |
| Nothing | Warning: calling Muse will fail |

## What is shipped

| Element | Role |
|---|---|
| `muse_auth_status` (Rust) | Returns the effective mode, the source, whether the key wins, and whether the CLI is reachable |
| `src/lib/museAuth.ts` | A **pure** decision: labels, tone, whether to offer sign-in |
| "Muse authentication" section | Shows the mode, with the precedence warning |
| "Sign in with Meta" action | Opens the terminal and runs `muse login` |

**The IPC payload cannot carry a secret**, and that is verified at three levels:

1. a Rust test pins the **exact list of fields** and the **value domains**;
2. that guard rail is **verified by mutation** — a payload carrying the value fails with "the auth status payload changed shape";
3. `ux-auth-status.mjs` checks on the real bridge that the longest value is **10 characters** where a key is 48.

**Injection impossible**: `signInCommand()` returns `null` for any command other than the exact reviewed form. `rm -rf /` and `muse login; curl evil` are tested.

## Two errors of method, both caught

**The first guard rail was wrong.** It looked for forbidden words in the serialised text and failed on `"mode":"api_key"` — a **legitimate** enumeration value. I nearly relaxed it. The right reading was that the invariant is **structural, not lexical**: an exact whitelist of fields and constrained value domains. A substring check cannot distinguish "naming a mode" from "carrying a secret".

**And the credentials file's path had to leave the payload** because it made that same guard rail fail. The renderer does not need it to act, and the guard rail stays absolute instead of accumulating exceptions.

## Still open

- **Confirm the CLI opens the browser.** Its message says "Open this page", which suggests it does not. If so, the URL will need displaying so the user can copy it.
- **Detect when the sign-in completes.** Today "Check again" is manual; polling during the wait would be more comfortable.
- **`muse auth set`** is not exposed, deliberately: it reads a secret on stdin, which the application must not handle.
