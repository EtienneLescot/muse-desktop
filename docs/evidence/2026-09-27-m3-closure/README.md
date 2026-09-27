# M3 closure campaign — automations, MCP, skills (26–27 September 2026)

**Platform:** Windows 11 (build 26200) · dev build (WebView2, CDP 9222, real
Muse sidecar 1.3.0). Live model turns wherever a turn was needed.

**Objective:** close the Windows-reachable M3 criteria. Three tickets move to
☑ (M3-01, M3-04, M3-09); two major fix replays land (M3-06/07); two real
product defects surface (one fixed today, one recorded).

## Results

| Ticket | Scenario | Result |
|---|---|---|
| **M3-01** | local stdio MCP transport (`m3-01-local-mcp.json`) | **Windows closed (transport)** — a real minimal MCP server (Content-Length LSP-style framing) probed through the app's Rust client via `mcp_local_probe`: `initialize` → `notifications/initialized` → `tools/list` complete, `serverName: qualif-mcp`, `serverVersion: 1.0.0`, `qualif_echo` listed with its input schema. The remaining pieces (tool catalogue inside the Muse host, native permission authority) are host-side, not client-reachable. |
| **M3-04** | skills on disk (`m3-01-04-05-skills-mcp.json`) | **Windows closed** — a `SKILL.md` fixture (frontmatter name/description + relative resource) planted in the workspace `.muse/skills/` root is discovered by **Scan workspace** (`1 discovered`) through the real Settings surface. |
| **M3-09** | useful notification (`m3-06-07-09-automations.json`) | **Windows closed** — the completion notification appears in the inbox with the run's result and an unread counter; **the native permission prompt was requested through the app's own control and answered `granted`** (tauri-plugin-notification). The app-stays-open constraint stays documented. |
| **M3-06** | scheduled run, wake task, thread reuse (`m3-06-07-09-automations.json`) | **Major progress, one piece stays open** — see defects below: **the wake task registration was broken on non-English Windows and is FIXED**; the registered task carries `--automation-wakeup` and **executes** (schtasks `Prêt` → `En cours`); a **no-click run completed and created its own conversation** (WAKE2, session 01a0e287). The free-thread **reuse** dispatch now reaches `send_input` (the 22/09 workspace normalization holds — the old workspace-mismatch refusal no longer fires) but the final send failed on host-load state in a heavily relaunched environment; a clean-environment replay of that delivery is the remaining Windows piece. |
| **M3-07** | DST, lease, kill replay (`m3-06-07-09-automations.json`) | **Major progress** — the creation form **shows the DST adjustments** (gap: "02:30 does not exist… scheduled at 03:30 instead"; duplicate: "happens twice that day… the first occurrence") — the 25/09 fix replay; the **native lease is held** ("Native scheduler active"); the **kill replay marks the dead run for review** with explicit reconciliation actions (`Mark failed` / `Restore` present after relaunch) — the 25/09 fix confirmed. Sleep/locked-machine scenarios remain. |
| M3-02 | remote MCP | ◐ — code complete (streamable HTTP/SSE, keyring); needs a public HTTPS endpoint for a live proof (private addresses are refused by design). |
| M3-03 | extension install | ◐ — the install/disable surface awaits its packaged-server qualification (`.mcpb`/ZIP flow). |
| M3-05 | skill invocation | ◐ — the composer accepted `/qualif-skill` and the send path was exercised, but the live host invocation hit the degraded post-relaunch host state ("conversation engine is unavailable"); a clean-environment replay is needed. Skills discovery (M3-04) is proved. |
| M3-08 | run review | ◐ — run cards with filters/actions proved 27/09; the semantic business summary stays host-dependent. |

## Campaign continuation (27/09 evening) — the remaining reachable tickets

| Ticket | Scenario | Result |
|---|---|---|
| **M3-02** | remote MCP to a real public endpoint (`m3-02-remote-mcp.json`) | **Windows closed** — the connector form connected to mcp.deepwiki.com over streamable HTTP: `Connected to DeepWiki 2.14.3 · 3 tool(s) · 1056 ms`, the connector persisted in the registry. |
| **M3-03** | .mcpb install + rollback (`m3-03-mcpb-install.json`) | **Windows closed** — a real `.mcpb` (manifest.json + framed stdio server.js) installed through the panel file picker: manifest parsed, revision installed, server probed, then removed via `mcp_package_remove` (rollback). |
| **M3-05** | skill invocation, clean replay (`m3-05-skill-invoke.json`) | **Windows closed** — `/create-plugin` (a skill the host catalogue carries) sent through the composer was executed by the live host: the model ran the skill's flow and asked for the plugin parameters. The workspace `SKILL.md` route stays client-discovered; host 1.3.0 answers "unknown skill" for host-unknown names (recorded). |
| **M3-06** | thread reuse delivery (`m3-06-thread-reuse.json`) | **Windows closed** — a reuse schedule targeting a loaded conversation delivered REUSE3 into that conversation's log via Run now (completed status). The schedule captures workspace/project from the ACTIVE conversation: created with the target active, the delivery succeeds. |
| **M3-07** | host crash mid-run (`m3-07-host-crash.json`) | **Windows closed** — a reuse run in "running" state had `muse.exe` killed: the run settled to **failed** with the explicit error ("host exited before the scheduled turn completed") instead of staying stuck. Remaining: sleep/locked-machine and the per-OS native triggers. |

With these, every M3 criterion reachable from this machine is proved. The
remaining ◐ pieces are host/protocol/OS-blocked and precisely stated in the
roadmap.

## Real product defects surfaced (and their resolution)

1. **FIXED — the wake task could never register on non-English Windows.**
   `scheduler_wakeup.rs` wrote the Task Scheduler XML as UTF-8 **without a
   BOM** while declaring `encoding="UTF-8"`; on an ANSI-locale Windows
   (French, build 26200) schtasks rejected the file — *"Le code XML de la
   tâche est mal formé… impossible de changer d'encodage"* — so
   `Muse-Desktop\AutomationWake` could never be created (the 27/09 "task not
   found" status was this bug, not a missing feature). **Fix:** write the XML
   as UTF-16LE with a BOM (what Windows tooling produces). Verified: `installed:
   true`, the task listed and executing.
2. **RECORDED — the wake-task relaunch clobbers state.** The wake task
   relaunches the executable while the user's instance may still run; there is
   **no single-instance guard**, and two instances share one WebView2 profile —
   observed ledger clobbering (a dispatched run vanished from
   `schedule-runs.v1` when the second instance's boot state overwrote it).
   Resolution needs a product decision (single-instance plugin, or wake
   hand-off); recorded here and in the campaign notes.

## Reproducibility

```
npm run build && cargo build --manifest-path src-tauri/Cargo.toml
WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222 ./src-tauri/target/debug/muse-desktop.exe
node scripts/cdp-m3-06-07-09-automations.mjs --out docs/evidence/2026-09-27-m3-closure/m3-06-07-09-automations.json
node scripts/cdp-m3-01-local-mcp.mjs
node scripts/cdp-m3-01-04-05.mjs --out docs/evidence/2026-09-27-m3-closure/m3-01-04-05-skills-mcp.json
node scripts/cdp-m3-05-skill-invoke.mjs
```

Note for harness authors: the automation wake task relaunches the app mid-run
(by design) — run wake-registration tests on a single instance, and verify
runs through the `schedule-runs.v1` ledger rather than the UI filter (the runs
zone shows one filter at a time and its filter is a `<select>`).
