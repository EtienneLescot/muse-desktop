# M1-06 — the capability map is only populated at mount (21 September 2026)

Two facts established in the same session, and they go together.

## 1. The "host-side blocker" is disproved

See [`m1-06-blocage-refute.md`](m1-06-blocage-refute.md): with the capability shape the application uses (`capabilities.requestedCapabilities`, nested), sidecar 1.3.0 **publishes** `item/started` and `item/completed` of kind `userShell`, with the command's output. The probe that claimed otherwise sent the capability **flat**, got nothing, and concluded a contract gap.

## 2. The real defect is on the client side, and it is a synchronisation one

**Measurement.** On a fresh launch, at the moment the Terminal tab is shown:

| Source | Answer for the active session `01a0bb03` |
|---|---|
| Rust bridge (`restore_sessions`) | `granted_capabilities: ["userShell"]` |
| Renderer map (`grantedCapabilitiesBySession`, hook #82) | **absent** — the map holds only `01a0c2d7` |
| React prop `canRunThroughMuse` read off the fiber | **`false`** |
| The button's tooltip | "This Muse host did not grant the userShell capability" |

**Cause.** `restore_sessions` is called **at mount**, and the effect populating `grantedCapabilitiesBySession` only runs at that moment. But hosts are launched **per workspace**: on the first pass, not all sessions are admitted yet, so the map receives only some of them. **Nothing repopulates it afterwards** — only `start_session`, `resume_session` and `fork_session` fill an entry, for the session they create.

**Visible consequence:** after a launch, "Run in Muse" announces the host did not grant the capability **although the host did grant it**. The reason displayed is false, and the action stays unavailable until some other path fills the map.

**This is not the same as the previous point**: the capability exists and works; it is the renderer's copy of it that is incomplete.

## 3. An intermediate state, measured

On an older instance, the same map held **11 sessions** with `["userShell"]`. The difference is when it was populated, not what was negotiated. That explains why this defect was earlier mistaken for a capability problem: depending on when you measured, the button was enabled or not.

## 4. What was fixed

**`sessionNotLoaded` is not an opaque failure.** `Run in Muse` was enabled on a conversation the host had not loaded, and the failure arrived **only after the click**. The host reports `status: "notLoaded"` for **every** persisted session after a relaunch — including those at 27 turns — so "the host lists it" and "the host holds it in memory" are two distinct states.

`SessionMeta` now carries `loaded`, derived from that status, and the button is unavailable with an explicit reason while the conversation is not loaded. The message no longer claims the capability is missing.

**Measurement of the full chain:** `restore_sessions` returns `"loaded": false` for all 13 sessions, alongside `model_id` and `granted_capabilities`, which therefore travel through the same projection.

**And the path works once the session is loaded:** `session/resume` then `session/userShell` give `accepted`, **2 `userShell` items**, and the command's marker **returned** — measured twice, before and after the resume, in `scripts/msp-user-shell-after-resume.mjs`.

## 5. What has been fixed since: the `loaded` flag never came back

Point 2 above ("load the session on demand") assumed the persistent refusal came from the absence of a resume. **Measurement of 21 September: the resume was already happening, and the flag did not follow.**

There is indeed an automatic resume at startup: `selectBootResumeCandidates` resumes the sessions `restore_sessions` did not admit, the active one first, silently. Every reachable conversation is therefore **loaded** by the host a few seconds after launch.

But both halves of the information were missing:

- **on the Rust side**, `resume_session` built `SessionMeta` from the `session/read` taken **before** the resume, then updated only `running` and `approval_mode` in the success branch. `loaded` therefore stayed `false` for a conversation the call had just loaded;
- **on the renderer side**, `reconnectSession` copied `granted_capabilities` but ignored `meta.loaded`. The `sessionLoadedBySession` map was populated **only at mount**, by a `restore_sessions` that answers `loaded: false` for every persisted session.

Result: the host loaded the conversation, and the interface kept showing "Send a message in this conversation first: the host only runs shell commands for a conversation it has loaded". **The remedy offered could not work**: sending a message did not change the value frozen at mount.

**Fix.** `apply_resumed_session` (a pure, tested function) folds the resume's payload back into the metadata — `loaded`, `model_id`, `approval_mode`, `running` — and the renderer copies `meta.loaded` and `meta.model_id` after a successful resume.

**Verified in the application** (`scripts/ux-terminal-precondition.mjs`): six conversations walked, a command typed in each, **none** refused for loading reasons; the one with a transcript shows `disabled=false` and the tooltip "Run this command through the Muse host (userShell)". The five conversations with no message are counted as **skipped** — they render no work panel, there is nothing to decide — not as successes.

**A fix discarded, and why.** I had added a "Load conversation" button in the terminal, shown when `loaded` is false, which called `session/resume`. The probe discarded it: on a healthy host, **that state is unreachable** — startup resume loads every candidate conversation, and the six measured answered `loaded`. The button would only have been visible if a resume had failed, that is, in the only case where the click also fails, and the interface already offers **Reconnect** for that. Shipping an action no real window can reach is not a feature: it was removed, the metadata fix kept.

## 6. Still open

1. **Repopulate the capability map** after the hosts launch, rather than only at mount. The automatic resume fills it for the sessions it resumes (`resume_session` writes an entry), which explains why it is rarely seen now — but nothing guarantees a session that is not resumed gets one.

2. **Interactive native qualification on all three OSes**, required by the ticket.

## The lesson, once again

Three measurements of the same contract contradicted each other in this campaign — the bridge, the React prop, the DOM — and each time I first believed the most convenient one. What settled it was, each time, **an additional source**, not reasoning: the persisted log for the duplicate message, the React fiber here, the capability shape sent for the false blocker.

And a note on composite states: `disabled` on this button combines **four** conditions (capability, session loaded, command non-empty, execution in progress). I drew two false conclusions from its value alone. **The tooltip is the discriminator** — it names the cause — and it is the one to read.
