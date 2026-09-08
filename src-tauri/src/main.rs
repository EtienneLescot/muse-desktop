//! muse-desktop supervisor: one shared `muse serve` MSP host, sessions multiplexed.
//!
//! Design notes (grounded in `muse serve --help` + the exported MSP schema):
//! - `muse serve` is a session host over stdio: sandbox posture is fixed at
//!   spawn, and ONE host loads every session. So this layer keeps a SINGLE
//!   sidecar child and multiplexes sessions by `sessionId` — not one process
//!   per session (that would strand durability and force one sandbox posture
//!   negotiation per session for no benefit).
//! - Approval mode is intentionally NOT selected on the wire: the host seals
//!   a startup ceiling and rejects selections (`approval_mode_ceiling`), so
//!   `session/start` omits it and inherits the sealed default.
//! - No agentic logic lives here: spawn, frame relay, kill. The sidecar owns
//!   orchestration (sub-agents included).
//!
//! IPC surface (frontend calls via `invoke`, receives via `listen`):
//!   commands: start_session, restore_sessions, send_input, approve,
//!             cancel_session, kill_session
//!   events:   output, subagent_event, tool_request, status
//! Payloads always carry `session_id` so the hook demultiplexes sessions.

mod msp;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, RunEvent, State};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;
use tokio::sync::mpsc;

use msp::{new_command_id, split_lines, MspClient, SharedChild};

/// Metadata for one session, as the UI models it.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SessionMeta {
    pub session_id: String,
    pub workspace: String,
    pub running: bool,
}

/// Events emitted to the frontend. `kind` selects the UI lane
/// (`output` / `subagent_event` / `tool_request` / `status`).
#[derive(Debug, Serialize, Clone)]
pub struct SessionEvent {
    pub session_id: String,
    pub kind: String,
    pub payload: String,
}

/// A pending approval: what `approval/decide` needs beyond the choice itself.
/// `requirement_id` is the opaque race-guard token from `approval/requested`,
/// echoed back verbatim (stale values are rejected by the host, surfaced as
/// the command error — never silently applied).
struct PendingApproval {
    session_id: String,
    requirement_id: Value,
}

/// One live sidecar host: workspace it was spawned for, MSP client, and a
/// capped ring of its recent stderr lines (surfaced when the host dies, since
/// stderr has no session to route to).
struct Host {
    workspace: PathBuf,
    client: std::sync::Arc<MspClient>,
}

struct AppState {
    host: Mutex<Option<Host>>,
    workspace: Mutex<Option<PathBuf>>,
    sessions: Mutex<HashMap<String, SessionMeta>>,
    approvals: Mutex<HashMap<String, PendingApproval>>,
    /// (session_id, item_id) -> MSP item kind (`agentMessage`, `subagent`,
    /// ...). Selects the UI lane for `item/delta`, which carries no kind of
    /// its own. Scoped by session: bare item ids may repeat across sessions.
    item_kinds: Mutex<HashMap<(String, String), String>>,
    /// Serializes host creation: check-spawn-insert must be atomic or two
    /// concurrent `start_session` calls spawn two hosts.
    host_mutex: tokio::sync::Mutex<()>,
}

fn truncate(s: &str, n: usize) -> String {
    if s.len() <= n {
        s.to_string()
    } else {
        format!("{}…", &s[..n])
    }
}

fn emit(app: &AppHandle, event: &str, session_id: &str, kind: &str, payload: String) {
    let _ = app.emit(
        event,
        SessionEvent {
            session_id: session_id.to_string(),
            kind: kind.to_string(),
            payload,
        },
    );
}

fn mark_running(state: &State<AppState>, session_id: &str, running: bool) {
    if let Ok(mut sessions) = state.sessions.lock() {
        if let Some(meta) = sessions.get_mut(session_id) {
            meta.running = running;
        }
    }
}

/// Spawn (or reuse) the sidecar host for `root`, running the MSP handshake.
/// One host per workspace: a different workspace respawns (kills) the old one.
async fn ensure_host(
    app: &AppHandle,
    state: &State<'_, AppState>,
    root: &PathBuf,
) -> Result<std::sync::Arc<MspClient>, String> {
    // Serialize creation: without this, two concurrent `start_session` calls
    // both pass the check below and spawn two hosts (loser shut down, its
    // in-flight requests failing spuriously).
    let _creation = state.host_mutex.lock().await;
    {
        let host = state.host.lock().map_err(|e| format!("state lock: {e}"))?;
        if let Some(h) = host.as_ref() {
            if h.workspace == *root {
                return Ok(h.client.clone());
            }
        }
    }
    // Different workspace (or first use): shut the old host down outside the lock.
    let old = state
        .host
        .lock()
        .map_err(|e| format!("state lock: {e}"))?
        .take();
    if let Some(h) = old {
        h.client.shutdown().await;
    }

    let (rx, child) = spawn_sidecar(app, root)?;
    let shared: SharedChild = std::sync::Arc::new(tokio::sync::Mutex::new(Some(child)));
    let (notify_tx, notify_rx) = mpsc::unbounded_channel::<(String, Value)>();
    let client = std::sync::Arc::new(MspClient::new(shared, notify_tx));
    let stderr_tail = std::sync::Arc::new(Mutex::new(Vec::<String>::new()));

    pump_stdout(app.clone(), rx, client.clone(), stderr_tail.clone());
    pump_notifications(app.clone(), notify_rx);

    // A failed handshake must kill the just-spawned child: dropping the
    // handle never kills the process, so an early Err here would leak one
    // running `muse serve` per failed attempt.
    //
    // The handshake is two steps (proven against the real binary): the
    // `initialize` response alone leaves the host uninitialized — the
    // `initialized` notification completes it, and every later call fails
    // `Not initialized` without it.
    let handshake = async {
        client
            .request(
                "initialize",
                json!({"clientInfo": {"name": "muse_desktop", "version": "0.1.0"}}),
            )
            .await?;
        client.notify("initialized", Value::Null).await
    };
    if let Err(e) = handshake.await {
        client.shutdown().await;
        return Err(format!(
            "MSP handshake failed ({e}). Host stderr: {}",
            tail_of(&stderr_tail)
        ));
    }

    state
        .host
        .lock()
        .map_err(|e| format!("state lock: {e}"))?
        .replace(Host {
            workspace: root.clone(),
            client: client.clone(),
        });
    Ok(client)
}

fn tail_of(stderr_tail: &std::sync::Arc<Mutex<Vec<String>>>) -> String {
    stderr_tail
        .lock()
        .map(|t| t.join(" | "))
        .unwrap_or_default()
}

/// Absolute path of the `muse` sidecar binary.
///
/// The plugin resolves `sidecar(..)` against the app exe directory, which is
/// only where the binary lands in a bundled app (`externalBin`). In dev the
/// binary lives under `src-tauri/binaries/`, and the filename always carries
/// the target triple (bundling convention) — so resolve it ourselves and hand
/// the plugin an absolute path (its join is a no-op on absolute paths).
fn resolve_sidecar() -> Result<PathBuf, String> {
    let triple = env!("TAURI_ENV_TARGET_TRIPLE");
    let mut file = format!("binaries/muse-{triple}");
    if cfg!(windows) && !file.ends_with(".exe") {
        file.push_str(".exe");
    }
    let mut tried = Vec::new();
    // 1. Next to the app exe (bundled layout, and dev if staged there).
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let p = dir.join(&file);
            tried.push(p.clone());
            if p.is_file() {
                return Ok(p);
            }
        }
    }
    // 2. Dev source tree (compile-time manifest dir is absolute in dev).
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(&file);
    tried.push(p.clone());
    if p.is_file() {
        return Ok(p);
    }
    Err(format!(
        "sidecar binary not found (tried {}); bundle binaries/muse-<triple> (see src-tauri/binaries/README.md)",
        tried
            .iter()
            .map(|p| p.display().to_string())
            .collect::<Vec<_>>()
            .join(", ")
    ))
}

fn spawn_sidecar(
    app: &AppHandle,
    root: &PathBuf,
) -> Result<(tauri::async_runtime::Receiver<CommandEvent>, CommandChild), String> {
    let bin = resolve_sidecar()?;
    let cmd = app
        .shell()
        .sidecar(&bin)
        .map_err(|e| format!("sidecar command failed for {}: {e}", bin.display()))?
        .args(["serve"])
        .current_dir(root);
    cmd.spawn().map_err(|e| {
        format!(
            "could not spawn sidecar `muse serve` in {}: {e}",
            root.display()
        )
    })
}

/// Forward the host's stdout frames into the MSP client; stash stderr for
/// diagnostics; announce host death to every known session.
fn pump_stdout(
    app: AppHandle,
    mut rx: tauri::async_runtime::Receiver<CommandEvent>,
    client: std::sync::Arc<MspClient>,
    stderr_tail: std::sync::Arc<Mutex<Vec<String>>>,
) {
    tauri::async_runtime::spawn(async move {
        let mut out_buf = Vec::new();
        let mut err_buf = Vec::new();
        while let Some(ev) = rx.recv().await {
            match ev {
                CommandEvent::Stdout(chunk) => {
                    for line in split_lines(&mut out_buf, &chunk) {
                        match serde_json::from_str::<Value>(&line) {
                            Ok(frame) => client.ingest(frame).await,
                            Err(_) => push_stderr(&stderr_tail, format!("unparsable frame: {line}")),
                        }
                    }
                }
                CommandEvent::Stderr(chunk) => {
                    for line in split_lines(&mut err_buf, &chunk) {
                        push_stderr(&stderr_tail, line);
                    }
                }
                CommandEvent::Terminated(payload) => {
                    let state: State<AppState> = app.state();
                    let ids: Vec<String> = state
                        .sessions
                        .lock()
                        .map(|t| t.keys().cloned().collect())
                        .unwrap_or_default();
                    let why = format!(
                        "sidecar host exited (code {:?}, signal {:?}). {}",
                        payload.code,
                        payload.signal,
                        tail_of(&stderr_tail)
                    );
                    for sid in ids {
                        mark_running(&state, &sid, false);
                        emit(&app, "status", &sid, "host_exited", why.clone());
                    }
                    break;
                }
                _ => {}
            }
        }
    });
}

fn push_stderr(stderr_tail: &std::sync::Arc<Mutex<Vec<String>>>, line: String) {
    if let Ok(mut tail) = stderr_tail.lock() {
        tail.push(line);
        if tail.len() > 20 {
            tail.remove(0);
        }
    }
}

/// Route MSP notifications to frontend events. Unknown methods are ignored:
/// the schema evolves additively and the client must not choke on new lanes.
fn pump_notifications(
    app: AppHandle,
    mut rx: mpsc::UnboundedReceiver<(String, Value)>,
) {
    tauri::async_runtime::spawn(async move {
        while let Some((method, params)) = rx.recv().await {
            let state: State<AppState> = app.state();
            route_notification(&app, &state, &method, &params);
        }
    });
}

fn route_notification(app: &AppHandle, state: &State<AppState>, method: &str, p: &Value) {
    let sid = p.get("sessionId").and_then(Value::as_str).unwrap_or("");
    match method {
        "item/started" => {
            if let (Some(item_id), Some(item)) = (
                p.get("itemId").and_then(Value::as_str),
                p.get("item"),
            ) {
                let kind = item
                    .get("kind")
                    .and_then(Value::as_str)
                    .unwrap_or("agentMessage")
                    .to_string();
                if let Ok(mut kinds) = state.item_kinds.lock() {
                    kinds.insert((sid.to_string(), item_id.to_string()), kind);
                }
            }
        }
        "item/delta" => {
            let (Some(item_id), Some(delta)) = (
                p.get("itemId").and_then(Value::as_str),
                p.get("delta").and_then(Value::as_str),
            ) else {
                return;
            };
            let kind = state
                .item_kinds
                .lock()
                .map(|k| {
                    k.get(&(sid.to_string(), item_id.to_string()))
                        .cloned()
                        .unwrap_or_default()
                })
                .unwrap_or_default();
            // itemId rides along so the UI closes exactly this block on
            // completion instead of every open block in the session.
            let item_ref = json!({"itemId": item_id, "text": delta}).to_string();
            match kind.as_str() {
                "subagent" | "workflow" | "reminderChild" => {
                    let payload = json!({"agent_id": item_id, "text": delta}).to_string();
                    emit(app, "subagent_event", sid, "subagent_event", payload);
                }
                _ => emit(app, "output", sid, "output", item_ref),
            }
        }
        "item/completed" | "item/updated" => {
            // Carries the item id: the UI closes only this block, so a
            // concurrent item keeps streaming into its own entry.
            let item_id = p
                .get("item")
                .and_then(|i| i.get("itemId").or_else(|| i.get("id")))
                .and_then(Value::as_str)
                .or_else(|| p.get("itemId").and_then(Value::as_str))
                .unwrap_or("");
            emit(app, "status", sid, "item_done", json!({"itemId": item_id}).to_string());
        }
        "approval/requested" => {
            let approval_id = match p.get("approvalId").and_then(Value::as_str) {
                Some(a) => a,
                None => return,
            };
            let requirement = p.get("currentRequirementId").cloned().unwrap_or(Value::Null);
            if let Ok(mut approvals) = state.approvals.lock() {
                approvals.insert(
                    approval_id.to_string(),
                    PendingApproval {
                        session_id: sid.to_string(),
                        requirement_id: requirement,
                    },
                );
            }
            let tool = p.get("toolName").and_then(Value::as_str).unwrap_or("tool");
            let summary = format!(
                "{}: {}",
                tool,
                truncate(p.get("rawArgs").and_then(Value::as_str).unwrap_or(""), 200)
            );
            let choices: Vec<Value> = p
                .get("availableChoices")
                .and_then(Value::as_array)
                .map(|cs| {
                    cs.iter()
                        .map(|c| {
                            json!({
                                "choiceId": c.get("choiceId"),
                                "label": c.get("label"),
                                "decision": c.get("decision"),
                                "scope": c.get("scope"),
                            })
                        })
                        .collect()
                })
                .unwrap_or_default();
            let payload = json!({
                "request_id": approval_id,
                "approvalId": approval_id,
                "toolName": tool,
                "summary": summary,
                "choices": choices,
                "itemId": p.get("itemId"),
            })
            .to_string();
            emit(app, "tool_request", sid, "tool_request", payload);
        }
        "approval/updated" | "approval/resolved" => {
            if method == "approval/resolved" {
                if let Some(aid) = p.get("approvalId").and_then(Value::as_str) {
                    if let Ok(mut approvals) = state.approvals.lock() {
                        approvals.remove(aid);
                    }
                }
            }
            let decision = p
                .get("decision")
                .and_then(Value::as_str)
                .or_else(|| {
                    p.get("resolution")
                        .and_then(|r| r.get("decision"))
                        .and_then(Value::as_str)
                })
                .unwrap_or("resolved");
            emit(app, "status", sid, method, decision.to_string());
        }
        "turn/started" => emit(app, "status", sid, "started", String::new()),
        "turn/completed" => {
            let terminal = p.get("terminal").and_then(Value::as_str).unwrap_or("completed");
            let detail = p
                .get("reason")
                .and_then(Value::as_str)
                .map(str::to_string)
                .or_else(|| {
                    p.get("error")
                        .and_then(|e| e.get("message"))
                        .and_then(Value::as_str)
                        .map(str::to_string)
                })
                .unwrap_or_default();
            mark_running(state, sid, false);
            emit(app, "status", sid, terminal, detail);
        }
        "turn/retracted" | "turn/unqueued" | "turn/retryScheduled" => {
            emit(app, "status", sid, method, String::new())
        }
        "userInput/requested" => {
            // V1 gap: free-text input prompts have no inline answer UI; they
            // surface as a system log line instead of hanging silently.
            let prompt = p
                .get("prompt")
                .and_then(Value::as_str)
                .or_else(|| p.get("message").and_then(Value::as_str))
                .unwrap_or("input requested");
            emit(app, "status", sid, "input_requested", prompt.to_string());
        }
        _ => {}
    }
}

/// Persist the picked workspace on the Rust side immediately, so the backend
/// holds it as source of truth even if a later `start_session` arg were lost.
#[tauri::command]
fn set_workspace(state: State<'_, AppState>, path: String) -> Result<String, String> {
    let root = PathBuf::from(&path);
    if !root.is_dir() {
        return Err(format!("workspace is not a directory: {path}"));
    }
    let root = root
        .canonicalize()
        .map_err(|e| format!("cannot resolve workspace {path}: {e}"))?;
    if let Ok(mut w) = state.workspace.lock() {
        *w = Some(root.clone());
    }
    Ok(root.display().to_string())
}

fn resolve_workspace(
    state: &State<AppState>,
    workspace_path: Option<String>,
) -> Result<PathBuf, String> {
    let arg_present = workspace_path.is_some();
    let root = workspace_path
        .map(PathBuf::from)
        .or_else(|| state.workspace.lock().ok().and_then(|w| w.clone()))
        .ok_or_else(|| {
            format!(
                "no workspace selected — pick a folder first (arg present: {arg_present})"
            )
        })?;
    if !root.is_dir() {
        return Err(format!("workspace is not a directory: {}", root.display()));
    }
    // Symlinks/canonicalization stay local: the sidecar inherits this cwd.
    let root = root
        .canonicalize()
        .map_err(|e| format!("cannot resolve workspace {}: {e}", root.display()))?;
    if let Ok(mut w) = state.workspace.lock() {
        *w = Some(root.clone());
    }
    Ok(root)
}

#[tauri::command]
async fn start_session(
    app: AppHandle,
    state: State<'_, AppState>,
    workspace_path: Option<String>,
) -> Result<SessionMeta, String> {
    let root = resolve_workspace(&state, workspace_path)?;
    let client = ensure_host(&app, &state, &root).await?;
    // No `approvalMode` on the wire: the host seals a startup ceiling
    // (observed: `promptUnmatched`) and rejects any selected mode as
    // `approval_mode_ceiling` — omitted selects the sealed default.
    let res = client
        .request(
            "session/start",
            json!({
                "commandId": new_command_id(),
                "workspaceRoot": root.display().to_string(),
            }),
        )
        .await?;
    let session = res.get("session").ok_or("session/start: no session in response")?;
    let session_id = session
        .get("sessionId")
        .and_then(Value::as_str)
        .or_else(|| session.get("id").and_then(Value::as_str))
        .ok_or("session/start: response has no session id")?
        .to_string();
    let running = session.get("status").and_then(Value::as_str).map(|s| s == "running").unwrap_or(false);
    let meta = SessionMeta {
        session_id: session_id.clone(),
        workspace: root.display().to_string(),
        running,
    };
    state
        .sessions
        .lock()
        .map_err(|e| format!("state lock: {e}"))?
        .insert(session_id, meta.clone());
    Ok(meta)
}

#[tauri::command]
async fn restore_sessions(state: State<'_, AppState>) -> Result<Vec<SessionMeta>, String> {
    // No host yet (fresh boot before any workspace): nothing live to report;
    // the frontend restores its persisted history on its own.
    let client = {
        state
            .host
            .lock()
            .map_err(|e| format!("state lock: {e}"))?
            .as_ref()
            .map(|h| h.client.clone())
    };
    let Some(client) = client else {
        return Ok(Vec::new());
    };
    let res = client.request("session/list", json!({})).await?;
    let mut out = Vec::new();
    if let Some(sessions) = res.get("sessions").and_then(Value::as_array) {
        for s in sessions {
            let Some(sid) = s
                .get("sessionId")
                .and_then(Value::as_str)
                .or_else(|| s.get("id").and_then(Value::as_str))
            else {
                continue;
            };
            let ws = s
                .get("workspaceRoot")
                .and_then(Value::as_str)
                .or_else(|| s.get("workspace").and_then(Value::as_str))
                .unwrap_or("")
                .to_string();
            let running = s.get("status").and_then(Value::as_str).map(|v| v == "running").unwrap_or(false);
            out.push(SessionMeta {
                session_id: sid.to_string(),
                workspace: ws,
                running,
            });
        }
    }
    Ok(out)
}

#[tauri::command]
async fn send_input(
    state: State<'_, AppState>,
    session_id: String,
    text: String,
) -> Result<(), String> {
    if text.trim().is_empty() {
        return Err("empty input".to_string());
    }
    let client = {
        state
            .host
            .lock()
            .map_err(|e| format!("state lock: {e}"))?
            .as_ref()
            .map(|h| h.client.clone())
    };
    let Some(client) = client else {
        return Err("no sidecar host — start a session first".to_string());
    };
    client
        .request(
            "turn/start",
            json!({
                "commandId": new_command_id(),
                "sessionId": session_id,
                "input": [{"type": "text", "text": text}],
            }),
        )
        .await?;
    mark_running(&state, &session_id, true);
    Ok(())
}

#[tauri::command]
async fn approve(
    state: State<'_, AppState>,
    session_id: String,
    approval_id: String,
    choice_id: String,
) -> Result<(), String> {
    let requirement_id = {
        let approvals = state
            .approvals
            .lock()
            .map_err(|e| format!("state lock: {e}"))?;
        let pending = approvals
            .get(&approval_id)
            .ok_or_else(|| format!("unknown or stale approval: {approval_id}"))?;
        // The requirement token belongs to exactly one session: a mismatched
        // caller id (stale click after a session switch, mis-paired id) must
        // never decide another session's approval.
        if pending.session_id != session_id {
            return Err(format!(
                "approval {approval_id} belongs to a different session"
            ));
        }
        pending.requirement_id.clone()
    };
    let client = {
        state
            .host
            .lock()
            .map_err(|e| format!("state lock: {e}"))?
            .as_ref()
            .map(|h| h.client.clone())
    };
    let Some(client) = client else {
        return Err("no sidecar host — start a session first".to_string());
    };
    // A stale requirementId is rejected by the host (-32053) and surfaces as
    // this command's error: a decision can never silently satisfy a new stage.
    let res = client
        .request(
            "approval/decide",
            json!({
                "commandId": new_command_id(),
                "sessionId": session_id,
                "approvalId": approval_id,
                "choiceId": choice_id,
                "requirementId": requirement_id,
            }),
        )
        .await?;
    // Multi-stage approvals stay pending (terminal=false) for further
    // decisions; a terminal decision retires the cached token so a repeated
    // decide cannot replay it.
    if res.get("terminal").and_then(Value::as_bool).unwrap_or(true) {
        if let Ok(mut approvals) = state.approvals.lock() {
            approvals.remove(&approval_id);
        }
    }
    Ok(())
}

#[tauri::command]
async fn cancel_session(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
) -> Result<(), String> {
    interrupt_session(&app, &state, &session_id).await;
    Ok(())
}

/// Shared body of `cancel_session`: best-effort turn interrupt, mark stopped.
async fn interrupt_session(app: &AppHandle, state: &State<'_, AppState>, session_id: &str) {
    // Clone the client out of the lock first: the std guard must never be
    // held across an await (it is !Send through the child handle).
    let client = state
        .host
        .lock()
        .ok()
        .and_then(|h| h.as_ref().map(|x| x.client.clone()));
    if let Some(c) = client {
        // Best effort: no running turn means the host rejects this; the
        // session is stopped either way.
        let _ = c
            .request(
                "turn/interrupt",
                json!({
                    "commandId": new_command_id(),
                    "sessionId": session_id,
                    "retract": false,
                }),
            )
            .await;
    }
    mark_running(state, session_id, false);
    emit(app, "status", session_id, "cancelled", String::new());
}

#[tauri::command]
async fn kill_session(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
) -> Result<(), String> {
    // The host process is shared by all sessions, so it is NOT killed here:
    // end the turn (best effort) and forget local records.
    interrupt_session(&app, &state, &session_id).await;
    if let Ok(mut sessions) = state.sessions.lock() {
        sessions.remove(&session_id);
    }
    if let Ok(mut approvals) = state.approvals.lock() {
        approvals.retain(|_, p| p.session_id != session_id);
    }
    // Drop this session's lane table: unbounded growth plus stale itemId->kind
    // entries that could misroute a later session reusing an item id.
    if let Ok(mut kinds) = state.item_kinds.lock() {
        kinds.retain(|(sid, _), _| *sid != session_id);
    }
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState {
            host: Mutex::new(None),
            workspace: Mutex::new(None),
            sessions: Mutex::new(HashMap::new()),
            approvals: Mutex::new(HashMap::new()),
            item_kinds: Mutex::new(HashMap::new()),
            host_mutex: tokio::sync::Mutex::new(()),
        })
        .invoke_handler(tauri::generate_handler![
            start_session,
            restore_sessions,
            send_input,
            approve,
            cancel_session,
            kill_session,
            set_workspace,
        ])
        .build(tauri::generate_context!())
        .expect("failed to build muse-desktop app")
        .run(|app, event| {
            // Clean shutdown: kill the shared sidecar host so no `muse`
            // process survives app exit.
            if let RunEvent::Exit = event {
                let state: State<AppState> = app.state();
                let host = state.host.lock().map(|mut h| h.take()).unwrap_or(None);
                if let Some(h) = host {
                    tauri::async_runtime::block_on(h.client.shutdown());
                }
            }
        });
}
