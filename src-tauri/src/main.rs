//! muse-desktop supervisor: one `muse serve` MSP host per canonical workspace.
//!
//! Design notes (grounded in `muse serve --help` + the exported MSP schema):
//! - Sandbox posture is fixed at spawn. Sessions in one canonical workspace
//!   share its engine; different workspaces retain independent engines.
//! - Commands and notifications require explicit session ownership; a global
//!   workspace preference never selects the engine for an existing session.
//! - Approval mode is selected from the host's closed enum at session start
//!   and can be changed for subsequent actions with `session/setApprovalMode`.
//! - No agentic logic lives here: spawn, frame relay, kill. The sidecar owns
//!   orchestration (sub-agents included).
//!
//! IPC surface (frontend calls via `invoke`, receives via `listen`):
//!   commands: start_session, set_approval_mode, restore_sessions, send_input, approve,
//!             cancel_session, kill_session,
//!             subagent_interrupt, subagent_stop, subagent_resume,
//!             subagent_followup, subagent_read_result, subagent_drilldown
//!   events:   output, subagent_event, tool_request, status
//! Payloads always carry `session_id` so the hook demultiplexes sessions.

mod msp;
mod hosts;
mod resume;
mod git;
use hosts::Hosts;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager, RunEvent, State};
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

/// One buffered backend event with its sequence number (poll transport).
#[derive(Debug, Serialize, Clone)]
pub struct DrainedEvent {
    pub seq: u64,
    pub session_id: String,
    pub kind: String,
    pub payload: String,
}

/// Poll result: current head cursor plus events after `since`.
#[derive(Debug, Serialize, Clone)]
pub struct PollResult {
    pub head: u64,
    pub events: Vec<DrainedEvent>,
}

/// Workspace scope verdict: whether `path` is confined to the workspace root.
/// Wire shape is `{in_scope, reason}` (snake_case, like the other commands).
#[derive(Debug, Serialize, Clone)]
pub struct ScopeCheck {
    pub in_scope: bool,
    pub reason: String,
}

/// One row of the host model catalog (`model/list` result `models[]`,
/// US-31). Field names are camelCase on the wire; the struct renames them
/// for the TS side, which uses the same names. Only `modelId` is required —
/// every other field is defensive (a newer host may add keys, an older one
/// may omit them).
#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
pub struct ModelEntry {
    pub model_id: String,
    pub display_label: String,
    pub provider_id: String,
    pub profile_id: Option<String>,
    pub is_active: bool,
    pub is_default: bool,
    pub context_limit: Option<u64>,
    pub output_limit: Option<u64>,
}

/// Parse one catalog row defensively: `modelId` (or legacy `id`) is
/// required, everything else falls back to a neutral default. Additive
/// schema evolution must never drop a row the host sent.
fn parse_model_entry(v: &Value) -> Option<ModelEntry> {
    let model_id = v
        .get("modelId")
        .or_else(|| v.get("model_id"))
        .or_else(|| v.get("id"))
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())?;
    let str_or = |keys: &[&str], fallback: &str| {
        keys.iter()
            .filter_map(|k| v.get(*k))
            .filter_map(Value::as_str)
            .find(|s| !s.is_empty())
            .unwrap_or(fallback)
            .to_string()
    };
    let opt_str = |keys: &[&str]| {
        keys.iter()
            .filter_map(|k| v.get(*k))
            .filter_map(Value::as_str)
            .find(|s| !s.is_empty())
            .map(str::to_string)
    };
    let opt_u64 = |keys: &[&str]| {
        keys.iter()
            .filter_map(|k| v.get(*k))
            .filter_map(Value::as_u64)
            .next()
    };
    Some(ModelEntry {
        model_id: model_id.to_string(),
        display_label: str_or(&["displayLabel", "display_label", "label"], model_id),
        provider_id: str_or(&["providerId", "provider_id", "provider"], ""),
        profile_id: opt_str(&["profileId", "profile_id", "profile"]),
        is_active: v
            .get("isActive")
            .or_else(|| v.get("is_active"))
            .and_then(Value::as_bool)
            .unwrap_or(false),
        is_default: v
            .get("isDefault")
            .or_else(|| v.get("is_default"))
            .and_then(Value::as_bool)
            .unwrap_or(false),
        context_limit: opt_u64(&["contextLimit", "context_limit"]),
        output_limit: opt_u64(&["outputLimit", "output_limit"]),
    })
}

/// A pending approval: what `approval/decide` needs beyond the choice itself.
/// `requirement_id` is the opaque race-guard token from `approval/requested`,
/// echoed back verbatim (stale values are rejected by the host, surfaced as
/// the command error — never silently applied).
struct PendingApproval {
    session_id: String,
    requirement_id: Value,
}

/// Sub-agent identity captured from `item/started` for kind `subagent`.
/// Feeds the UI drill-down (childSessionId) and the control commands
/// (agent id = item id). Pure data, no sidecar calls.
#[derive(Debug, Clone, Default)]
struct SubagentMeta {
    child_session_id: Option<String>,
    objective: Option<String>,
    role: Option<String>,
    depth: Option<u64>,
}

/// Pull sub-agent identity out of an `item/started` item object.
/// MSP params are camelCase (`childSessionId`); accept snake_case too —
/// the schema evolves additively and the UI must not lose drill-down
/// over a key rename. Returns None when the item carries no identity.
fn extract_subagent_meta(item: &Value) -> Option<SubagentMeta> {
    let child = item
        .get("childSessionId")
        .or_else(|| item.get("child_session_id"))
        .or_else(|| item.get("childSession"))
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let objective = item
        .get("objective")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let role = item
        .get("role")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let depth = item.get("depth").and_then(Value::as_u64);
    if child.is_none() && objective.is_none() && role.is_none() && depth.is_none() {
        return None;
    }
    Some(SubagentMeta {
        child_session_id: child,
        objective,
        role,
        depth,
    })
}

/// Backend event buffer: the poll transport. `listen`-based push delivery
/// proved undebuggable in one environment (subscriptions resolved yet never
/// fired), so the UI polls this buffer instead — same broadcast semantics,
/// over the already-proven `invoke` path.
const EVENT_BUFFER_CAP: usize = 2000;

struct AppState {
    resume_mutex: tokio::sync::Mutex<()>,
    hosts: Mutex<Hosts<MspClient>>,
    workspace: Mutex<Option<PathBuf>>,
    sessions: Mutex<HashMap<String, SessionMeta>>,
    approvals: Mutex<HashMap<(String, String), PendingApproval>>,
    /// (session_id, item_id) -> MSP item kind (`agentMessage`, `subagent`,
    /// ...). Selects the UI lane for `item/delta`, which carries no kind of
    /// its own. Scoped by session: bare item ids may repeat across sessions.
    item_kinds: Mutex<HashMap<(String, String), String>>,
    /// (session_id, item_id) -> sub-agent identity from `item/started`.
    /// Scoped by session like `item_kinds`; purged with it on kill.
    subagent_meta: Mutex<HashMap<(String, String), SubagentMeta>>,
    /// Serializes host creation: check-spawn-insert must be atomic or two
    /// concurrent `start_session` calls spawn two hosts.
    host_mutex: tokio::sync::Mutex<()>,
    event_seq: Mutex<u64>,
    event_buffer: Mutex<std::collections::VecDeque<DrainedEvent>>,
}

const DIAGNOSTIC_MAX_LINES: usize = 20;
const DIAGNOSTIC_LINE_LIMIT: usize = 1000;
const DIAGNOSTIC_TOTAL_LIMIT: usize = 8000;

/// Truncate by a UTF-8 character boundary. The old byte slice could panic
/// when a host error ended in the middle of a multibyte character.
fn truncate(s: &str, n: usize) -> String {
    if s.len() <= n {
        return s.to_string();
    }
    let mut end = n.min(s.len());
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &s[..end])
}

/// Keep host diagnostics useful without persisting command prompts, bearer
/// tokens or common secret-shaped values. This is deliberately conservative:
/// normal prose is retained, while values following an obvious secret key
/// are replaced before the bounded stderr tail reaches the UI.
fn redact_diagnostic(input: &str) -> String {
    let mut out = input.to_string();
    for prefix in ["Bearer ", "bearer ", "BEARER "] {
        let mut search_from = 0usize;
        while search_from < out.len() {
            let Some(relative) = out[search_from..].find(prefix) else { break; };
            let start = search_from + relative;
            let value_start = start + prefix.len();
            let bytes = out.as_bytes();
            let mut value_end = value_start;
            while value_end < bytes.len()
                && !bytes[value_end].is_ascii_whitespace()
                && !matches!(bytes[value_end], b',' | b';' | b'}' | b']' | b')' | b'"' | b'\'')
            {
                value_end += 1;
            }
            out.replace_range(value_start..value_end, "[redacted]");
            search_from = value_start + "[redacted]".len();
        }
    }
    for key in [
        "token", "access_token", "refresh_token", "api_key", "apikey", "secret", "password",
    ] {
        let mut search_from = 0usize;
        loop {
            let lower = out.to_ascii_lowercase();
            let Some(relative) = lower[search_from..].find(key) else { break; };
            let start = search_from + relative;
            let after_key = start + key.len();
            let bytes = out.as_bytes();
            let mut value_start = after_key;
            while value_start < bytes.len() && bytes[value_start].is_ascii_whitespace() {
                value_start += 1;
            }
            if value_start >= bytes.len() || !matches!(bytes[value_start], b'=' | b':') {
                search_from = after_key;
                continue;
            }
            value_start += 1;
            while value_start < bytes.len() && bytes[value_start].is_ascii_whitespace() {
                value_start += 1;
            }
            let quoted = bytes.get(value_start).copied().is_some_and(|b| b == b'"' || b == b'\'');
            if quoted {
                value_start += 1;
            }
            let mut value_end = value_start;
            while value_end < bytes.len() {
                let b = bytes[value_end];
                if (quoted && (b == b'"' || b == b'\''))
                    || (!quoted && (b.is_ascii_whitespace() || matches!(b, b',' | b';' | b'}' | b']' | b')')))
                {
                    break;
                }
                value_end += 1;
            }
            if value_end > value_start {
                out.replace_range(value_start..value_end, "[redacted]");
                search_from = value_start + "[redacted]".len();
            } else {
                search_from = after_key;
            }
        }
    }
    truncate(&out, DIAGNOSTIC_LINE_LIMIT)
}

/// Reasoning items are streamed through the same `item/delta` notification as
/// assistant messages. Keep the aliases in one place so the frontend can
/// render a dedicated, collapsible thinking lane as hosts evolve.
fn is_thinking_item_kind(kind: &str) -> bool {
    let normalized = kind.to_ascii_lowercase();
    matches!(
        normalized.as_str(),
        "reasoning" | "thinking" | "analysis" | "reasoning_summary" | "reasoningsummary"
    )
}

/// The host reuses one approval id while walking a compound command. Every
/// `approval/updated` notification advances the opaque requirement token and
/// replaces the available choices for the next stage. Keep the normalization
/// in one place so requested and updated payloads reach the same UI lane.
fn approval_payload(p: &Value, approval_id: &str, updated: bool) -> Value {
    let tool = p
        .get("toolName")
        .or_else(|| p.get("tool_name"))
        .and_then(Value::as_str)
        .or_else(|| {
            p.get("subject")
                .and_then(|s| s.get("kind"))
                .and_then(Value::as_str)
                .and_then(|kind| (kind == "shell").then_some("bash"))
        })
        .unwrap_or("tool");
    let summary = p
        .get("rawArgs")
        .or_else(|| p.get("raw_args"))
        .and_then(Value::as_str)
        .or_else(|| {
            p.get("subject")
                .and_then(|s| s.get("command").or_else(|| s.get("rawCommand")))
                .and_then(Value::as_str)
        })
        .or_else(|| {
            p.get("approvalSubject")
                .and_then(|s| s.get("raw_command"))
                .and_then(Value::as_str)
        })
        .unwrap_or("");
    let summary = if summary.is_empty() {
        String::new()
    } else {
        format!("{}: {}", tool, truncate(summary, 200))
    };
    let choices: Vec<Value> = p
        .get("availableChoices")
        .or_else(|| p.get("available_choices"))
        .and_then(Value::as_array)
        .map(|cs| {
            cs.iter()
                .map(|c| {
                    let decision = c
                        .get("decision")
                        .and_then(Value::as_str)
                        .or_else(|| {
                            c.get("decision")
                                .and_then(|d| d.get("kind"))
                                .and_then(Value::as_str)
                        })
                        .unwrap_or("");
                    json!({
                        "choiceId": c.get("choiceId").or_else(|| c.get("choice_id")),
                        "label": c.get("label"),
                        "decision": decision,
                        "scope": c.get("scope"),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    json!({
        "request_id": approval_id,
        "approvalId": approval_id,
        "toolName": tool,
        "summary": summary,
        "choices": choices,
        "itemId": p.get("itemId"),
        "currentRequirementId": p.get("currentRequirementId"),
        "updated": updated,
    })
}

fn approval_terminal(result: &Value) -> bool {
    result
        .get("terminal")
        .and_then(Value::as_bool)
        .or_else(|| {
            result
                .get("result")
                .and_then(|r| r.get("terminal"))
                .and_then(Value::as_bool)
        })
        .unwrap_or(true)
}

/// Map the product-facing posture to the host's closed MSP enum. Keeping this
/// translation in Rust means every wire write is validated even if a stale or
/// malformed renderer invokes the command directly.
fn host_approval_mode(mode: &str) -> Option<&'static str> {
    match mode {
        "ask" => Some("onRequest"),
        "workspace" => Some("promptUnmatched"),
        "yolo" => Some("allowAll"),
        _ => None,
    }
}

/// Validate the minimum initialize contract before the host accepts any
/// session. Unknown additive fields remain allowed, while a missing identity
/// or unsupported schema version produces a startup error with remediation.
fn validate_initialize_result(result: &Value) -> Result<(), String> {
    let server = result
        .get("serverInfo")
        .ok_or_else(|| "incompatible Muse host: initialize response has no serverInfo".to_string())?;
    let name = server
        .get("name")
        .and_then(Value::as_str)
        .ok_or_else(|| "incompatible Muse host: serverInfo.name is missing".to_string())?;
    if name != "muse" {
        return Err(format!(
            "incompatible Muse host: expected serverInfo.name `muse`, got `{name}`"
        ));
    }
    let version = server
        .get("version")
        .and_then(Value::as_str)
        .filter(|v| !v.trim().is_empty())
        .ok_or_else(|| "incompatible Muse host: serverInfo.version is missing".to_string())?;
    let schema = result
        .get("schema")
        .ok_or_else(|| "incompatible Muse host: initialize response has no schema metadata".to_string())?;
    let schema_version = schema
        .get("version")
        .and_then(Value::as_u64)
        .ok_or_else(|| "incompatible Muse host: schema.version is missing".to_string())?;
    if schema_version != 1 {
        return Err(format!(
            "incompatible Muse host {version}: unsupported MSP schema version {schema_version} (expected 1)"
        ));
    }
    let fingerprint = schema
        .get("fingerprint")
        .and_then(Value::as_str)
        .filter(|f| f.starts_with("sha256:") && f.len() > "sha256:".len())
        .ok_or_else(|| "incompatible Muse host: schema.fingerprint is missing or invalid".to_string())?;
    let _ = fingerprint;
    Ok(())
}

fn emit(app: &AppHandle, _event: &str, session_id: &str, kind: &str, payload: String) {
    // Poll transport: buffer the event with a sequence number. The UI drains
    // via `poll_events`. (`event` is kept for log readability.)
    let state: State<AppState> = app.state();
    let (Ok(mut seq), Ok(mut buf)) = (state.event_seq.lock(), state.event_buffer.lock()) else {
        return;
    };
    *seq += 1;
    buf.push_back(DrainedEvent {
        seq: *seq,
        session_id: session_id.to_string(),
        kind: kind.to_string(),
        payload,
    });
    while buf.len() > EVENT_BUFFER_CAP {
        buf.pop_front();
    }
}

fn mark_running(state: &State<AppState>, session_id: &str, running: bool) {
    if let Ok(mut sessions) = state.sessions.lock() {
        if let Some(meta) = sessions.get_mut(session_id) {
            meta.running = running;
        }
    }
}

/// Spawn (or reuse) the sidecar host for `root`, running the MSP handshake.
/// Reuse the workspace host without stopping engines owned by other projects.
async fn ensure_host(
    app: &AppHandle,
    state: &State<'_, AppState>,
    root: &PathBuf,
) -> Result<std::sync::Arc<MspClient>, String> {
    // Serialize creation: without this, two concurrent `start_session` calls
    // both pass the check below and spawn two hosts (loser shut down, its
    // in-flight requests failing spuriously).
    let _creation = state.host_mutex.lock().await;
    if let Some(client) = state.hosts.lock().map_err(|e| format!("state lock: {e}"))?.workspace(root) {
        return Ok(client);
    }
    let (rx, child) = spawn_sidecar(app, root)?;
    let shared: SharedChild = std::sync::Arc::new(tokio::sync::Mutex::new(Some(child)));
    let (notify_tx, notify_rx) = mpsc::unbounded_channel::<(String, Value)>();
    let client = std::sync::Arc::new(MspClient::new(shared, notify_tx));
    let stderr_tail = std::sync::Arc::new(Mutex::new(Vec::<String>::new()));

    state.hosts.lock().map_err(|e| format!("state lock: {e}"))?
        .insert(root.clone(), client.clone());
    pump_stdout(app.clone(), rx, client.clone(), stderr_tail.clone());
    pump_notifications(app.clone(), notify_rx, client.clone());

    // A failed handshake must kill the just-spawned child: dropping the
    // handle never kills the process, so an early Err here would leak one
    // running `muse serve` per failed attempt.
    //
    // The handshake is two steps (proven against the real binary): the
    // `initialize` response alone leaves the host uninitialized — the
    // `initialized` notification completes it, and every later call fails
    // `Not initialized` without it.
    let handshake = async {
        let initialized = client
            .request(
                "initialize",
                json!({"clientInfo": {"name": "muse_desktop", "version": "0.1.0"}}),
            )
            .await?;
        validate_initialize_result(&initialized)?;
        client.notify("initialized", Value::Null).await
    };
    if let Err(e) = handshake.await {
        state.hosts.lock().map_err(|e| format!("state lock: {e}"))?.remove(&client);
        client.shutdown().await;
        return Err(format!(
            "MSP handshake failed ({e}). Host stderr: {}",
            tail_of(&stderr_tail)
        ));
    }

    Ok(client)
}

fn tail_of(stderr_tail: &std::sync::Arc<Mutex<Vec<String>>>) -> String {
    let joined = stderr_tail
        .lock()
        .map(|t| t.join(" | "))
        .unwrap_or_default();
    truncate(&joined, DIAGNOSTIC_TOTAL_LIMIT)
}

/// Absolute path of the `muse` sidecar binary.
///
/// The plugin resolves `sidecar(..)` against the app exe directory, which is
/// only where the binary lands in a bundled app (`externalBin`). In dev the
/// binary lives under `src-tauri/binaries/`, and the filename always carries
/// the target triple (bundling convention) — so resolve it ourselves and hand
/// the plugin an absolute path (its join is a no-op on absolute paths).
/// File name of the sidecar binary for this build (bundling convention:
/// always suffixed by the target triple, plus `.exe` on Windows).
fn sidecar_file_name() -> String {
    sidecar_file_name_for(env!("TAURI_ENV_TARGET_TRIPLE"), cfg!(windows))
}

fn sidecar_file_name_for(triple: &str, windows: bool) -> String {
    let mut file = format!("binaries/muse-{triple}");
    if windows && !file.ends_with(".exe") {
        file.push_str(".exe");
    }
    file
}

/// Human-readable "binary missing" error (US-33): names the expected
/// triple-suffixed file, labels both searched locations (exe-dir bundled
/// layout, then src-tauri/binaries dev tree), and lists the exact paths
/// probed so the UI can show them instead of a blank screen.
/// Pure (unit-tested).
fn sidecar_missing_message(file: &str, tried: &[PathBuf]) -> String {
    let tried_list = tried
        .iter()
        .map(|p| p.display().to_string())
        .collect::<Vec<_>>()
        .join(", ");
    format!(
        "sidecar binary not found: expected `{file}` (file name carries the target triple). Tried (1) bundled layout next to the app executable, then (2) dev tree src-tauri/binaries (tried {tried_list}). Place the binary matching your target triple at one of those locations (see src-tauri/binaries/README.md)."
    )
}

fn resolve_sidecar() -> Result<PathBuf, String> {
    let file = sidecar_file_name();
    let mut tried = Vec::new();
    // 1. Next to the app exe (bundled layout, and dev if staged there).
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            // Tauri strips the target suffix and stages externalBin next to
            // the installed app executable (not in the dev binaries folder).
            let bundled = dir.join(if cfg!(windows) { "muse.exe" } else { "muse" });
            tried.push(bundled.clone());
            if bundled.is_file() {
                return Ok(bundled);
            }
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
    Err(sidecar_missing_message(&file, &tried))
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
/// diagnostics; announce host death only to sessions owned by this client.
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
                    let ids = state.hosts.lock().map(|mut hosts| hosts.remove(&client)).unwrap_or_default();
                    client.shutdown().await;
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
        tail.push(redact_diagnostic(&line));
        if tail.len() > DIAGNOSTIC_MAX_LINES {
            tail.remove(0);
        }
    }
}

/// Route MSP notifications to frontend events. Unknown methods are ignored:
/// the schema evolves additively and the client must not choke on new lanes.
fn pump_notifications(
    app: AppHandle,
    mut rx: mpsc::UnboundedReceiver<(String, Value)>,
    client: std::sync::Arc<MspClient>,
) {
    tauri::async_runtime::spawn(async move {
        let mut closed = client.closed_receiver();
        loop {
            if *closed.borrow() { break; }
            let event = tokio::select! {
                _ = closed.changed() => break,
                event = rx.recv() => event,
            };
            let Some((method, params)) = event else { break; };
            let state: State<AppState> = app.state();
            let sid = params.get("sessionId").and_then(Value::as_str).unwrap_or("");
            let owned = state.hosts.lock().map(|h| h.owns(sid, &client)).unwrap_or(false);
            if owned { route_notification(&app, &state, &method, &params); }
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
                    kinds.insert((sid.to_string(), item_id.to_string()), kind.clone());
                }
                // Sub-agent lanes need identity up front (objective/role for
                // the header, childSessionId for drill-down): announce the
                // block now so the UI owns the entry before deltas land.
                if matches!(kind.as_str(), "subagent" | "workflow" | "reminderChild") {
                    let meta = extract_subagent_meta(item);
                    if let Ok(mut metas) = state.subagent_meta.lock() {
                        if let Some(m) = meta.clone() {
                            metas.insert((sid.to_string(), item_id.to_string()), m);
                        }
                    }
                    let mut announce = serde_json::Map::new();
                    announce.insert("agent_id".to_string(), json!(item_id));
                    announce.insert("text".to_string(), json!(""));
                    if let Some(m) = meta {
                        if let Some(c) = m.child_session_id {
                            announce.insert("childSessionId".to_string(), json!(c));
                        }
                        if let Some(o) = m.objective {
                            announce.insert("objective".to_string(), json!(o));
                        }
                        if let Some(r) = m.role {
                            announce.insert("role".to_string(), json!(r));
                        }
                        if let Some(d) = m.depth {
                            announce.insert("depth".to_string(), json!(d));
                        }
                    }
                    emit(
                        app,
                        "subagent_event",
                        sid,
                        "subagent_event",
                        Value::Object(announce).to_string(),
                    );
                }
                // US-10: surface the item start so the UI paints the
                // reflexive phase before the first delta lands (even when
                // no delta ever follows for this item).
                emit(
                    app,
                    "status",
                    sid,
                    "item_started",
                    json!({"itemId": item_id, "itemKind": kind}).to_string(),
                );
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
                    // Re-attach identity learned at `item/started` so entries
                    // created from a bare delta still carry drill-down data.
                    let meta = state
                        .subagent_meta
                        .lock()
                        .map(|m| {
                            m.get(&(sid.to_string(), item_id.to_string())).cloned()
                        })
                        .unwrap_or(None);
                    let mut obj = serde_json::Map::new();
                    obj.insert("agent_id".to_string(), json!(item_id));
                    obj.insert("text".to_string(), json!(delta));
                    if let Some(m) = meta {
                        if let Some(c) = m.child_session_id {
                            obj.insert("childSessionId".to_string(), json!(c));
                        }
                        if let Some(o) = m.objective {
                            obj.insert("objective".to_string(), json!(o));
                        }
                        if let Some(r) = m.role {
                            obj.insert("role".to_string(), json!(r));
                        }
                        if let Some(d) = m.depth {
                            obj.insert("depth".to_string(), json!(d));
                        }
                    }
                    emit(
                        app,
                        "subagent_event",
                        sid,
                        "subagent_event",
                        Value::Object(obj).to_string(),
                    );
                }
                kind if is_thinking_item_kind(kind) => {
                    // Keep reasoning deltas separate from the answer lane so
                    // the UI can expose them behind a disclosure control.
                    emit(app, "thinking", sid, "thinking", item_ref);
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
        "approval/requested" | "approval/updated" => {
            let approval_id = match p.get("approvalId").and_then(Value::as_str) {
                Some(a) => a,
                None => return,
            };
            let requirement = p
                .get("currentRequirementId")
                .or_else(|| p.get("current_requirement_id"))
                .cloned();
            if let Ok(mut approvals) = state.approvals.lock() {
                let key = (sid.to_string(), approval_id.to_string());
                if method == "approval/updated" {
                    if let Some(pending) = approvals.get_mut(&key) {
                        // Metadata-only updates are legal; keep the last
                        // usable token when no replacement is supplied.
                        if let Some(next) = requirement.clone() {
                            pending.requirement_id = next;
                        }
                    } else {
                        approvals.insert(
                            key,
                            PendingApproval {
                                session_id: sid.to_string(),
                                requirement_id: requirement.clone().unwrap_or(Value::Null),
                            },
                        );
                    }
                } else {
                    approvals.insert(
                        key,
                        PendingApproval {
                            session_id: sid.to_string(),
                            requirement_id: requirement.unwrap_or(Value::Null),
                        },
                    );
                }
            }
            emit(
                app,
                "tool_request",
                sid,
                "tool_request",
                approval_payload(p, approval_id, method == "approval/updated").to_string(),
            );
        }
        "approval/resolved" => {
            let approval_id = p.get("approvalId").and_then(Value::as_str);
            if let Some(aid) = approval_id {
                if let Ok(mut approvals) = state.approvals.lock() {
                    approvals.remove(&(sid.to_string(), aid.to_string()));
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
            emit(
                app,
                "status",
                sid,
                method,
                json!({
                    "approvalId": approval_id,
                    "decision": decision,
                    "terminal": true,
                })
                .to_string(),
            );
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
            // The turn suspends until answered: surface as an answerable
            // panel, never a bare log line (a log line leaves the chat
            // hanging with no way to reply).
            match build_input_request_payload(p) {
                Some(payload) => emit(app, "input_request", sid, "input_request", payload.to_string()),
                None => emit(app, "status", sid, "input_requested", "input requested (unparseable)".to_string()),
            }
        }
        "userInput/settled" => {
            let outcome = p.get("outcome").and_then(Value::as_str).unwrap_or("settled");
            let input_id = p.get("userInputId").and_then(Value::as_str).unwrap_or("");
            emit(
                app,
                "input_settled",
                sid,
                "input_settled",
                json!({"inputId": input_id, "outcome": outcome}).to_string(),
            );
        }
        "session/approvalModeChanged" => {
            // Keep the selector's product language aligned with the host's
            // effective projection. `denyUnmatched` is intentionally not
            // fabricated into a fourth UI posture; the renderer surfaces it.
            if let Some(mode) = p.get("mode").and_then(Value::as_str) {
                emit(
                    app,
                    "status",
                    sid,
                    "approval_mode_changed",
                    json!({"mode": mode}).to_string(),
                );
            }
        }
        // US-4 (server half): provider-reported context occupancy
        // (SS4.6.6 triple). The host only emits on change; forward
        // defensively — unknown pressure levels pass through untouched (the
        // enum is open) so a newer host never breaks the UI.
        "session/contextUsage" => {
            if !sid.is_empty() {
                let usage = json!({
                    "pressure": p.get("pressure").and_then(Value::as_str).unwrap_or("unknown"),
                    "usedTokens": p.get("usedTokens").and_then(Value::as_u64),
                    "windowTokens": p.get("windowTokens").and_then(Value::as_u64),
                });
                emit(app, "context_usage", sid, "context_usage", usage.to_string());
            }
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

fn workspace_for_inspection(state: &State<'_, AppState>, session_id: &str) -> Result<PathBuf, String> {
    let session_id = session_id.trim();
    if session_id.is_empty() {
        return Err("sessionId must not be empty".to_string());
    }
    if let Ok(root) = state
        .hosts
        .lock()
        .map_err(|e| format!("state lock: {e}"))?
        .session_workspace(session_id)
    {
        return Ok(root);
    }
    state
        .sessions
        .lock()
        .map_err(|e| format!("state lock: {e}"))?
        .get(session_id)
        .map(|meta| PathBuf::from(&meta.workspace))
        .filter(|root| !root.as_os_str().is_empty())
        .ok_or_else(|| "conversation workspace is unavailable".to_string())
}

/// Read the real Git state for the workspace owned by this conversation.
/// Git runs off the UI thread and only receives an absolute, canonicalized
/// path selected by the supervisor; no shell interpolation is involved.
#[tauri::command]
async fn git_status(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<git::GitStatusSnapshot, String> {
    let root = workspace_for_inspection(&state, &session_id)?;
    tokio::task::spawn_blocking(move || git::status(&root))
        .await
        .map_err(|e| format!("git status task failed: {e}"))?
}

/// Read a bounded unified diff for the session workspace. `scope` is one of
/// `unstaged`, `staged` or `branch`; branch comparisons require an explicit
/// base ref so the UI never guesses which branch the user meant.
#[tauri::command]
async fn git_diff(
    state: State<'_, AppState>,
    session_id: String,
    scope: String,
    base_ref: Option<String>,
) -> Result<git::GitDiffSnapshot, String> {
    let root = workspace_for_inspection(&state, &session_id)?;
    tokio::task::spawn_blocking(move || git::diff(&root, &scope, base_ref))
        .await
        .map_err(|e| format!("git diff task failed: {e}"))?
}

/// Build the frontend `input_request` payload from a `userInput/requested`
/// notification. Pure (unit-tested): questions forwarded verbatim (capped),
/// ids threaded through for the answer round-trip.
fn build_input_request_payload(p: &Value) -> Option<Value> {
    let input_id = p.get("userInputId")?.as_str()?;
    let questions = p.get("questions")?.as_array()?;
    let qs: Vec<Value> = questions
        .iter()
        .take(10)
        .filter_map(|q| {
            let id = q.get("id")?.as_str()?;
            let mode = q
                .get("selection")
                .and_then(|s| s.get("mode"))
                .and_then(Value::as_str)
                .unwrap_or("single");
            if mode != "single" && mode != "multiple" {
                return None;
            }
            let options: Vec<Value> = q
                .get("options")
                .and_then(Value::as_array)
                .map(|os| {
                    os.iter()
                        .take(20)
                        .filter_map(|o| {
                            o.get("label").and_then(Value::as_str).map(|label| {
                                json!({
                                    "label": label,
                                    "description": o.get("description").and_then(Value::as_str).unwrap_or(""),
                                })
                            })
                        })
                        .collect()
                })
                .unwrap_or_default();
            Some(json!({
                "id": id,
                "header": q.get("header").and_then(Value::as_str).unwrap_or(""),
                "question": q.get("question").and_then(Value::as_str).unwrap_or(""),
                "mode": mode,
                "minSelections": q.get("selection").and_then(|s| s.get("minSelections")),
                "maxSelections": q.get("selection").and_then(|s| s.get("maxSelections")),
                "options": options,
            }))
        })
        .collect();
    if qs.is_empty() {
        return None;
    }
    Some(json!({
        "request_id": input_id,
        "inputId": input_id,
        "toolName": p.get("toolName").and_then(Value::as_str).unwrap_or("input"),
        "questions": qs,
        "itemId": p.get("itemId").and_then(Value::as_str).unwrap_or(""),
    }))
}

/// Lexically normalize a path: resolve `.`/`..` and duplicate separators
/// without touching the filesystem. This neutralizes `..` escapes even when
/// the caller passes a non-canonical path; symlinks are neutralized by the
/// `canonicalize()` call in `check_scope` before this comparison runs.
fn normalize_lexical(p: &std::path::Path) -> PathBuf {
    use std::path::Component;
    let mut out = PathBuf::new();
    for comp in p.components() {
        match comp {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            c => out.push(c.as_os_str()),
        }
    }
    if out.as_os_str().is_empty() {
        out.push(".");
    }
    out
}

/// Pure workspace-confinement verdict over (already-resolved) paths.
///
/// Both inputs should be canonical (`canonicalize()` resolves symlinks and
/// `..`); they are normalized lexically first anyway so a stray `..` can
/// never slip through `starts_with`. Component-wise comparison means a
/// sibling like `/ws-evil` is NOT "inside" `/ws`.
fn check_scope_pure(canonical_root: &std::path::Path, canonical_candidate: &std::path::Path) -> ScopeCheck {
    let root = normalize_lexical(canonical_root);
    let cand = normalize_lexical(canonical_candidate);
    if cand == root {
        return ScopeCheck {
            in_scope: true,
            reason: format!("path is the workspace root: {}", root.display()),
        };
    }
    if cand.starts_with(&root) {
        return ScopeCheck {
            in_scope: true,
            reason: format!(
                "path is inside the workspace: {} (root {})",
                cand.display(),
                root.display()
            ),
        };
    }
    ScopeCheck {
        in_scope: false,
        reason: format!(
            "path is outside the workspace root {}: {}",
            root.display(),
            cand.display()
        ),
    }
}

/// Scope guard (US-22): is `path` confined to the current workspace?
/// Outside the workspace → `in_scope: false` with an explicit reason
/// (the US-18 `@`-mention flow maps that to ask/deny). Missing or
/// unresolvable workspace, and empty paths, are hard errors.
#[tauri::command]
fn check_scope(state: State<'_, AppState>, path: String, session_id: Option<String>) -> Result<ScopeCheck, String> {
    if path.trim().is_empty() {
        return Err("empty path".to_string());
    }
    let root = if let Some(sid) = session_id {
        state.hosts.lock().map_err(|e| format!("state lock: {e}"))?.session_workspace(&sid)?
    } else { state
        .workspace
        .lock()
        .map_err(|e| format!("state lock: {e}"))?
        .clone()
        .ok_or_else(|| "no workspace selected — pick a folder first".to_string())? };
    let canonical_root = root
        .canonicalize()
        .map_err(|e| format!("cannot resolve workspace {}: {e}", root.display()))?;
    // Relative candidates resolve against the workspace; absolute ones stand
    // alone. Existing paths are canonicalized (resolves symlinks); missing
    // paths (e.g. a file about to be created) fall back to a lexical check,
    // flagged as such since symlinks on them cannot be resolved.
    let abs = {
        let raw = PathBuf::from(&path);
        if raw.is_absolute() {
            raw
        } else {
            canonical_root.join(raw)
        }
    };
    let (canonical_candidate, lexical_only) = match abs.canonicalize() {
        Ok(p) => (p, false),
        Err(_) => (normalize_lexical(&abs), true),
    };
    let mut verdict = check_scope_pure(&canonical_root, &canonical_candidate);
    if lexical_only {
        verdict.reason.push_str(" (path does not exist: lexical check only, symlinks unresolved)");
    }
    Ok(verdict)
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
    authorization_mode: Option<String>,
) -> Result<SessionMeta, String> {
    let root = resolve_workspace(&state, workspace_path)?;
    let client = ensure_host(&app, &state, &root).await?;
    let mut params = json!({
        "commandId": new_command_id(),
        "workspaceRoot": root.display().to_string(),
    });
    if let Some(mode) = authorization_mode.as_deref() {
        let wire_mode = host_approval_mode(mode)
            .ok_or_else(|| format!("unknown authorization mode: {mode}"))?;
        params["approvalMode"] = json!(wire_mode);
    }
    let res = client
        .request("session/start", params)
        .await?;
    let session = res.get("session").ok_or("session/start: no session in response")?;
    let session_id = session
        .get("sessionId")
        .and_then(Value::as_str)
        .or_else(|| session.get("id").and_then(Value::as_str))
        .ok_or("session/start: response has no session id")?
        .to_string();
    state.hosts.lock().map_err(|e| format!("state lock: {e}"))?.bind(&session_id, &root, &client)?;
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

/// Change the effective approval posture for one live session. The host
/// applies this to subsequent actions; an already pending approval remains
/// guarded by its current requirement token until the user resolves it.
#[tauri::command]
async fn set_approval_mode(
    state: State<'_, AppState>,
    session_id: String,
    mode: String,
) -> Result<Value, String> {
    let wire_mode = host_approval_mode(&mode)
        .ok_or_else(|| format!("unknown authorization mode: {mode}"))?;
    let client = session_client(&state, &session_id)?;
    client
        .request(
            "session/setApprovalMode",
            json!({
                "commandId": new_command_id(),
                "sessionId": session_id,
                "mode": wire_mode,
            }),
        )
        .await
}

/// Explicitly attach a saved durable session; never create a replacement ID.
#[tauri::command]
async fn resume_session(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    workspace_path: String,
) -> Result<SessionMeta, String> {
    let _resume = state.resume_mutex.lock().await;
    let root = resolve_workspace(&state, Some(workspace_path))?;
    if session_client(&state, &session_id).is_ok() {
        let owner_root = state.hosts.lock().map_err(|e| e.to_string())?.session_workspace(&session_id)?;
        if owner_root != root { return Err("conversation belongs to a different workspace".into()); }
        return state.sessions.lock().map_err(|e| e.to_string())?.get(&session_id).cloned()
            .ok_or_else(|| "conversation metadata is unavailable".into());
    }
    let client = ensure_host(&app, &state, &root).await?;
    let read = client.request("session/read", json!({"sessionId":session_id,"excludeItems":true})).await?;
    resume::validate(read.get("session").ok_or("session/read returned no conversation")?, &session_id, &root)?;
    // Register before resume: pending approval/input events may immediately
    // follow the response, before this awaiting task is scheduled again.
    let mut meta = SessionMeta { session_id: session_id.clone(), workspace: root.display().to_string(), running: false };
    state.sessions.lock().map_err(|e| e.to_string())?.insert(session_id.clone(), meta.clone());
    state.hosts.lock().map_err(|e| e.to_string())?.bind(&session_id, &root, &client)?;
    let result = client.request("session/resume", resume::params(&session_id, new_command_id())).await;
    match result {
        Ok(result) => {
            let session = result.get("session").ok_or_else(|| "session/resume returned no conversation".to_string());
            let checked = session.and_then(|s| { resume::validate(s, &session_id, &root)?; Ok(s) });
            match checked {
                Ok(session) => {
                    meta.running = session.get("status").and_then(Value::as_str) == Some("running");
                    state.sessions.lock().map_err(|e| e.to_string())?.insert(session_id.clone(), meta.clone());
                    Ok(meta)
                }
                Err(error) => { state.hosts.lock().map_err(|e| e.to_string())?.forget(&session_id); Err(error) }
            }
        }
        Err(error) => {
            state.hosts.lock().map_err(|e| e.to_string())?.forget(&session_id);
            Err(format!("could not reconnect conversation: {error}"))
        }
    }
}

/// Drain backend events after `since` (None = head cursor only, no replay).
/// The UI polls this every ~300ms instead of `listen` push delivery.
#[tauri::command]
fn poll_events(state: State<'_, AppState>, since: Option<u64>) -> Result<PollResult, String> {
    let head = state
        .event_seq
        .lock()
        .map_err(|e| format!("state lock: {e}"))?;
    let head = *head;
    let since = since.unwrap_or(head);
    let buf = state
        .event_buffer
        .lock()
        .map_err(|e| format!("state lock: {e}"))?;
    Ok(PollResult {
        head,
        events: buf.iter().filter(|e| e.seq > since).cloned().collect(),
    })
}

#[tauri::command]
async fn restore_sessions(state: State<'_, AppState>) -> Result<Vec<SessionMeta>, String> {
    let clients = state.hosts.lock().map_err(|e| format!("state lock: {e}"))?.snapshot();
    let mut out = Vec::new();
    for (_, client) in clients {
        let res = client.request("session/list", json!({})).await?;
        if let Some(sessions) = res.get("sessions").and_then(Value::as_array) {
            for s in sessions {
                let Some(sid) = s.get("sessionId").or_else(|| s.get("id")).and_then(Value::as_str) else { continue };
                if !state.hosts.lock().map_err(|e| format!("state lock: {e}"))?.owns(sid, &client) { continue; }
                if let Some(mut meta) = state.sessions.lock().map_err(|e| format!("state lock: {e}"))?.get(sid).cloned() {
                    meta.running = s.get("status").and_then(Value::as_str) == Some("running");
                    out.push(meta);
                }
            }
        }
    }
    Ok(out)
}

/// US-31: live host model catalog (`model/list`). A query, not a command —
/// no `commandId` param (the JSON-RPC frame id is minted by `request`).
/// No host yet (fresh boot): empty list, the UI falls back to its sample
/// registry. `session_id` is optional; when present the row matching that
/// session's effective model is flagged `isActive` by the host.
#[tauri::command]
async fn list_models(
    state: State<'_, AppState>,
    session_id: Option<String>,
) -> Result<Vec<ModelEntry>, String> {
    let client = if let Some(sid) = session_id.as_deref().filter(|id| !id.trim().is_empty()) {
        session_client(&state, sid)?
    } else {
        let root = state.workspace.lock().map_err(|e| format!("state lock: {e}"))?.clone();
        let Some(client) = root.and_then(|root| state.hosts.lock().ok()?.workspace(&root)) else { return Ok(Vec::new()); };
        client
    };
    let mut params = json!({});
    if let Some(sid) = session_id {
        if !sid.trim().is_empty() {
            params["sessionId"] = json!(sid);
        }
    }
    let res = client.request("model/list", params).await?;
    let mut out = Vec::new();
    if let Some(models) = res.get("models").and_then(Value::as_array) {
        for m in models {
            if let Some(entry) = parse_model_entry(m) {
                out.push(entry);
            }
        }
    }
    Ok(out)
}

/// US-4 (server half): real context compaction (`session/compact`). The ack
/// is admission-only (`accepted`); the work runs async on the host and its
/// terminal outcome arrives as a view event. `noop` (e.g.
/// `no_compactable_history`) is a success, not an error. Wire rejections
/// become friendly errors: `missing_run` (nothing to compact yet),
/// `run_active` (a turn is streaming — wait for it to finish).
#[tauri::command]
async fn compact_session(state: State<'_, AppState>, session_id: String) -> Result<String, String> {
    let client = session_client(&state, &session_id)?;
    let res = client
        .request(
            "session/compact",
            json!({
                "commandId": new_command_id(),
                "sessionId": session_id,
            }),
        )
        .await
        .map_err(|e| describe_compact_failure(&e))?;
    Ok(res
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("accepted")
        .to_string())
}

/// Map a `session/compact` wire failure to a user-facing sentence. Proven
/// against the live host: fresh session → `missing_run`, streaming turn →
/// `run_active`, empty history → `noop` (success, handled by the caller).
fn describe_compact_failure(wire_error: &str) -> String {
    if wire_error.contains("missing_run") {
        return "nothing to compact yet — send a turn first".to_string();
    }
    if wire_error.contains("run_active") {
        return "a turn is still streaming — compact once it finishes".to_string();
    }
    wire_error.to_string()
}

/// US-31: model-picker gesture (`session/setModel`). Durable on the host,
/// applies to subsequent model calls of that session. `model_id` is the
/// catalog id (required by schema); provider/profile ride along when known.
#[tauri::command]
async fn set_model(
    state: State<'_, AppState>,
    session_id: String,
    model_id: String,
    provider_id: Option<String>,
    profile_id: Option<String>,
) -> Result<(), String> {
    if model_id.trim().is_empty() {
        return Err("empty model id".to_string());
    }
    let client = session_client(&state, &session_id)?;
    let mut model = json!({ "modelId": model_id });
    if let Some(p) = provider_id.filter(|s| !s.trim().is_empty()) {
        model["providerId"] = json!(p);
    }
    if let Some(p) = profile_id.filter(|s| !s.trim().is_empty()) {
        model["profileId"] = json!(p);
    }
    client
        .request(
            "session/setModel",
            json!({
                "commandId": new_command_id(),
                "sessionId": session_id,
                "model": model,
            }),
        )
        .await?;
    Ok(())
}

#[tauri::command]
async fn send_input(
    state: State<'_, AppState>,
    session_id: String,
    command_id: String,
    text: String,
) -> Result<Value, String> {
    if command_id.trim().is_empty() {
        return Err("empty commandId".to_string());
    }
    if text.trim().is_empty() {
        return Err("empty input".to_string());
    }
    let client = session_client(&state, &session_id)?;
    let result = client
        .request(
            "turn/start",
            json!({
                // The frontend persists this id before the request starts.
                // Reusing it makes an ambiguous retry idempotent at the
                // supervisor boundary instead of admitting a second turn.
                "commandId": command_id,
                "sessionId": session_id,
                "input": [{"type": "text", "text": text}],
            }),
        )
        .await?;
    mark_running(&state, &session_id, true);
    Ok(result)
}

#[tauri::command]
async fn approve(
    state: State<'_, AppState>,
    session_id: String,
    approval_id: String,
    choice_id: String,
) -> Result<bool, String> {
    let requirement_id = {
        let approvals = state
            .approvals
            .lock()
            .map_err(|e| format!("state lock: {e}"))?;
        let pending = approvals
            .get(&(session_id.clone(), approval_id.clone()))
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
    let client = session_client(&state, &session_id)?;
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
    // decide cannot replay it. The bool is returned to the UI so it keeps a
    // compound approval card mounted while the host advances its stages.
    let terminal = approval_terminal(&res);
    if terminal {
        if let Ok(mut approvals) = state.approvals.lock() {
            approvals.remove(&(session_id.clone(), approval_id.clone()));
        }
    }
    Ok(terminal)
}

/// Answer a suspended input prompt. `answers` is a JSON array of
/// `{questionId, selectedLabel?|selectedLabels?|freeText?}`; the host is the
/// final validator (-32057 surfaces here as the command error, panel stays).
#[tauri::command]
async fn answer_input(
    state: State<'_, AppState>,
    session_id: String,
    user_input_id: String,
    answers: Value,
) -> Result<(), String> {
    let answers = answers.as_array().filter(|a| !a.is_empty()).ok_or_else(|| {
        "answers must be a non-empty JSON array".to_string()
    })?;
    for a in answers.iter() {
        let obj = a.as_object().ok_or("each answer must be an object")?;
        obj.get("questionId")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .ok_or("each answer needs a questionId")?;
        let has_label = obj.get("selectedLabel").and_then(Value::as_str).map(|s| !s.is_empty()).unwrap_or(false);
        let has_labels = obj.get("selectedLabels").and_then(Value::as_array).map(|l| !l.is_empty()).unwrap_or(false);
        let has_text = obj.get("freeText").and_then(Value::as_str).map(|s| !s.is_empty()).unwrap_or(false);
        if [has_label, has_labels, has_text].iter().filter(|&&b| b).count() != 1 {
            return Err("each answer needs exactly one of selectedLabel, selectedLabels, freeText".to_string());
        }
        if let Some(t) = obj.get("freeText").and_then(Value::as_str) {
            if t.len() > 500 {
                return Err("freeText is capped at 500 chars".to_string());
            }
        }
    }
    let client = session_client(&state, &session_id)?;
    client
        .request(
            "userInput/answer",
            json!({
                "commandId": new_command_id(),
                "sessionId": session_id,
                "userInputId": user_input_id,
                "answers": answers,
            }),
        )
        .await?;
    Ok(())
}

/// Decline an input prompt; the tool call resolves cancelled (model-visible).
#[tauri::command]
async fn cancel_input(
    state: State<'_, AppState>,
    session_id: String,
    user_input_id: String,
) -> Result<(), String> {
    let client = session_client(&state, &session_id)?;
    client
        .request(
            "userInput/cancel",
            json!({
                "commandId": new_command_id(),
                "sessionId": session_id,
                "userInputId": user_input_id,
                "reason": "declined in UI",
            }),
        )
        .await?;
    Ok(())
}

/// MSP method names for the control-only `subagent/*` family (schema 1.2.1:
/// close/followupTask/interrupt/readResult/reopen/resume/sendMessage/stop —
/// no spawn/start). Each UI control below calls exactly one of these.
const SUBAGENT_INTERRUPT_METHOD: &str = "subagent/interrupt";
const SUBAGENT_STOP_METHOD: &str = "subagent/stop";
const SUBAGENT_RESUME_METHOD: &str = "subagent/resume";
const SUBAGENT_FOLLOWUP_METHOD: &str = "subagent/followupTask";
const SUBAGENT_READ_RESULT_METHOD: &str = "subagent/readResult";
/// Drill-down target: the child's own session transcript, when the host
/// exposes it.
const SESSION_READ_METHOD: &str = "session/read";

fn require_non_empty(value: &str, what: &str) -> Result<String, String> {
    let v = value.trim().to_string();
    if v.is_empty() {
        return Err(format!("{what} must not be empty"));
    }
    Ok(v)
}

/// Base params shared by every `subagent/*` control call, following the
/// existing commands' shape (`commandId` UUIDv7 + `sessionId`).
/// Pure (unit-tested): validation only, no sidecar I/O.
fn subagent_control_payload(
    method: &str,
    session_id: &str,
    agent_id: &str,
) -> Result<(String, Value), String> {
    let session_id = require_non_empty(session_id, "sessionId")?;
    let agent_id = require_non_empty(agent_id, "agentId")?;
    Ok((
        method.to_string(),
        json!({
            "commandId": new_command_id(),
            "sessionId": session_id,
            "agentId": agent_id,
        }),
    ))
}

/// Params for `subagent/followupTask`: base ids plus the follow-up text.
/// Pure (unit-tested).
fn subagent_followup_payload(
    session_id: &str,
    agent_id: &str,
    task: &str,
) -> Result<(String, Value), String> {
    let (method, mut params) =
        subagent_control_payload(SUBAGENT_FOLLOWUP_METHOD, session_id, agent_id)?;
    let task = require_non_empty(task, "task")?;
    params
        .as_object_mut()
        .ok_or("followup payload is not an object")?
        .insert("task".to_string(), json!(task));
    Ok((method, params))
}

fn session_client(state: &AppState, session_id: &str) -> Result<std::sync::Arc<MspClient>, String> {
    state.hosts.lock().map_err(|e| format!("state lock: {e}"))?.session(session_id)
}

async fn subagent_control(
    state: &State<'_, AppState>,
    method: &str,
    session_id: &str,
    agent_id: &str,
) -> Result<(), String> {
    let (method, params) = subagent_control_payload(method, session_id, agent_id)?;
    session_client(state, session_id)?.request(&method, params).await?;
    Ok(())
}

#[tauri::command]
async fn subagent_interrupt(
    state: State<'_, AppState>,
    session_id: String,
    agent_id: String,
) -> Result<(), String> {
    subagent_control(&state, SUBAGENT_INTERRUPT_METHOD, &session_id, &agent_id).await
}

#[tauri::command]
async fn subagent_stop(
    state: State<'_, AppState>,
    session_id: String,
    agent_id: String,
) -> Result<(), String> {
    subagent_control(&state, SUBAGENT_STOP_METHOD, &session_id, &agent_id).await
}

#[tauri::command]
async fn subagent_resume(
    state: State<'_, AppState>,
    session_id: String,
    agent_id: String,
) -> Result<(), String> {
    subagent_control(&state, SUBAGENT_RESUME_METHOD, &session_id, &agent_id).await
}

#[tauri::command]
async fn subagent_followup(
    state: State<'_, AppState>,
    session_id: String,
    agent_id: String,
    task: String,
) -> Result<(), String> {
    let (method, params) = subagent_followup_payload(&session_id, &agent_id, &task)?;
    session_client(&state, &session_id)?.request(&method, params).await?;
    Ok(())
}

#[tauri::command]
async fn subagent_read_result(
    state: State<'_, AppState>,
    session_id: String,
    agent_id: String,
) -> Result<Value, String> {
    let (method, params) =
        subagent_control_payload(SUBAGENT_READ_RESULT_METHOD, &session_id, &agent_id)?;
    Ok(session_client(&state, &session_id)?.request(&method, params).await?)
}

/// Open a sub-agent's child session transcript via `session/read` when the
/// host exposes it; otherwise fail with an explicit error (never an empty
/// view the user could mistake for "no output yet").
#[tauri::command]
async fn subagent_drilldown(
    state: State<'_, AppState>,
    session_id: String,
    child_session_id: String,
) -> Result<Value, String> {
    let session_id = require_non_empty(&session_id, "sessionId")?;
    let child = require_non_empty(&child_session_id, "childSessionId")?;
    let params = json!({
        "commandId": new_command_id(),
        "sessionId": child,
    });
    session_client(&state, &session_id)?
        .request(SESSION_READ_METHOD, params)
        .await
        .map_err(|e| {
            format!(
                "session/read unavailable for child session {child} of {session_id}: {e}"
            )
        })
}

/// M0-03: after an ambiguous send (ack timeout, restart mid-flight) the
/// frontend must verify the server conversation before retransmitting, so
/// one logical send can never become two accepted turns. Reuses the
/// registered `session/read` method — no new MSP RPC.
#[tauri::command]
async fn check_input_reached(
    state: State<'_, AppState>,
    session_id: String,
    command_id: String,
) -> Result<bool, String> {
    let session_id = require_non_empty(&session_id, "sessionId")?;
    let command_id = require_non_empty(&command_id, "commandId")?;
    let client = session_client(&state, &session_id)?;
    let read = client
        .request(
            SESSION_READ_METHOD,
            json!({"commandId": new_command_id(), "sessionId": session_id}),
        )
        .await
        .map_err(|e| format!("session/read unavailable for {session_id}: {e}"))?;
    Ok(input_reached(&read, &command_id))
}

/// True when the server exposes the stable command/turn identifier in its
/// structured session/read payload.  Never inspect arbitrary text: a user or
/// assistant repeating the same words must not be mistaken for delivery.
fn input_reached(read: &Value, command_id: &str) -> bool {
    if command_id.trim().is_empty() {
        return false;
    }
    fn scan(v: &Value, command_id: &str) -> bool {
        match v {
            Value::Array(items) => items.iter().any(|i| scan(i, command_id)),
            Value::Object(map) => {
                ["commandId", "turnId"].iter().any(|key| {
                    map.get(*key)
                        .and_then(Value::as_str)
                        .is_some_and(|value| value == command_id)
                }) || map.values().any(|v| scan(v, command_id))
            }
            _ => false,
        }
    }
    scan(read, command_id)
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
    let client = session_client(state, session_id).ok();
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
    // A late resume must not resurrect a conversation the user just deleted.
    let _resume = state.resume_mutex.lock().await;
    // Retire ownership before accepting further notifications for this session.
    // The host process is shared by all sessions, so it is NOT killed here:
    // end the turn (best effort) and forget local records.
    interrupt_session(&app, &state, &session_id).await;
    if let Ok(mut hosts) = state.hosts.lock() { hosts.forget(&session_id); }
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
    // Same for the sub-agent identity table (stale childSessionId entries
    // would attach the wrong drill-down to a reused item id).
    if let Ok(mut metas) = state.subagent_meta.lock() {
        metas.retain(|(sid, _), _| *sid != session_id);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn truncate_respects_utf8_boundaries() {
        let text = "éclair — Muse";
        let clipped = truncate(text, 1);
        assert_eq!(clipped, "…");
        let clipped = truncate(text, 2);
        assert_eq!(clipped, "é…");
    }

    #[test]
    fn diagnostics_redact_secret_shaped_values_and_bound_length() {
        let redacted = redact_diagnostic("token=super-secret password: 'pāsswørd' Bearer abc123");
        assert!(!redacted.contains("super-secret"));
        assert!(!redacted.contains("pāsswørd"));
        assert!(!redacted.contains("Bearer abc123"));
        assert!(!redacted.contains("abc123"));
        assert!(redacted.contains("[redacted]"));
        assert!(redact_diagnostic(&"界".repeat(5000)).len() <= DIAGNOSTIC_LINE_LIMIT + "…".len());
    }

    #[test]
    fn stderr_tail_keeps_recent_bounded_sanitized_lines() {
        let tail = std::sync::Arc::new(Mutex::new(Vec::new()));
        for i in 0..(DIAGNOSTIC_MAX_LINES + 3) {
            push_stderr(&tail, format!("line {i} token=secret-{i}"));
        }
        let entries = tail.lock().unwrap();
        assert_eq!(entries.len(), DIAGNOSTIC_MAX_LINES);
        assert!(entries[0].contains("line 3"));
        assert!(entries.iter().all(|line| !line.contains("secret-")));
    }

    #[test]
    fn product_authorization_modes_map_to_closed_host_values() {
        assert_eq!(host_approval_mode("ask"), Some("onRequest"));
        assert_eq!(host_approval_mode("workspace"), Some("promptUnmatched"));
        assert_eq!(host_approval_mode("yolo"), Some("allowAll"));
        assert_eq!(host_approval_mode("deny"), None);
    }

    #[test]
    fn initialize_compatibility_accepts_the_official_contract() {
        let result = json!({
            "serverInfo": {"name": "muse", "version": "1.3.0"},
            "schema": {"version": 1, "fingerprint": "sha256:abc123"},
            "grantedCapabilities": []
        });
        assert!(validate_initialize_result(&result).is_ok());
    }

    #[test]
    fn initialize_compatibility_rejects_missing_or_unsupported_metadata() {
        let missing = json!({"serverInfo": {"name": "muse", "version": "1.3.0"}});
        let unsupported = json!({
            "serverInfo": {"name": "muse", "version": "2.0.0"},
            "schema": {"version": 2, "fingerprint": "sha256:abc123"}
        });
        let wrong_name = json!({
            "serverInfo": {"name": "other", "version": "1.3.0"},
            "schema": {"version": 1, "fingerprint": "sha256:abc123"}
        });
        assert!(validate_initialize_result(&missing).is_err());
        assert!(validate_initialize_result(&unsupported)
            .unwrap_err()
            .contains("unsupported MSP schema version"));
        assert!(validate_initialize_result(&wrong_name)
            .unwrap_err()
            .contains("expected serverInfo.name"));
    }

    #[test]
    fn input_reached_matches_only_server_turn_identifiers() {
        let read = json!({
            "session": {"sessionId": "sess-1", "path": "durable.jsonl"},
            "events": [
                {"itemId": "i1", "role": "user", "text": "hello there",
                 "commandId": "cmd-1", "turnId": "turn-1"},
                {"itemId": "i2", "role": "assistant", "text": "cmd-1"}
            ]
        });
        assert!(input_reached(&read, "cmd-1"));
        assert!(input_reached(&read, "turn-1"));
        // The same string in a transcript field is not evidence of delivery.
        assert!(!input_reached(&read, "hello there"));
        assert!(!input_reached(&read, ""));
        assert!(!input_reached(&Value::Null, "cmd-1"));
    }

    #[test]
    fn reasoning_item_kind_aliases_use_the_thinking_lane() {
        for kind in [
            "reasoning",
            "thinking",
            "analysis",
            "reasoning_summary",
            "reasoningSummary",
        ] {
            assert!(is_thinking_item_kind(kind), "{kind}");
        }
        assert!(!is_thinking_item_kind("agentMessage"));
    }

    #[test]
    fn compound_approval_updates_keep_the_new_requirement_and_choices() {
        let updated = json!({
            "approvalId": "approval-1",
            "currentRequirementId": {"approvalId": "approval-1", "sourceIndex": 1},
            "availableChoices": [
                {"choiceId": "allow_once", "label": "Allow once", "decision": "approved", "scope": "once"},
                {"choiceId": "abort", "label": "Reject", "decision": "abort", "scope": "once"}
            ],
            "subject": {"kind": "shell", "command": "echo hello"}
        });
        let payload = approval_payload(&updated, "approval-1", true);
        assert_eq!(payload["updated"], true);
        assert_eq!(payload["toolName"], "bash");
        assert_eq!(payload["summary"], "bash: echo hello");
        assert_eq!(payload["choices"][0]["choiceId"], "allow_once");
        assert_eq!(payload["currentRequirementId"]["sourceIndex"], 1);
        assert!(!approval_terminal(&json!({"terminal": false})));
        assert!(!approval_terminal(&json!({"result": {"terminal": false}})));
        assert!(approval_terminal(&json!({"status": "accepted"})));
    }

    fn sample_prompt() -> Value {
        json!({
            "sessionId": "sess-1",
            "itemId": "item-9",
            "toolName": "ask",
            "toolCallId": "tc-1",
            "turnId": "t-1",
            "userInputId": "ui-7",
            "questions": [
                {
                    "id": "q1",
                    "header": "Format",
                    "question": "Which format?",
                    "selection": {"mode": "single"},
                    "options": [
                        {"label": "Short", "description": "under 100 words"},
                        {"label": "Long"}
                    ]
                },
                {
                    "id": "q2",
                    "header": "Topics",
                    "question": "Pick topics",
                    "selection": {"mode": "multiple", "minSelections": 1, "maxSelections": 2},
                    "options": [{"label": "A"}, {"label": "B"}]
                }
            ]
        })
    }

    #[test]
    fn input_payload_threads_ids_and_modes() {
        let out = build_input_request_payload(&sample_prompt()).unwrap();
        assert_eq!(out["inputId"], "ui-7");
        assert_eq!(out["request_id"], "ui-7");
        assert_eq!(out["questions"].as_array().unwrap().len(), 2);
        assert_eq!(out["questions"][0]["mode"], "single");
        assert_eq!(out["questions"][0]["options"][0]["label"], "Short");
        assert_eq!(out["questions"][1]["mode"], "multiple");
        assert_eq!(out["questions"][1]["maxSelections"], 2);
    }

    #[test]
    fn input_payload_rejects_missing_id_or_empty_questions() {
        let mut bad = sample_prompt();
        bad.as_object_mut().unwrap().remove("userInputId");
        assert!(build_input_request_payload(&bad).is_none());
        let empty = json!({"userInputId": "x", "questions": []});
        assert!(build_input_request_payload(&empty).is_none());
    }

    fn scope_root() -> PathBuf {
        PathBuf::from("/tmp/muse-ws")
    }

    #[test]
    fn scope_root_itself_is_in_scope() {
        let v = check_scope_pure(&scope_root(), &scope_root());
        assert!(v.in_scope, "{}", v.reason);
    }

    #[test]
    fn scope_nested_path_is_in_scope() {
        let v = check_scope_pure(&scope_root(), &PathBuf::from("/tmp/muse-ws/src/a.ts"));
        assert!(v.in_scope, "{}", v.reason);
    }

    #[test]
    fn scope_outside_path_is_denied_with_reason() {
        let v = check_scope_pure(&scope_root(), &PathBuf::from("/etc/passwd"));
        assert!(!v.in_scope, "{}", v.reason);
        assert!(v.reason.contains("outside"), "{}", v.reason);
        let expected = normalize_lexical(&PathBuf::from("/etc/passwd"));
        assert!(v.reason.contains(expected.to_string_lossy().as_ref()), "{}", v.reason);
    }

    #[test]
    fn scope_dotdot_escape_is_denied() {
        // `..` must not slip through `starts_with`: the pure check
        // normalizes lexically even when given a non-canonical path.
        let v = check_scope_pure(&scope_root(), &PathBuf::from("/tmp/muse-ws/sub/../../evil"));
        assert!(!v.in_scope, "{}", v.reason);
    }

    #[test]
    fn scope_sibling_prefix_is_not_inside() {
        // Component-wise comparison: `/tmp/muse-ws-evil` shares a string
        // prefix but is a different directory.
        let v = check_scope_pure(&scope_root(), &PathBuf::from("/tmp/muse-ws-evil/x"));
        assert!(!v.in_scope, "{}", v.reason);
    }

    #[test]
    fn scope_dot_segments_are_neutralized() {
        let v = check_scope_pure(&scope_root(), &PathBuf::from("/tmp/muse-ws/./sub"));
        assert!(v.in_scope, "{}", v.reason);
    }

    #[test]
    #[cfg(unix)]
    fn scope_symlink_escape_is_denied_after_canonicalize() {
        // End-to-end pattern of the command: canonicalize (resolves the
        // symlink) then the pure verdict. `link` lives inside the root but
        // points outside, so the verdict must be out-of-scope.
        let base = std::env::temp_dir().join(format!("muse-scope-test-{}", std::process::id()));
        let root = base.join("ws");
        std::fs::create_dir_all(root.join("sub")).unwrap();
        std::os::unix::fs::symlink("/tmp", root.join("sub").join("link")).unwrap();
        let canonical_root = root.canonicalize().unwrap();
        let canonical_cand = root.join("sub").join("link").join("x").canonicalize();
        // `/tmp/x` may not exist; canonicalize the link itself instead.
        let canonical_cand = match canonical_cand {
            Ok(p) => p,
            Err(_) => root.join("sub").join("link").canonicalize().unwrap(),
        };
        let v = check_scope_pure(&canonical_root, &canonical_cand);
        assert!(!v.in_scope, "{}", v.reason);
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn sidecar_file_name_carries_triple_suffix() {
        assert_eq!(
            sidecar_file_name_for("x86_64-unknown-linux-gnu", false),
            "binaries/muse-x86_64-unknown-linux-gnu"
        );
        assert_eq!(
            sidecar_file_name_for("aarch64-apple-darwin", false),
            "binaries/muse-aarch64-apple-darwin"
        );
    }

    #[test]
    fn sidecar_file_name_adds_exe_on_windows() {
        assert_eq!(
            sidecar_file_name_for("x86_64-pc-windows-msvc", true),
            "binaries/muse-x86_64-pc-windows-msvc.exe"
        );
    }

    #[test]
    fn sidecar_missing_message_names_file_and_both_locations() {
        let tried = vec![
            PathBuf::from("/app/binaries/muse-x86_64-unknown-linux-gnu"),
            PathBuf::from("/src/src-tauri/binaries/muse-x86_64-unknown-linux-gnu"),
        ];
        let msg = sidecar_missing_message("binaries/muse-x86_64-unknown-linux-gnu", &tried);
        assert!(msg.contains("binaries/muse-x86_64-unknown-linux-gnu"), "{msg}");
        assert!(msg.contains("target triple"), "{msg}");
        assert!(msg.contains("/app/binaries/muse-x86_64-unknown-linux-gnu"), "{msg}");
        assert!(msg.contains("/src/src-tauri/binaries/muse-x86_64-unknown-linux-gnu"), "{msg}");
        assert!(msg.contains("src-tauri/binaries"), "{msg}");
        assert!(msg.contains("src-tauri/binaries/README.md"), "{msg}");
    }

    #[test]
    fn input_payload_drops_bad_modes_but_keeps_good() {
        let mut p = sample_prompt();
        p["questions"][0]["selection"]["mode"] = json!("ranked");
        let out = build_input_request_payload(&p).unwrap();
        let qs = out["questions"].as_array().unwrap();
        assert_eq!(qs.len(), 1);
        assert_eq!(qs[0]["id"], "q2");
    }

    #[test]
    fn subagent_controls_hit_their_own_msp_method() {
        // US-6 AC: each UI control calls its matching MSP method, with the
        // shared commandId/sessionId shape.
        let cases = [
            (SUBAGENT_INTERRUPT_METHOD, "subagent/interrupt"),
            (SUBAGENT_STOP_METHOD, "subagent/stop"),
            (SUBAGENT_RESUME_METHOD, "subagent/resume"),
            (SUBAGENT_READ_RESULT_METHOD, "subagent/readResult"),
        ];
        for (method, expected) in cases {
            let (m, params) = subagent_control_payload(method, "sess-1", "item-9").unwrap();
            assert_eq!(m, expected);
            assert_eq!(params["sessionId"], "sess-1");
            assert_eq!(params["agentId"], "item-9");
            assert!(params["commandId"].as_str().is_some_and(|s| !s.is_empty()));
        }
    }

    #[test]
    fn subagent_followup_carries_the_task_text() {
        let (m, params) = subagent_followup_payload("sess-1", "item-9", "dig deeper").unwrap();
        assert_eq!(m, "subagent/followupTask");
        assert_eq!(params["task"], "dig deeper");
        assert_eq!(params["sessionId"], "sess-1");
        assert_eq!(params["agentId"], "item-9");
    }

    #[test]
    fn model_entry_parses_full_live_row() {
        let row = json!({
            "modelId": "muse-spark-1.3-contributor",
            "displayLabel": "muse-spark-1.3-contributor",
            "providerId": "meta",
            "profileId": "tbh",
            "isActive": false,
            "isDefault": true,
            "contextLimit": 1007997,
            "outputLimit": 128000,
            "cost": {"input": "0.10"},
        });
        let e = parse_model_entry(&row).unwrap();
        assert_eq!(e.model_id, "muse-spark-1.3-contributor");
        assert_eq!(e.display_label, "muse-spark-1.3-contributor");
        assert_eq!(e.provider_id, "meta");
        assert_eq!(e.profile_id.as_deref(), Some("tbh"));
        assert!(!e.is_active);
        assert!(e.is_default);
        assert_eq!(e.context_limit, Some(1007997));
        assert_eq!(e.output_limit, Some(128000));
    }

    #[test]
    fn model_entry_requires_an_id_but_tolerates_sparse_rows() {
        assert!(parse_model_entry(&json!({})).is_none());
        assert!(parse_model_entry(&json!({"modelId": ""})).is_none());
        assert!(parse_model_entry(&json!({"modelId": "  "})).is_none());
        // Sparse row: label falls back to the id, flags default off.
        let e = parse_model_entry(&json!({"id": "legacy-1"})).unwrap();
        assert_eq!(e.model_id, "legacy-1");
        assert_eq!(e.display_label, "legacy-1");
        assert_eq!(e.provider_id, "");
        assert_eq!(e.profile_id, None);
        assert!(!e.is_active && !e.is_default);
        assert_eq!(e.context_limit, None);
    }

    #[test]
    fn compact_failures_map_to_user_sentences() {
        assert_eq!(
            describe_compact_failure("session/compact command c: missing_run"),
            "nothing to compact yet — send a turn first"
        );
        assert_eq!(
            describe_compact_failure("session/compact command c: run_active"),
            "a turn is still streaming — compact once it finishes"
        );
        // Unknown wire text passes through untouched for the banner.
        assert_eq!(
            describe_compact_failure("boom -32030"),
            "boom -32030"
        );
    }

    #[test]
    fn subagent_payloads_reject_blank_ids() {
        assert!(subagent_control_payload(SUBAGENT_STOP_METHOD, "", "item-9").is_err());
        assert!(subagent_control_payload(SUBAGENT_STOP_METHOD, "sess-1", "  ").is_err());
        assert!(subagent_followup_payload("sess-1", "item-9", "").is_err());
        assert!(subagent_followup_payload("sess-1", "", "task").is_err());
    }

    #[test]
    fn subagent_meta_extraction_keeps_drilldown_identity() {
        let item = json!({
            "kind": "subagent",
            "objective": "explore the repo",
            "role": "explorer",
            "depth": 1,
            "childSessionId": "child-42",
        });
        let meta = extract_subagent_meta(&item).unwrap();
        assert_eq!(meta.child_session_id.as_deref(), Some("child-42"));
        assert_eq!(meta.objective.as_deref(), Some("explore the repo"));
        assert_eq!(meta.role.as_deref(), Some("explorer"));
        assert_eq!(meta.depth, Some(1));
        // snake_case fallback: drill-down must survive a key rename.
        let snake = json!({"kind": "subagent", "child_session_id": "child-7"});
        assert_eq!(
            extract_subagent_meta(&snake).unwrap().child_session_id.as_deref(),
            Some("child-7")
        );
        // Items without identity contribute nothing (no empty announce).
        assert!(extract_subagent_meta(&json!({"kind": "subagent"})).is_none());
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState {
            resume_mutex: tokio::sync::Mutex::new(()),
            hosts: Mutex::new(Hosts::default()),
            workspace: Mutex::new(None),
            sessions: Mutex::new(HashMap::new()),
            approvals: Mutex::new(HashMap::new()),
            item_kinds: Mutex::new(HashMap::new()),
            subagent_meta: Mutex::new(HashMap::new()),
            host_mutex: tokio::sync::Mutex::new(()),
            event_seq: Mutex::new(0),
            event_buffer: Mutex::new(std::collections::VecDeque::new()),
        })
        .invoke_handler(tauri::generate_handler![
            start_session,
            set_approval_mode,
            resume_session,
            restore_sessions,
            send_input,
            approve,
            answer_input,
            cancel_input,
            cancel_session,
            kill_session,
            set_workspace,
            check_scope,
            git_status,
            git_diff,
            list_models,
            set_model,
            compact_session,
            poll_events,
            subagent_interrupt,
            subagent_stop,
            subagent_resume,
            subagent_followup,
            subagent_read_result,
            subagent_drilldown,
            check_input_reached,
        ])
        .build(tauri::generate_context!())
        .expect("failed to build muse-desktop app")
        .run(|app, event| {
            // Clean shutdown: kill every workspace sidecar so no `muse`
            // process survives app exit.
            if let RunEvent::Exit = event {
                let state: State<AppState> = app.state();
                let clients = state.hosts.lock().map(|mut h| h.drain()).unwrap_or_default();
                for client in clients { tauri::async_runtime::block_on(client.shutdown()); }
            }
        });
}
