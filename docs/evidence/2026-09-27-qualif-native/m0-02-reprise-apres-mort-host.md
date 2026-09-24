# M0-02 — Host death → reconnection → resume with history (27 September 2026)

**M0-02's three criteria are proved on Windows**, against a **durable host** (`muse
serve` without `--no-session-log`). That closes "conversation resume" on the Windows side — the
"M0-02 is a client-side gap" verdict from `msp-resume-free-session.mjs` (21/09) was dated: the
client path `resume_session` + `read_session_history` **works** at HEAD `362c8bb`.

## Protocol (run today, packaged webview in dev)

1. Conversation open with history, host alive (`muse.exe serve --sandbox-network
   restricted --trust-workspace`, a **durable** host).
2. **`taskkill /F` on the host** while it is running.
3. Observation of the interface, then a click on **"Reconnect"** (`title="Reconnect this saved
   conversation to its workspace engine"`).
4. Sending a message in the resumed conversation.

## Results

### 1. Honest terminal status when the process death is known ✓

Immediately after the host died, the conversation shows:

> **Muse stopped because the host process ended. Reconnect to continue.**

No frozen spinner, no promise: the state is terminal and the action is named.

### 2. A real resume: `resume_session` + full hydration ✓

Clicking Reconnect → IPC trace (the dead host is **relaunched** automatically):

| Call | Key result |
|---|---|
| `resume_session` | `session_durability: "durable"`, **`loaded: true`**, `granted_capabilities: ["userShell"]`, `model_id: "muse-spark-1.3-contributor"` |
| `set_approval_mode` | posture reapplied (`effectiveMode: allowAll`) |
| `read_session_history` | **full history** read back (userMessage + assistant items, `turnId` per entry) |
| `list_pending_requests` | `{approvals: [], userInputs: []}` |
| `read_queue_snapshot`, `list_models`, `list_skills` | catalogue and skills rehydrated (`is_active: true` on the effective model) |

### 3. Messages preserved ✓ + execution resumed ✓

The transcript from before the death is preserved, the history is read back from the relaunched host, and
**the conversation accepts and executes a new turn**: "Reply with exactly the word:
RESUMED" → answer **RESUMED** received, sub-agents `Running`.

## What that changes for the roadmap

- **M0-02 Windows: all 3 criteria are proved** — "a turn's resume actually replayed against
  a durable host", "messages preserved" (finally observed on a native run),
  "honest terminal status".
- The "M0-02 — resume blocked by the sidecar" entry in the 21/09 reports is
  **out of date**: it measured a `--no-session-log` host (memory only), where resume is
  structurally impossible — see [`session-log-expique-tout.md`](session-log-expique-tout.md).
- macOS/Linux: no resume scenario run (column unchanged).

## Reproducibility

- Commit `362c8bb`, Windows 11 26200, WebView2, sidecar `muse-bin-1.3.0-R3401.1`.
- Commands: `taskkill /PID <host> /F` then CDP driving (`scripts/cdp-drive.mjs`):
  click Reconnect → `resume_session` trace → send "Reply with exactly the word: RESUMED".
