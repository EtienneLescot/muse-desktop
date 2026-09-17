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
//!   commands: start_session, fork_session, set_approval_mode, restore_sessions, send_input, steer_input, approve,
//!             cancel_session, kill_session, user_shell,
//!             subagent_interrupt, subagent_stop, subagent_resume,
//!             subagent_followup, subagent_read_result, subagent_drilldown
//!   events:   output, subagent_event, tool_request, status
//! Payloads always carry `session_id` so the hook demultiplexes sessions.

mod msp;
mod hosts;
mod resume;
mod git;
mod terminal;
mod files;
mod artifact_export;
mod browser_download;
mod setup;
mod mcp;
mod skills;
mod startup;
mod workspace_watch;
use hosts::Hosts;

use base64::Engine as _;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager, RunEvent, State, Url, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_shell::process::{CommandChild, CommandEvent, TerminatedPayload};
use tauri_plugin_shell::ShellExt;
use tokio::sync::mpsc;

use msp::{new_command_id, split_lines, MspClient, SharedChild};

/// Metadata for one session, as the UI models it.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SessionMeta {
    pub session_id: String,
    pub workspace: String,
    pub running: bool,
    /// Durability reported by `initialize` (for example `ephemeral`).
    /// Renderer copy must not offer resume when the host cannot persist a
    /// session beyond its process lifetime.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_durability: Option<String>,
    /// The host's effective approval projection when the session API returns
    /// one. This is advisory renderer metadata; automatic decisions still
    /// require an explicit per-session confirmation in the hook.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub approval_mode: Option<String>,
    /// Capabilities granted by the workspace-owned host at initialize time.
    /// This is live connection metadata; an absent value means an older host
    /// did not expose the capability registry, so the renderer must keep the
    /// native user-shell action disabled until a fresh handshake proves it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub granted_capabilities: Option<Vec<String>>,
}

/// One buffered backend event with its sequence number (poll transport).
#[derive(Debug, Serialize, Clone)]
pub struct DrainedEvent {
    pub seq: u64,
    pub session_id: String,
    pub kind: String,
    pub payload: String,
}

/// Poll result: current head cursor plus events after `since`. `truncated`
/// makes event loss explicit when the renderer fell behind the bounded ring;
/// the caller can then re-read durable history and pending requests.
#[derive(Debug, Serialize, Clone)]
pub struct PollResult {
    pub head: u64,
    pub oldest: Option<u64>,
    pub truncated: bool,
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
    /// Host-level initialize facts, keyed by canonical workspace root.
    host_durability: Mutex<HashMap<PathBuf, String>>,
    /// Host-level capability grants, keyed by canonical workspace root.
    /// Capabilities are fixed for a connection lifetime and never inferred
    /// from the renderer's authorization posture.
    host_capabilities: Mutex<HashMap<PathBuf, Vec<String>>>,
    approvals: Mutex<HashMap<(String, String), PendingApproval>>,
    /// (session_id, item_id) -> MSP item kind (`agentMessage`, `subagent`,
    /// ...). Selects the UI lane for `item/delta`, which carries no kind of
    /// its own. Scoped by session: bare item ids may repeat across sessions.
    item_kinds: Mutex<HashMap<(String, String), String>>,
    /// (session_id, item_id) -> sub-agent identity from `item/started`.
    /// Scoped by session like `item_kinds`; purged with it on kill.
    subagent_meta: Mutex<HashMap<(String, String), SubagentMeta>>,
    /// Items that have already emitted a streaming delta. Hosts are allowed
    /// to send a complete `item/updated` or `item/completed` without any
    /// delta (for example after a reconnect); the completed-item fallback
    /// uses this set to avoid duplicating text that already streamed.
    item_deltas_seen: Mutex<HashSet<(String, String)>>,
    /// Completed-item fallback emissions are idempotent across repeated
    /// `item/updated` notifications. Scoped by session and item identity.
    item_fallback_emitted: Mutex<HashSet<(String, String)>>,
    /// Serializes host creation: check-spawn-insert must be atomic or two
    /// concurrent `start_session` calls spawn two hosts.
    host_mutex: tokio::sync::Mutex<()>,
    event_seq: Mutex<u64>,
    event_buffer: Mutex<std::collections::VecDeque<DrainedEvent>>,
    terminals: terminal::TerminalRegistry,
    /// In-flight worktree setup cancellation flags, keyed by session and
    /// renderer operation id. The command owns the child process lifetime;
    /// the UI only requests cancellation through this registry.
    setup_cancellations: Mutex<HashMap<(String, String), Arc<AtomicBool>>>,
    /// Persistent local MCP servers, keyed by the frontend connector id.
    /// Each entry owns its child process and is removed explicitly or on app
    /// exit; calls are serialized by this mutex to keep stdio single-flight.
    mcp_servers: Arc<Mutex<HashMap<String, mcp::PersistentServer>>>,
    /// One native watcher per Files panel/session. Dropping a registration
    /// stops callbacks immediately; the renderer still owns refresh policy.
    workspace_watchers: Mutex<HashMap<String, workspace_watch::WorkspaceWatcher>>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeSessionResult {
    pub worktree: git::GitWorktreeResult,
    pub session: SessionMeta,
}

/// Native side of the bounded diagnostics export. It contains operational
/// counters only; workspace paths, prompts and transcript payloads stay out
/// of this contract.
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct NativeDiagnosticsSnapshot {
    pub schema: String,
    pub workspace_configured: bool,
    pub host_count: usize,
    pub session_count: usize,
    pub running_session_count: usize,
    pub pending_approval_count: usize,
    pub event_buffer_count: usize,
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
    let mut out = input.replace("Bearer ", "Bearer [redacted]");
    out = out.replace("bearer ", "bearer [redacted]");
    out = out.replace("BEARER ", "BEARER [redacted]");
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

const NATIVE_BROWSER_LABEL: &str = "muse-browser";
const MAX_BROWSER_URL_CHARS: usize = 4096;

/// Normalize and validate a URL before it is handed to a native webview.
/// The renderer performs the same normalization for its preview, but this
/// boundary must also protect direct or stale IPC callers.
fn validate_native_browser_url(raw: &str) -> Result<Url, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("browser URL must not be empty".to_string());
    }
    if trimmed.chars().count() > MAX_BROWSER_URL_CHARS {
        return Err(format!(
            "browser URL is limited to {MAX_BROWSER_URL_CHARS} characters"
        ));
    }
    let candidate = if trimmed.contains("://") {
        trimmed.to_string()
    } else {
        format!("https://{trimmed}")
    };
    let url = candidate
        .parse::<Url>()
        .map_err(|_| "browser URL is not valid".to_string())?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("only http and https URLs can open in the native browser".to_string());
    }
    if url.host_str().is_none() {
        return Err("browser URL must include a host".to_string());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("browser URLs with embedded credentials are not allowed".to_string());
    }
    Ok(url)
}

/// Open a verified URL in one dedicated native webview window. Reusing the
/// label keeps the browser surface single-instance and predictable.
#[tauri::command]
async fn open_native_browser(app: AppHandle, url: String) -> Result<String, String> {
    let parsed = validate_native_browser_url(&url)?;
    if let Some(window) = app.get_webview_window(NATIVE_BROWSER_LABEL) {
        window
            .navigate(parsed)
            .map_err(|e| format!("could not navigate native browser: {e}"))?;
        window
            .show()
            .map_err(|e| format!("could not show native browser: {e}"))?;
        window
            .set_focus()
            .map_err(|e| format!("could not focus native browser: {e}"))?;
        return Ok("reused".to_string());
    }
    WebviewWindowBuilder::new(
        &app,
        NATIVE_BROWSER_LABEL,
        WebviewUrl::External(parsed),
    )
    .title("Muse Browser")
    .inner_size(1180.0, 800.0)
    .min_inner_size(720.0, 480.0)
    .build()
    .map_err(|e| format!("could not open native browser: {e}"))?;
    Ok("opened".to_string())
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
    push_event(&state, session_id, kind, payload);
}

/// Extract the bounded, transcript-visible text from a complete MSP item.
/// `item/delta` is the normal path, but a reconnect or a host that coalesces
/// its stream may deliver only the full item. Keep this helper conservative:
/// it reads only the fields owned by the item's kind and never serializes the
/// raw item into the user transcript.
fn completed_item_text(item: &Value, kind: &str) -> Option<String> {
    let text = |key: &str| {
        item.get(key)
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
    };
    if is_thinking_item_kind(kind) {
        if let Some(summary) = item.get("summary").and_then(Value::as_array) {
            let joined = summary
                .iter()
                .filter_map(Value::as_str)
                .filter(|part| !part.is_empty())
                .collect::<Vec<_>>()
                .join("\n\n");
            if !joined.is_empty() {
                return Some(joined);
            }
        }
        return text("text").or_else(|| text("fallbackText"));
    }
    if kind.eq_ignore_ascii_case("usershell") {
        return text("visibleOutput")
            .or_else(|| text("message"))
            .or_else(|| text("fallbackText"));
    }
    if kind.eq_ignore_ascii_case("agentMessage") {
        return text("text")
            .or_else(|| text("displayText"))
            .or_else(|| text("message"))
            .or_else(|| text("fallbackText"));
    }
    None
}

fn initialize_session_durability(result: &Value) -> Option<String> {
    result
        .get("sessionDurability")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn cache_initialize_session_durability(
    host_durability: &mut HashMap<PathBuf, String>,
    root: &Path,
    result: &Value,
) {
    if let Some(durability) = initialize_session_durability(result) {
        host_durability.insert(root.to_path_buf(), durability);
    } else {
        // A successful handshake without the optional field is an explicit
        // compatibility result. Do not let a previous host's fact leak into
        // a newly started host for the same workspace.
        host_durability.remove(root);
    }
}

/// Read the fixed capability grant returned by `initialize`. Unknown
/// additive names are retained for diagnostics, while malformed entries are
/// ignored; an explicitly empty array remains an explicit denial of all
/// optional capabilities for this connection.
fn initialize_granted_capabilities(result: &Value) -> Option<Vec<String>> {
    result
        .get("grantedCapabilities")
        .and_then(Value::as_array)
        .map(|entries| {
            entries
                .iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|name| !name.is_empty())
                .map(str::to_string)
                .take(64)
                .collect()
        })
}

fn cache_initialize_granted_capabilities(
    host_capabilities: &mut HashMap<PathBuf, Vec<String>>,
    root: &Path,
    result: &Value,
) {
    if let Some(capabilities) = initialize_granted_capabilities(result) {
        host_capabilities.insert(root.to_path_buf(), capabilities);
    } else {
        // Never leak a previous host's capability posture into a new process.
        host_capabilities.remove(root);
    }
}

fn session_granted_capabilities(
    state: &State<'_, AppState>,
    root: &Path,
) -> Result<Option<Vec<String>>, String> {
    Ok(state
        .host_capabilities
        .lock()
        .map_err(|e| format!("state lock: {e}"))?
        .get(root)
        .cloned())
}

/// Read the host's effective approval projection from any session-shaped
/// response. Older hosts omit it, so absence remains `None` and the renderer
/// keeps its compatibility path instead of inventing a posture.
fn session_approval_mode(session: &Value) -> Option<String> {
    session
        .get("approvalMode")
        .or_else(|| session.get("approval_mode"))
        .and_then(|mode| mode.get("mode").or(Some(mode)))
        .and_then(Value::as_str)
        .filter(|mode| !mode.trim().is_empty())
        .map(str::to_string)
}

fn is_approval_mode_ceiling(error: &str) -> bool {
    error.contains("approval_mode_ceiling") || error.contains("approval mode ceiling")
}

fn push_event(state: &AppState, session_id: &str, kind: &str, payload: String) {
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

fn mark_running(state: &AppState, session_id: &str, running: bool) {
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
    let shared: SharedChild = std::sync::Arc::new(tokio::sync::Mutex::new(Some(Box::new(child))));
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
                json!({
                    "clientInfo": {"name": "muse_desktop", "version": "0.1.0"},
                    "capabilities": {"requestedCapabilities": ["userShell"]},
                }),
            )
            .await?;
        validate_initialize_result(&initialized)?;
        client.notify("initialized", Value::Null).await?;
        Ok::<Value, String>(initialized)
    };
    let initialized = match handshake.await {
        Ok(value) => value,
        Err(e) => {
            state.hosts.lock().map_err(|e| format!("state lock: {e}"))?.remove(&client);
            client.shutdown().await;
            return Err(format!(
                "MSP handshake failed ({e}). Host stderr: {}",
                tail_of(&stderr_tail)
            ));
        }
    };

    // Keep the initialize capability beside the workspace-owned client. It
    // is intentionally advisory: unknown/missing values preserve the legacy
    // reconnect path, while an explicit `ephemeral` value is enforced by the
    // resume command and exposed to the renderer.
    let mut host_durability = state
        .host_durability
        .lock()
        .map_err(|e| format!("state lock: {e}"))?;
    cache_initialize_session_durability(&mut host_durability, &root, &initialized);

    let mut host_capabilities = state
        .host_capabilities
        .lock()
        .map_err(|e| format!("state lock: {e}"))?;
    cache_initialize_granted_capabilities(&mut host_capabilities, &root, &initialized);

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

/// Decode one or more stdout chunks and feed complete MSP frames into the
/// owning client. Keeping the framing boundary separate from the Tauri event
/// receiver makes the exact production parser testable with a deterministic
/// child while preserving the same partial-line behavior in the pump.
async fn ingest_stdout_chunk(
    client: &MspClient,
    out_buf: &mut Vec<u8>,
    stderr_tail: &std::sync::Arc<Mutex<Vec<String>>>,
    chunk: &[u8],
) {
    for line in split_lines(out_buf, chunk) {
        match serde_json::from_str::<Value>(&line) {
            Ok(frame) => client.ingest(frame).await,
            Err(_) => push_stderr(stderr_tail, format!("unparsable frame: {line}")),
        }
    }
}

/// Result of draining the shell event stream. A closed receiver is treated as
/// a host loss as well: the shell plugin can close stdout without delivering a
/// `Terminated` event when the process disappears during teardown.
#[derive(Debug, Clone)]
enum PumpExit {
    Terminated(TerminatedPayload),
    ChannelClosed,
}

/// Consume the production shell events without depending on an `AppHandle`.
/// Keeping this boundary separate lets tests exercise the actual receiver,
/// chunking and shutdown behavior with a deterministic child client.
async fn consume_command_events(
    mut rx: tauri::async_runtime::Receiver<CommandEvent>,
    client: std::sync::Arc<MspClient>,
    stderr_tail: std::sync::Arc<Mutex<Vec<String>>>,
) -> PumpExit {
    let mut out_buf = Vec::new();
    let mut err_buf = Vec::new();
    while let Some(ev) = rx.recv().await {
        match ev {
            CommandEvent::Stdout(chunk) => {
                ingest_stdout_chunk(&client, &mut out_buf, &stderr_tail, &chunk).await;
            }
            CommandEvent::Stderr(chunk) => {
                for line in split_lines(&mut err_buf, &chunk) {
                    push_stderr(&stderr_tail, line);
                }
            }
            CommandEvent::Error(message) => {
                push_stderr(&stderr_tail, format!("shell command error: {message}"));
            }
            CommandEvent::Terminated(payload) => {
                flush_command_buffers(&client, &mut out_buf, &mut err_buf, &stderr_tail).await;
                client.shutdown().await;
                return PumpExit::Terminated(payload);
            }
            _ => {}
        }
    }
    flush_command_buffers(&client, &mut out_buf, &mut err_buf, &stderr_tail).await;
    client.shutdown().await;
    PumpExit::ChannelClosed
}

/// Drain the final unterminated stdout/stderr fragments before the host is
/// torn down. The shell normally emits newline-delimited chunks, but a process
/// can disappear between its last write and the line delimiter. Treating that
/// fragment as one final line preserves a complete JSON response and keeps an
/// incomplete one in the bounded diagnostics tail instead of leaving callers
/// waiting for the request timeout.
async fn flush_command_buffers(
    client: &MspClient,
    out_buf: &mut Vec<u8>,
    err_buf: &mut Vec<u8>,
    stderr_tail: &std::sync::Arc<Mutex<Vec<String>>>,
) {
    if !out_buf.is_empty() {
        ingest_stdout_chunk(client, out_buf, stderr_tail, b"\n").await;
    }
    for line in split_lines(err_buf, b"\n") {
        push_stderr(stderr_tail, line);
    }
}

/// Forward the host's stdout frames into the MSP client; stash stderr for
/// diagnostics; announce host death only to sessions owned by this client.
fn pump_stdout(
    app: AppHandle,
    rx: tauri::async_runtime::Receiver<CommandEvent>,
    client: std::sync::Arc<MspClient>,
    stderr_tail: std::sync::Arc<Mutex<Vec<String>>>,
) {
    tauri::async_runtime::spawn(async move {
        let exit = consume_command_events(rx, client.clone(), stderr_tail.clone()).await;
        let state: State<AppState> = app.state();
        let ids = state.hosts.lock().map(|mut hosts| hosts.remove(&client)).unwrap_or_default();
        let why = match exit {
            PumpExit::Terminated(payload) => format!(
                "sidecar host exited (code {:?}, signal {:?}). {}",
                payload.code,
                payload.signal,
                tail_of(&stderr_tail)
            ),
            PumpExit::ChannelClosed => format!(
                "sidecar event stream closed unexpectedly. {}",
                tail_of(&stderr_tail)
            ),
        };
        for sid in ids {
            mark_running(&state, &sid, false);
            emit(&app, "status", &sid, "host_exited", why.clone());
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

fn route_notification_with_emit<F>(state: &AppState, method: &str, p: &Value, mut emit_fn: F)
where
    F: FnMut(&str, &str, &str, String),
{
    let sid = p.get("sessionId").and_then(Value::as_str).unwrap_or("");
    match method {
        "item/started" => {
            // The official MSP envelope keeps the identity on the full item
            // object. Accept the earlier flat shape as a compatibility path
            // because older sidecars emitted `itemId` beside `item`.
            let item_id = p
                .get("itemId")
                .and_then(Value::as_str)
                .or_else(|| {
                    p.get("item")
                        .and_then(|item| item.get("itemId").or_else(|| item.get("id")))
                        .and_then(Value::as_str)
                });
            if let (Some(item_id), Some(item)) = (item_id, p.get("item")) {
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
                    emit_fn("subagent_event",
                        sid,
                        "subagent_event",
                        Value::Object(announce).to_string(),
                    );
                }
                // US-10: surface the item start so the UI paints the
                // reflexive phase before the first delta lands (even when
                // no delta ever follows for this item).
                emit_fn("status",
                    sid,
                    "item_started",
                    json!({
                        "itemId": item_id,
                        "itemKind": kind,
                        "commandText": item.get("commandText"),
                        "turnId": item.get("turnId"),
                    }).to_string(),
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
            if let Ok(mut seen) = state.item_deltas_seen.lock() {
                seen.insert((sid.to_string(), item_id.to_string()));
            }
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
                    emit_fn("subagent_event",
                        sid,
                        "subagent_event",
                        Value::Object(obj).to_string(),
                    );
                }
                kind if is_thinking_item_kind(kind) => {
                    // Keep reasoning deltas separate from the answer lane so
                    // the UI can expose them behind a disclosure control.
                    emit_fn("thinking", sid, "thinking", item_ref);
                }
                "userShell" | "usershell" => {
                    // User-shell output is a tool lane item and never an
                    // assistant response. Keep the command/result pairing in
                    // the transcript without copying raw host frames.
                    emit_fn("shell_output", sid, "shell_output", item_ref);
                }
                _ => emit_fn("output", sid, "output", item_ref),
            }
        }
        "item/completed" | "item/updated" => {
            // Carries the item id: the UI closes only this block, so a
            // concurrent item keeps streaming into its own entry. A complete
            // item can also be the first event observed after a reconnect;
            // emit its transcript lane once when no delta was seen.
            let item = p.get("item");
            let item_id = item
                .and_then(|i| i.get("itemId").or_else(|| i.get("id")))
                .and_then(Value::as_str)
                .or_else(|| p.get("itemId").and_then(Value::as_str))
                .unwrap_or("");
            let turn_id = item
                .and_then(|i| i.get("turnId"))
                .or_else(|| p.get("turnId"));
            let kind = item
                .and_then(|i| i.get("kind"))
                .and_then(Value::as_str)
                .map(str::to_string)
                .or_else(|| {
                    state
                        .item_kinds
                        .lock()
                        .ok()
                        .and_then(|kinds| kinds.get(&(sid.to_string(), item_id.to_string())).cloned())
                });
            if !item_id.is_empty() {
                if let Some(kind) = kind.as_deref() {
                    if let Ok(mut kinds) = state.item_kinds.lock() {
                        kinds.insert((sid.to_string(), item_id.to_string()), kind.to_string());
                    }
                    let delta_seen = state
                        .item_deltas_seen
                        .lock()
                        .map(|seen| seen.contains(&(sid.to_string(), item_id.to_string())))
                        .unwrap_or(true);
                    let already_emitted = state
                        .item_fallback_emitted
                        .lock()
                        .map(|seen| seen.contains(&(sid.to_string(), item_id.to_string())))
                        .unwrap_or(true);
                    if !delta_seen && !already_emitted {
                        // If the start event was lost, recreate the reflexive
                        // block before appending the completed text. The
                        // renderer de-duplicates this by itemId.
                        emit_fn(
                            "status",
                            sid,
                            "item_started",
                            json!({
                                "itemId": item_id,
                                "itemKind": kind,
                                "commandText": item.and_then(|i| i.get("commandText")),
                                "turnId": turn_id,
                            })
                            .to_string(),
                        );
                        let fallback_text = item.and_then(|i| completed_item_text(i, kind));
                        let has_fallback_text = fallback_text.is_some();
                        if let Some(text) = fallback_text {
                            let lane = if is_thinking_item_kind(kind) {
                                "thinking"
                            } else if kind.eq_ignore_ascii_case("usershell") {
                                "shell_output"
                            } else {
                                "output"
                            };
                            emit_fn(
                                lane,
                                sid,
                                lane,
                                json!({"itemId": item_id, "text": text}).to_string(),
                            );
                        }
                        // A metadata-only update may precede the terminal
                        // item carrying output. Keep it eligible for that
                        // later completed event; once text was emitted, both
                        // update and completed notifications are idempotent.
                        if has_fallback_text || method == "item/completed" {
                            if let Ok(mut emitted) = state.item_fallback_emitted.lock() {
                                emitted.insert((sid.to_string(), item_id.to_string()));
                            }
                        }
                    }
                }
            }
            emit_fn(
                "status",
                sid,
                "item_done",
                json!({"itemId": item_id, "turnId": turn_id}).to_string(),
            );
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
            emit_fn("tool_request",
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
                // A terminal resolution without a decision is still useful
                // for retiring the card, but it must never be interpreted as
                // permission to resume. The renderer's parser fails closed
                // for this explicit sentinel.
                .unwrap_or("unknown");
            emit_fn("status",
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
        "turn/started" => emit_fn("status",
            sid,
            "started",
            json!({
                "turnId": p.get("turnId"),
                "commandId": p.get("commandId"),
            })
            .to_string(),
        ),
        "turn/completed" => {
            let terminal = p.get("terminal").and_then(Value::as_str).unwrap_or("completed");
            mark_running(state, sid, false);
            // A failed turn is a terminal view event, so preserve the stable
            // error object instead of flattening it into a message string.
            // Older hosts may omit fields; nulls keep the envelope additive
            // and let the renderer fall back to the legacy reason.
            emit_fn("status",
                sid,
                terminal,
                json!({
                    "terminal": terminal,
                    "turnId": p.get("turnId"),
                    "reason": p.get("reason"),
                    "error": p.get("error"),
                    "durationMs": p.get("durationMs"),
                })
                .to_string(),
            );
        }
        "turn/retracted" => {
            // Retraction is the host's terminal confirmation for an accepted
            // interrupt. Keep the product status stable (`cancelled`) and
            // retain the turn anchor so the renderer closes only this turn.
            mark_running(state, sid, false);
            emit_fn(
                "status",
                sid,
                "cancelled",
                json!({
                    "terminal": "cancelled",
                    "turnId": p.get("turnId"),
                    "reason": p.get("reason"),
                })
                .to_string(),
            );
        }
        "turn/unqueued" | "turn/retryScheduled" => {
            emit_fn("status", sid, method, p.to_string())
        }
        "userInput/requested" => {
            // The turn suspends until answered: surface as an answerable
            // panel, never a bare log line (a log line leaves the chat
            // hanging with no way to reply).
            match build_input_request_payload(p) {
                Some(payload) => emit_fn("input_request", sid, "input_request", payload.to_string()),
                None => emit_fn("status", sid, "input_requested", "input requested (unparseable)".to_string()),
            }
        }
        "userInput/settled" => {
            let outcome = p.get("outcome").and_then(Value::as_str).unwrap_or("settled");
            let input_id = p.get("userInputId").and_then(Value::as_str).unwrap_or("");
            emit_fn("input_settled",
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
                emit_fn("status",
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
                emit_fn("context_usage", sid, "context_usage", usage.to_string());
            }
        }
        // US-31/M1-11: preserve the host's token counters verbatim. The
        // renderer displays these projections but never recomputes totals.
        "session/tokenUsage" => {
            if !sid.is_empty() {
                emit_fn("token_usage", sid, "token_usage", p.to_string());
            }
        }
        _ => {}
    }
}

fn route_notification(app: &AppHandle, state: &State<AppState>, method: &str, p: &Value) {
    route_notification_with_emit(state.inner(), method, p, |event, sid, kind, payload| {
        emit(app, event, sid, kind, payload);
    });
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

/// Stage selected repository-relative files after checking the status and
/// optional diff snapshot observed by the Review panel.
#[tauri::command]
async fn git_stage(
    state: State<'_, AppState>,
    session_id: String,
    paths: Vec<String>,
    expected_head: Option<String>,
    expected_status: Option<String>,
    expected_patch: Option<String>,
) -> Result<git::GitStatusSnapshot, String> {
    let root = workspace_for_inspection(&state, &session_id)?;
    tokio::task::spawn_blocking(move || {
        git::stage(&root, &paths, expected_head, expected_status, expected_patch)
    })
    .await
    .map_err(|e| format!("git stage task failed: {e}"))?
}

/// Restore selected files from the index (`staged`) or worktree (`unstaged`).
/// The backend refuses untracked deletion and stale observations.
#[tauri::command]
async fn git_restore(
    state: State<'_, AppState>,
    session_id: String,
    paths: Vec<String>,
    scope: String,
    expected_head: Option<String>,
    expected_status: Option<String>,
    expected_patch: Option<String>,
) -> Result<git::GitStatusSnapshot, String> {
    let root = workspace_for_inspection(&state, &session_id)?;
    tokio::task::spawn_blocking(move || {
        git::restore(
            &root,
            &paths,
            &scope,
            expected_head,
            expected_status,
            expected_patch,
        )
    })
    .await
    .map_err(|e| format!("git restore task failed: {e}"))?
}

/// Return native supervisor counters for the explicit local diagnostics
/// export. Every field is a bounded count and every lock failure is visible to
/// the caller instead of producing a partial, misleading snapshot.
#[tauri::command]
fn collect_diagnostics(state: State<'_, AppState>) -> Result<NativeDiagnosticsSnapshot, String> {
    let workspace_configured = state
        .workspace
        .lock()
        .map_err(|e| format!("workspace diagnostics lock: {e}"))?
        .is_some();
    let (host_count, host_session_count) = {
        let hosts = state
            .hosts
            .lock()
            .map_err(|e| format!("host diagnostics lock: {e}"))?;
        (hosts.client_count(), hosts.session_count())
    };
    let (session_count, running_session_count) = {
        let sessions = state
            .sessions
            .lock()
            .map_err(|e| format!("session diagnostics lock: {e}"))?;
        (
            sessions.len(),
            sessions.values().filter(|meta| meta.running).count(),
        )
    };
    let pending_approval_count = state
        .approvals
        .lock()
        .map_err(|e| format!("approval diagnostics lock: {e}"))?
        .len();
    let event_buffer_count = state
        .event_buffer
        .lock()
        .map_err(|e| format!("event diagnostics lock: {e}"))?
        .len();
    Ok(NativeDiagnosticsSnapshot {
        schema: "muse-desktop.native-diagnostics.v1".to_string(),
        workspace_configured,
        host_count,
        session_count: session_count.max(host_session_count),
        running_session_count,
        pending_approval_count,
        event_buffer_count,
    })
}

/// Apply one selected hunk after checking the exact Review observation.
/// Stage/unstage/discard are restricted to the matching diff scope.
#[tauri::command]
async fn git_apply_hunk(
    state: State<'_, AppState>,
    session_id: String,
    path: String,
    scope: String,
    action: String,
    hunk_header: String,
    expected_head: Option<String>,
    expected_status: Option<String>,
    expected_patch: Option<String>,
) -> Result<git::GitStatusSnapshot, String> {
    let root = workspace_for_inspection(&state, &session_id)?;
    tokio::task::spawn_blocking(move || {
        git::apply_hunk(
            &root,
            &path,
            &scope,
            &action,
            &hunk_header,
            expected_head,
            expected_status,
            expected_patch,
        )
    })
    .await
    .map_err(|e| format!("git hunk action failed: {e}"))?
}

/// Commit the staged index after checking the Review observation.
#[tauri::command]
async fn git_commit(
    state: State<'_, AppState>,
    session_id: String,
    message: String,
    expected_head: Option<String>,
    expected_status: Option<String>,
    expected_patch: Option<String>,
) -> Result<git::GitCommitResult, String> {
    let root = workspace_for_inspection(&state, &session_id)?;
    tokio::task::spawn_blocking(move || {
        git::commit(
            &root,
            &message,
            expected_head,
            expected_status,
            expected_patch,
        )
    })
    .await
    .map_err(|e| format!("git commit task failed: {e}"))?
}

/// Push an explicit remote/branch refspec after checking the observed HEAD.
#[tauri::command]
async fn git_push(
    state: State<'_, AppState>,
    session_id: String,
    remote: String,
    branch: String,
    expected_head: Option<String>,
) -> Result<git::GitPushResult, String> {
    let root = workspace_for_inspection(&state, &session_id)?;
    tokio::task::spawn_blocking(move || git::push(&root, &remote, &branch, expected_head))
        .await
        .map_err(|e| format!("git push task failed: {e}"))?
}

/// Create a GitHub pull request through the user's existing `gh` auth. Merge
/// is intentionally outside this command.
#[tauri::command]
async fn git_create_pr(
    state: State<'_, AppState>,
    session_id: String,
    title: String,
    body: String,
    base: String,
    head: String,
) -> Result<git::GitPrResult, String> {
    let root = workspace_for_inspection(&state, &session_id)?;
    tokio::task::spawn_blocking(move || git::create_pr(&root, &title, &body, &base, &head))
        .await
        .map_err(|e| format!("pull request task failed: {e}"))?
}

/// Create a real Git worktree below the conversation workspace. The caller
/// supplies an explicit branch, base ref and relative `.muse/worktrees/` path;
/// the Git service validates all three before running off the UI thread.
#[tauri::command]
async fn git_worktree_create(
    state: State<'_, AppState>,
    session_id: String,
    branch: String,
    relative_path: String,
    base_ref: String,
) -> Result<git::GitWorktreeResult, String> {
    let root = workspace_for_inspection(&state, &session_id)?;
    tokio::task::spawn_blocking(move || {
        git::create_worktree(&root, &branch, &relative_path, &base_ref)
    })
    .await
    .map_err(|e| format!("worktree create task failed: {e}"))?
}

/// Remove a managed worktree after the user confirms the destructive action.
#[tauri::command]
async fn git_worktree_remove(
    state: State<'_, AppState>,
    session_id: String,
    path: String,
) -> Result<(), String> {
    let root = workspace_for_inspection(&state, &session_id)?;
    tokio::task::spawn_blocking(move || git::remove_worktree(&root, &path))
        .await
        .map_err(|e| format!("worktree remove task failed: {e}"))?
}

/// Inspect a managed worktree before cleanup or a handoff decision.
#[tauri::command]
async fn git_worktree_inspect(
    state: State<'_, AppState>,
    session_id: String,
    path: String,
) -> Result<git::GitWorktreeInspection, String> {
    let root = workspace_for_inspection(&state, &session_id)?;
    tokio::task::spawn_blocking(move || git::inspect_worktree(&root, &path))
        .await
        .map_err(|e| format!("worktree inspect task failed: {e}"))?
}

/// Run an explicitly requested setup command in a managed worktree. The
/// command is bounded and never started by project import or app startup.
#[tauri::command]
async fn worktree_setup_run(
    state: State<'_, AppState>,
    session_id: String,
    path: String,
    command: String,
    operation_id: String,
    env_allowlist: Vec<String>,
) -> Result<setup::SetupResult, String> {
    let root = workspace_for_inspection(&state, &session_id)?;
    let key = (session_id, operation_id);
    let cancel = Arc::new(AtomicBool::new(false));
    state
        .setup_cancellations
        .lock()
        .map_err(|_| "setup cancellation registry is unavailable".to_string())?
        .insert(key.clone(), cancel.clone());
    let joined = tokio::task::spawn_blocking(move || {
        setup::run_with_cancel_and_env(&root, &path, &command, &env_allowlist, Some(cancel))
    })
    .await;
    if let Ok(mut active) = state.setup_cancellations.lock() {
        active.remove(&key);
    }
    joined.map_err(|e| format!("worktree setup task failed: {e}"))?
}

/// Create a managed worktree and start its conversation as one guarded
/// operation. If session admission fails, remove the newly-created checkout
/// before returning the error so the UI never advertises a half-created lane.
#[tauri::command]
async fn git_worktree_create_session(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    branch: String,
    relative_path: String,
    base_ref: String,
    authorization_mode: Option<String>,
) -> Result<WorktreeSessionResult, String> {
    let root = workspace_for_inspection(&state, &session_id)?;
    let created = tokio::task::spawn_blocking({
        let root = root.clone();
        let branch = branch.clone();
        let relative_path = relative_path.clone();
        let base_ref = base_ref.clone();
        move || git::create_worktree(&root, &branch, &relative_path, &base_ref)
    })
    .await
    .map_err(|e| format!("git worktree create task failed: {e}"))??;
    let child_root = PathBuf::from(&created.path);
    match start_session_at_workspace(app, state, child_root, authorization_mode).await {
        Ok(session) => Ok(WorktreeSessionResult {
            worktree: created,
            session,
        }),
        Err(error) => {
            let cleanup_path = created.path.clone();
            let cleanup = tokio::task::spawn_blocking(move || git::remove_worktree(&root, &cleanup_path)).await;
            let detail = match cleanup {
                Ok(Ok(())) => error,
                Ok(Err(cleanup_error)) => format!("{error}; worktree cleanup failed: {cleanup_error}"),
                Err(join_error) => format!("{error}; worktree cleanup task failed: {join_error}"),
            };
            Err(format!("could not open conversation in worktree: {detail}"))
        }
    }
}

/// Inspect a managed worktree and its locally available project tools without
/// executing project code. This gives the UI a conservative pre-flight state
/// before a user chooses to run setup.
#[tauri::command]
async fn worktree_setup_readiness(
    state: State<'_, AppState>,
    session_id: String,
    path: String,
) -> Result<setup::ReadinessResult, String> {
    let root = workspace_for_inspection(&state, &session_id)?;
    tokio::task::spawn_blocking(move || setup::readiness(&root, &path))
        .await
        .map_err(|e| format!("worktree readiness task failed: {e}"))?
}

/// Request cancellation of one running setup command. The process is killed
/// by the setup worker, so this call stays non-blocking for the renderer.
#[tauri::command]
fn worktree_setup_cancel(
    state: State<'_, AppState>,
    session_id: String,
    operation_id: String,
) -> Result<bool, String> {
    let active = state
        .setup_cancellations
        .lock()
        .map_err(|_| "setup cancellation registry is unavailable".to_string())?;
    if let Some(flag) = active.get(&(session_id, operation_id)) {
        flag.store(true, Ordering::Relaxed);
        Ok(true)
    } else {
        Ok(false)
    }
}

/// Probe an explicitly configured local MCP server with initialize + tools/list.
#[tauri::command]
async fn mcp_local_probe(
    command: String,
    workspace: Option<String>,
) -> Result<mcp::ProbeResult, String> {
    let workspace = workspace.map(PathBuf::from);
    tokio::task::spawn_blocking(move || mcp::probe(&command, workspace.as_deref()))
        .await
        .map_err(|e| format!("MCP probe task failed: {e}"))?
}

/// Call one tool on an explicitly configured local MCP server.
#[tauri::command]
async fn mcp_local_call(
    command: String,
    workspace: Option<String>,
    tool_name: String,
    arguments: Value,
) -> Result<mcp::CallResult, String> {
    let workspace = workspace.map(PathBuf::from);
    tokio::task::spawn_blocking(move || {
        mcp::call(&command, workspace.as_deref(), &tool_name, arguments)
    })
    .await
    .map_err(|e| format!("MCP call task failed: {e}"))?
}

/// Discover bounded, read-only SKILL.md documents in a selected workspace.
#[tauri::command]
async fn skills_scan(
    state: State<'_, AppState>,
    workspace: Option<String>,
) -> Result<skills::SkillScanResult, String> {
    let root = match workspace.map(|path| PathBuf::from(path.trim())).filter(|path| !path.as_os_str().is_empty()) {
        Some(path) => path,
        None => state
            .workspace
            .lock()
            .map_err(|e| format!("workspace state lock: {e}"))?
            .clone()
            .ok_or_else(|| "select a workspace before scanning skills".to_string())?,
    };
    tokio::task::spawn_blocking(move || skills::scan(&root))
        .await
        .map_err(|e| format!("skills scan task failed: {e}"))?
}

/// Start (or replace) a persistent MCP stdio server for one configured
/// connector. The command is still supplied by the persisted local registry;
/// no server is started during app boot.
#[tauri::command]
async fn mcp_local_start(
    state: State<'_, AppState>,
    connector_id: String,
    command: String,
    workspace: Option<String>,
) -> Result<mcp::ProbeResult, String> {
    let connector_id = connector_id.trim().to_string();
    if connector_id.is_empty() {
        return Err("MCP connector id must not be empty".to_string());
    }
    let workspace = workspace.map(PathBuf::from);
    let servers = Arc::clone(&state.mcp_servers);
    tokio::task::spawn_blocking(move || {
        let (server, result) = mcp::PersistentServer::start(&command, workspace.as_deref())?;
        let mut registry = servers
            .lock()
            .map_err(|_| "MCP server registry is unavailable".to_string())?;
        registry.insert(connector_id, server);
        Ok(result)
    })
    .await
    .map_err(|e| format!("MCP start task failed: {e}"))?
}

/// Refresh tools on a persistent MCP server. If the app has no live process
/// for the id (for example after a relaunch), start it from the persisted
/// command and perform the same initial tools/list exchange.
#[tauri::command]
async fn mcp_local_refresh(
    state: State<'_, AppState>,
    connector_id: String,
    command: String,
    workspace: Option<String>,
) -> Result<mcp::ProbeResult, String> {
    let connector_id = connector_id.trim().to_string();
    if connector_id.is_empty() {
        return Err("MCP connector id must not be empty".to_string());
    }
    let workspace = workspace.map(PathBuf::from);
    let servers = Arc::clone(&state.mcp_servers);
    tokio::task::spawn_blocking(move || {
        let mut registry = servers
            .lock()
            .map_err(|_| "MCP server registry is unavailable".to_string())?;
        if let Some(server) = registry.get_mut(&connector_id) {
            let result = server.refresh();
            if result.is_err() {
                // A broken stdout/transport cannot be recovered by reusing
                // the same child. Remove it so the next explicit refresh
                // starts a clean process.
                registry.remove(&connector_id);
            }
            return result;
        }
        let (server, result) = mcp::PersistentServer::start(&command, workspace.as_deref())?;
        registry.insert(connector_id, server);
        Ok(result)
    })
    .await
    .map_err(|e| format!("MCP refresh task failed: {e}"))?
}

/// Observe notifications emitted by a running MCP server. A
/// `tools/list_changed` notification triggers one bounded tools/list refresh;
/// otherwise the command returns immediately without touching the process.
#[tauri::command]
async fn mcp_local_poll(
    state: State<'_, AppState>,
    connector_id: String,
) -> Result<Option<mcp::ProbeResult>, String> {
    let connector_id = connector_id.trim().to_string();
    if connector_id.is_empty() {
        return Err("MCP connector id must not be empty".to_string());
    }
    let servers = Arc::clone(&state.mcp_servers);
    tokio::task::spawn_blocking(move || {
        let mut registry = servers
            .lock()
            .map_err(|_| "MCP server registry is unavailable".to_string())?;
        let server = match registry.get_mut(&connector_id) {
            Some(server) => server,
            None => return Ok(None),
        };
        if !server.take_tools_changed()? {
            return Ok(None);
        }
        let result = server.refresh();
        if result.is_err() {
            registry.remove(&connector_id);
        }
        result.map(Some)
    })
    .await
    .map_err(|e| format!("MCP poll task failed: {e}"))?
}

/// Call one tool on a running persistent MCP server. A missing id fails
/// explicitly so the UI can offer Start/Refresh instead of silently spawning
/// an unrelated short-lived process.
#[tauri::command]
async fn mcp_local_call_persistent(
    state: State<'_, AppState>,
    connector_id: String,
    tool_name: String,
    arguments: Value,
) -> Result<mcp::CallResult, String> {
    let connector_id = connector_id.trim().to_string();
    if connector_id.is_empty() {
        return Err("MCP connector id must not be empty".to_string());
    }
    let servers = Arc::clone(&state.mcp_servers);
    tokio::task::spawn_blocking(move || {
        let mut registry = servers
            .lock()
            .map_err(|_| "MCP server registry is unavailable".to_string())?;
        let result = {
            let server = registry
                .get_mut(&connector_id)
                .ok_or_else(|| "MCP connector is not running; start it first".to_string())?;
            server.call(&tool_name, arguments)
        };
        if result.is_err() {
            registry.remove(&connector_id);
        }
        result
    })
    .await
    .map_err(|e| format!("MCP persistent call task failed: {e}"))?
}

/// Stop one persistent MCP server. The child is killed by `Drop` when its
/// registry entry is removed.
#[tauri::command]
fn mcp_local_stop(state: State<'_, AppState>, connector_id: String) -> Result<bool, String> {
    let connector_id = connector_id.trim();
    if connector_id.is_empty() {
        return Err("MCP connector id must not be empty".to_string());
    }
    let mut registry = state
        .mcp_servers
        .lock()
        .map_err(|_| "MCP server registry is unavailable".to_string())?;
    Ok(registry.remove(connector_id).is_some())
}

/// Return the ids of currently running persistent MCP servers. This is a
/// diagnostic/status projection only; the frontend registry remains the SSOT
/// for connector metadata and tools.
#[tauri::command]
fn mcp_local_running(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    let registry = state
        .mcp_servers
        .lock()
        .map_err(|_| "MCP server registry is unavailable".to_string())?;
    Ok(registry.keys().cloned().collect())
}

/// Read a bounded set of relative resources for a discovered SKILL.md.
#[tauri::command]
async fn skills_read_resources(
    state: State<'_, AppState>,
    workspace: Option<String>,
    skill_path: String,
    resource_paths: Vec<String>,
) -> Result<skills::SkillResourcesResult, String> {
    let root = match workspace
        .map(|path| PathBuf::from(path.trim()))
        .filter(|path| !path.as_os_str().is_empty())
    {
        Some(path) => path,
        None => state
            .workspace
            .lock()
            .map_err(|e| format!("workspace state lock: {e}"))?
            .clone()
            .ok_or_else(|| "select a workspace before reading skill resources".to_string())?,
    };
    tokio::task::spawn_blocking(move || skills::read_resources(&root, &skill_path, &resource_paths))
        .await
        .map_err(|e| format!("skills resource task failed: {e}"))?
}

/// Open (or reuse) the persistent PTY owned by a conversation workspace.
#[tauri::command]
fn terminal_open(
    state: State<'_, AppState>,
    session_id: String,
    cols: Option<u16>,
    rows: Option<u16>,
) -> Result<terminal::TerminalInfo, String> {
    let root = workspace_for_inspection(&state, &session_id)?;
    state.terminals.open(&session_id, &root, cols, rows)
}

/// Write raw terminal input. The caller controls line endings so paste and
/// interactive key sequences (for example Ctrl-C) remain lossless.
#[tauri::command]
fn terminal_write(
    state: State<'_, AppState>,
    terminal_id: String,
    input: String,
) -> Result<(), String> {
    state.terminals.write(&terminal_id, &input)
}

/// Resize the PTY and return the clamped size used by the backend.
#[tauri::command]
fn terminal_resize(
    state: State<'_, AppState>,
    terminal_id: String,
    cols: u16,
    rows: u16,
) -> Result<terminal::TerminalInfo, String> {
    state.terminals.resize(&terminal_id, cols, rows)
}

/// Drain output accumulated since the previous read. Output is bounded in the
/// registry; an inactive panel therefore cannot cause unbounded memory use.
#[tauri::command]
fn terminal_read(
    state: State<'_, AppState>,
    terminal_id: String,
) -> Result<terminal::TerminalRead, String> {
    state.terminals.read(&terminal_id)
}

/// Explicitly close one PTY and its child process.
#[tauri::command]
fn terminal_close(state: State<'_, AppState>, terminal_id: String) -> Result<(), String> {
    state.terminals.close(&terminal_id)
}

/// List the real directory entries for a conversation workspace. The path is
/// relative to that session's canonical root; the Rust service rejects
/// traversal and symlink escapes before touching the filesystem.
#[tauri::command]
async fn files_list(
    state: State<'_, AppState>,
    session_id: String,
    relative_path: Option<String>,
    limit: Option<usize>,
) -> Result<files::FileListSnapshot, String> {
    let root = workspace_for_inspection(&state, &session_id)?;
    tokio::task::spawn_blocking(move || files::list(&root, relative_path, limit))
        .await
        .map_err(|e| format!("files list task failed: {e}"))?
}

/// Read a bounded UTF-8 preview of one real workspace file. Binary files are
/// identified and returned without content so the UI never displays garbage.
#[tauri::command]
async fn file_read(
    state: State<'_, AppState>,
    session_id: String,
    path: String,
    max_chars: Option<usize>,
) -> Result<files::FileReadResult, String> {
    let root = workspace_for_inspection(&state, &session_id)?;
    tokio::task::spawn_blocking(move || files::read(&root, &path, max_chars))
        .await
        .map_err(|e| format!("file read task failed: {e}"))?
}

/// Start an event-only watcher for the active conversation workspace. The
/// callback sends relative paths through the same bounded poll buffer as host
/// events; it never reads file contents or executes a process.
#[tauri::command]
fn files_watch(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
) -> Result<(), String> {
    let session_id = require_non_empty(&session_id, "sessionId")?;
    let root = workspace_for_inspection(&state, &session_id)?;
    let mut watchers = state
        .workspace_watchers
        .lock()
        .map_err(|e| format!("workspace watcher state lock: {e}"))?;
    if watchers.contains_key(&session_id) {
        return Ok(());
    }
    let callback_session = session_id.clone();
    let callback_app = app.clone();
    let watcher = workspace_watch::WorkspaceWatcher::start(&root, move |result| match result {
        Ok(change) => {
            let payload = serde_json::to_string(&change)
                .unwrap_or_else(|_| r#"{"kind":"changed","paths":[]}"#.to_string());
            emit(
                &callback_app,
                "workspace",
                &callback_session,
                "workspace_changed",
                payload,
            );
        }
        Err(error) => {
            emit(
                &callback_app,
                "workspace",
                &callback_session,
                "workspace_watch_error",
                error,
            );
        }
    })?;
    watchers.insert(session_id, watcher);
    Ok(())
}

/// Stop a watcher explicitly when the Files panel is unmounted.
#[tauri::command]
fn files_unwatch(state: State<'_, AppState>, session_id: String) -> Result<(), String> {
    let session_id = require_non_empty(&session_id, "sessionId")?;
    state
        .workspace_watchers
        .lock()
        .map_err(|e| format!("workspace watcher state lock: {e}"))?
        .remove(&session_id);
    Ok(())
}

/// Open a verified workspace entry with the user's default system handler.
/// The UI only sends a relative path from the active conversation; resolving
/// and canonicalizing it here prevents a stale or hostile renderer from
/// opening a path outside that conversation's workspace.
#[tauri::command]
#[allow(deprecated)]
async fn file_open(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    path: String,
) -> Result<(), String> {
    let root = workspace_for_inspection(&state, &session_id)?;
    let target = tokio::task::spawn_blocking(move || files::resolve_for_open(&root, &path))
        .await
        .map_err(|e| format!("file open validation task failed: {e}"))??;
    app.shell()
        .open(target.to_string_lossy().into_owned(), None)
        .map_err(|e| format!("could not open workspace path: {e}"))
}

/// Write one explicitly selected artifact to a local UTF-8 file. The save
/// destination comes from the platform dialog; the backend still validates it
/// and bounds the payload before writing.
#[tauri::command]
async fn artifact_export(path: String, content: String) -> Result<(), String> {
    let target = PathBuf::from(path.trim());
    tokio::task::spawn_blocking(move || artifact_export::write_text(&target, &content))
        .await
        .map_err(|e| format!("artifact export task failed: {e}"))?
}

/// Write an explicitly selected same-origin browser download after the
/// renderer has shown a native save dialog. The payload is bounded and
/// validated again here so a compromised page cannot write arbitrary bytes or
/// create a destination directory through the renderer.
#[tauri::command]
async fn browser_download_write(path: String, data: String) -> Result<(), String> {
    let target = PathBuf::from(path.trim());
    tokio::task::spawn_blocking(move || browser_download::write_base64(&target, &data))
        .await
        .map_err(|e| format!("browser download task failed: {e}"))?
}

/// Fetch an explicitly selected same-origin browser link in the native
/// runtime. The module validates both origins and returns bounded base64;
/// cookies, credentials and redirects never leave the renderer boundary.
#[tauri::command]
async fn browser_download_fetch(
    page_url: String,
    target_url: String,
) -> Result<browser_download::FetchResult, String> {
    browser_download::fetch_same_origin(&page_url, &target_url).await
}

/// Probe local prerequisites for the first-launch recovery screen. This is a
/// read-only, bounded check: it never starts a sidecar or changes WSL/Muse.
#[tauri::command]
async fn probe_startup(
    workspace_path: Option<String>,
) -> Result<startup::StartupProbe, String> {
    let workspace = workspace_path.map(PathBuf::from);
    tokio::task::spawn_blocking(move || startup::probe(resolve_sidecar(), workspace.as_deref()))
        .await
        .map_err(|e| format!("startup probe task failed: {e}"))
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

async fn start_session_at_workspace(
    app: AppHandle,
    state: State<'_, AppState>,
    root: PathBuf,
    authorization_mode: Option<String>,
) -> Result<SessionMeta, String> {
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
    let res = request_session_start(&client, params, authorization_mode.as_deref()).await?;
    let session = res.get("session").ok_or("session/start: no session in response")?;
    let session_id = session
        .get("sessionId")
        .and_then(Value::as_str)
        .or_else(|| session.get("id").and_then(Value::as_str))
        .ok_or("session/start: response has no session id")?
        .to_string();
    state.hosts.lock().map_err(|e| format!("state lock: {e}"))?.bind(&session_id, &root, &client)?;
    let running = session.get("status").and_then(Value::as_str).map(|s| s == "running").unwrap_or(false);
    let session_durability = state
        .host_durability
        .lock()
        .map_err(|e| format!("state lock: {e}"))?
        .get(&root)
        .cloned();
    let granted_capabilities = session_granted_capabilities(&state, &root)?;
    let meta = SessionMeta {
        session_id: session_id.clone(),
        workspace: root.display().to_string(),
        running,
        session_durability,
        approval_mode: session_approval_mode(session),
        granted_capabilities,
    };
    state
        .sessions
        .lock()
        .map_err(|e| format!("state lock: {e}"))?
        .insert(session_id, meta.clone());
    Ok(meta)
}

/// Start a session with a requested posture, but fall back to the host's
/// default only when it explicitly reports its approval ceiling. This helper
/// contains no Tauri state so the retry contract can be exercised by a small
/// MSP fixture as well as the live command.
async fn request_session_start(
    client: &MspClient,
    mut params: Value,
    authorization_mode: Option<&str>,
) -> Result<Value, String> {
    match client.request("session/start", params.clone()).await {
        Ok(result) => Ok(result),
        Err(error) if authorization_mode.is_some() && is_approval_mode_ceiling(&error) => {
            // A persisted local preference must not make a new conversation
            // unusable when this host advertises a stricter ceiling. Start
            // with the host default, expose its effective projection below,
            // and let the renderer keep automatic decisions fail-closed.
            if let Some(object) = params.as_object_mut() {
                object.remove("approvalMode");
            }
            Ok(client.request("session/start", params).await.map_err(|fallback| {
                format!("session/start rejected requested posture ({error}); host default also failed: {fallback}")
            })?)
        }
        Err(error) => return Err(error),
    }
}

#[tauri::command]
async fn start_session(
    app: AppHandle,
    state: State<'_, AppState>,
    workspace_path: Option<String>,
    authorization_mode: Option<String>,
) -> Result<SessionMeta, String> {
    let root = resolve_workspace(&state, workspace_path)?;
    start_session_at_workspace(app, state, root, authorization_mode).await
}

/// Create a server-side conversation branch from all completed turns.
///
/// The MSP host owns the durable history and assigns the new session id. We
/// deliberately request metadata only (`excludeItems`) so a large transcript
/// is not duplicated through the Tauri command; the frontend can keep its
/// bounded local transcript for immediate continuity.
fn fork_request_params(
    command_id: &str,
    session_id: &str,
    last_turn_id: Option<&str>,
) -> Value {
    let mut params = json!({
        "commandId": command_id,
        "sessionId": session_id,
        "excludeItems": true,
    });
    if let Some(turn_id) = last_turn_id.filter(|id| !id.trim().is_empty()) {
        params["cutPoint"] = json!({ "lastTurnId": turn_id });
    }
    params
}

#[tauri::command]
async fn fork_session(
    state: State<'_, AppState>,
    session_id: String,
    last_turn_id: Option<String>,
) -> Result<SessionMeta, String> {
    let source_id = require_non_empty(&session_id, "sessionId")?;
    let client = session_client(&state, &source_id)?;
    let root = state
        .hosts
        .lock()
        .map_err(|e| format!("state lock: {e}"))?
        .session_workspace(&source_id)?;
    let command_id = new_command_id();
    let result = client
        .request(
            "session/fork",
            fork_request_params(command_id.as_str(), &source_id, last_turn_id.as_deref()),
        )
        .await?;
    let session = result
        .get("session")
        .ok_or("session/fork: no session in response")?;
    let fork_id = session
        .get("sessionId")
        .and_then(Value::as_str)
        .or_else(|| session.get("id").and_then(Value::as_str))
        .filter(|id| !id.trim().is_empty())
        .ok_or("session/fork: response has no session id")?
        .to_string();
    if fork_id == source_id {
        return Err("session/fork returned the source session id".to_string());
    }
    state
        .hosts
        .lock()
        .map_err(|e| format!("state lock: {e}"))?
        .bind(&fork_id, &root, &client)?;
    let running = session
        .get("status")
        .and_then(Value::as_str)
        .is_some_and(|status| status == "running");
    let meta = SessionMeta {
        session_id: fork_id.clone(),
        workspace: root.display().to_string(),
        running,
        session_durability: state
            .host_durability
            .lock()
            .map_err(|e| format!("state lock: {e}"))?
            .get(&root)
            .cloned(),
        approval_mode: session_approval_mode(session),
        granted_capabilities: session_granted_capabilities(&state, &root)?,
    };
    state
        .sessions
        .lock()
        .map_err(|e| format!("state lock: {e}"))?
        .insert(fork_id, meta.clone());
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
    if state
        .host_durability
        .lock()
        .map_err(|e| format!("state lock: {e}"))?
        .get(&root)
        .is_some_and(|value| value.eq_ignore_ascii_case("ephemeral"))
    {
        return Err(
            "this Muse host uses ephemeral sessions; the saved conversation cannot be resumed after the host restarts".into(),
        );
    }
    let read = client.request("session/read", json!({"sessionId":session_id,"excludeItems":true})).await?;
    resume::validate(read.get("session").ok_or("session/read returned no conversation")?, &session_id, &root)?;
    // Register before resume: pending approval/input events may immediately
    // follow the response, before this awaiting task is scheduled again.
    let mut meta = SessionMeta {
        session_id: session_id.clone(),
        workspace: root.display().to_string(),
        running: false,
        session_durability: state
            .host_durability
            .lock()
            .map_err(|e| format!("state lock: {e}"))?
            .get(&root)
            .cloned(),
        approval_mode: read
            .get("session")
            .and_then(session_approval_mode),
        granted_capabilities: session_granted_capabilities(&state, &root)?,
    };
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
                    meta.approval_mode = session_approval_mode(session).or(meta.approval_mode);
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

/// Read the folded durable item history for an attached conversation.
/// `session/read` is intentionally separate from `resume_session`: it is a
/// point-in-time read with no lease or request re-emission, so the UI can
/// reconcile a cold local log without disturbing the live resume flow.
#[tauri::command]
async fn read_session_history(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<Value, String> {
    let client = session_client(&state, &session_id)?;
    let root = state
        .hosts
        .lock()
        .map_err(|e| format!("state lock: {e}"))?
        .session_workspace(&session_id)?;
    let read = client
        .request(
            "session/read",
            json!({"sessionId": session_id, "excludeItems": false}),
        )
        .await?;
    let session = read
        .get("session")
        .ok_or("session/read returned no conversation")?;
    resume::validate(session, &session_id, &root)?;
    Ok(read.get("history").cloned().unwrap_or_else(|| json!({"items": []})))
}

/// Read the host's folded queue when its history response includes a snapshot.
/// A null result means this host served inline metadata without queue state;
/// the renderer must retain its local reminders in that case.
#[tauri::command]
async fn read_queue_snapshot(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<Value, String> {
    let session_id = require_non_empty(&session_id, "sessionId")?;
    let client = session_client(&state, &session_id)?;
    let read = client
        .request(
            "session/read",
            json!({"sessionId": session_id, "excludeItems": false}),
        )
        .await?;
    Ok(read
        .get("history")
        .and_then(|history| history.get("snapshot"))
        .and_then(|snapshot| snapshot.get("queuedTurns"))
        .cloned()
        .unwrap_or(Value::Null))
}

/// Pull the current approval/input set after reconnect. Unlike the resume
/// response this command is safe to call repeatedly: it is a point-in-time
/// fold read and carries the requirement token used by later decisions.
#[tauri::command]
async fn list_pending_requests(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<Value, String> {
    let session_id = require_non_empty(&session_id, "sessionId")?;
    let client = session_client(&state, &session_id)?;
    let result = client
        .request("approval/listPending", json!({"sessionId": session_id}))
        .await?;
    // Rebuild the supervisor's opaque requirement registry from the same
    // point-in-time fold that feeds the renderer. Without this step a card
    // recovered after reconnect would render but its approval click would be
    // rejected locally as an unknown id.
    if let Some(approvals) = result.get("approvals").and_then(Value::as_array) {
        let mut registry = state
            .approvals
            .lock()
            .map_err(|e| format!("state lock: {e}"))?;
        registry.retain(|(sid, approval_id), _| {
            sid != &session_id || approvals.iter().any(|item| {
                item.get("approvalId")
                    .and_then(Value::as_str)
                    .is_some_and(|id| id == approval_id)
            })
        });
        for item in approvals {
            let Some(approval_id) = item.get("approvalId").and_then(Value::as_str) else {
                continue;
            };
            let requirement = item
                .get("currentRequirementId")
                .or_else(|| item.get("current_requirement_id"))
                .cloned()
                .unwrap_or(Value::Null);
            registry.insert(
                (session_id.clone(), approval_id.to_string()),
                PendingApproval {
                    session_id: session_id.clone(),
                    requirement_id: requirement,
                },
            );
        }
    }
    Ok(result)
}

/// Drain backend events after `since` (None = head cursor only, no replay).
/// The UI polls this every ~300ms instead of `listen` push delivery.
fn event_buffer_gap(since: u64, oldest: Option<u64>) -> bool {
    oldest.is_some_and(|first| since.saturating_add(1) < first)
}

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
    let oldest = buf.front().map(|event| event.seq);
    let truncated = event_buffer_gap(since, oldest);
    Ok(PollResult {
        head,
        oldest,
        truncated,
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

/// Start one turn through the session-owned MSP client. Keeping the command
/// body behind an `AppState` helper lets the supervisor fixture exercise the
/// exact production payload and failure path without constructing a Tauri
/// window or starting a model provider.
async fn send_input_for_state(
    state: &AppState,
    session_id: String,
    command_id: String,
    text: String,
    input_parts: Option<Value>,
) -> Result<Value, String> {
    if command_id.trim().is_empty() {
        return Err("empty commandId".to_string());
    }
    // Preserve the legacy command contract for callers that do not provide
    // structured parts. Attachment-only sends intentionally pass `Some` and
    // are validated below instead of being rejected as empty text.
    if input_parts.is_none() && text.trim().is_empty() {
        return Err("empty input".to_string());
    }
    let input = input_parts.unwrap_or_else(|| json!([{ "type": "text", "text": text }]));
    validate_turn_input_parts(&input)?;
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
                "input": input,
            }),
        )
        .await?;
    mark_running(&state, &session_id, true);
    Ok(result)
}

const MAX_USER_SHELL_COMMAND_CHARS: usize = 16_000;

/// Build the capability-gated `session/userShell` request. The command is a
/// user-initiated shell escape hatch in the session workspace, so it carries
/// the same UUIDv7 idempotency handle as a normal turn but never pretends to
/// be model input. Pure validation keeps malformed renderer calls fail-closed.
fn user_shell_payload(
    session_id: &str,
    command_id: &str,
    command_text: &str,
) -> Result<Value, String> {
    let session_id = require_non_empty(session_id, "sessionId")?;
    let command_id = require_non_empty(command_id, "commandId")?;
    let command_text = require_non_empty(command_text, "commandText")?;
    if command_text.chars().count() > MAX_USER_SHELL_COMMAND_CHARS {
        return Err(format!(
            "commandText exceeds {MAX_USER_SHELL_COMMAND_CHARS} characters"
        ));
    }
    Ok(json!({
        "commandId": command_id,
        "sessionId": session_id,
        "commandText": command_text,
    }))
}

/// Send one explicit terminal command through the host's user-shell lane.
/// The capability is checked only when the handshake gave an explicit grant
/// list; an absent list is left to the host's canonical capability error so
/// older hosts remain diagnosable instead of being silently emulated.
async fn user_shell_for_state(
    state: &AppState,
    session_id: String,
    command_id: String,
    command_text: String,
) -> Result<Value, String> {
    let payload = user_shell_payload(&session_id, &command_id, &command_text)?;
    let client = session_client(state, &session_id)?;
    let root = state
        .hosts
        .lock()
        .map_err(|e| format!("state lock: {e}"))?
        .session_workspace(&session_id)?;
    if let Some(granted) = state
        .host_capabilities
        .lock()
        .map_err(|e| format!("state lock: {e}"))?
        .get(&root)
        .cloned()
    {
        if !granted.iter().any(|capability| capability == "userShell") {
            return Err("Muse host did not grant the userShell capability".to_string());
        }
    }
    client.request("session/userShell", payload).await
}

#[tauri::command]
async fn user_shell(
    state: State<'_, AppState>,
    session_id: String,
    command_id: String,
    command_text: String,
) -> Result<Value, String> {
    user_shell_for_state(&state, session_id, command_id, command_text).await
}

#[tauri::command]
async fn send_input(
    state: State<'_, AppState>,
    session_id: String,
    command_id: String,
    text: String,
    input_parts: Option<Value>,
) -> Result<Value, String> {
    send_input_for_state(&state, session_id, command_id, text, input_parts).await
}

/// Reclaim one queued turn before the host launches it. This is deliberately
/// separate from `cancel_session`: an interrupt targets the running turn,
/// while an unqueue only wins the queued-turn race and never upgrades to a
/// cancellation after launch.
#[tauri::command]
async fn unqueue_turn(
    state: State<'_, AppState>,
    session_id: String,
    turn_id: String,
) -> Result<Value, String> {
    let session_id = require_non_empty(&session_id, "sessionId")?;
    let turn_id = require_non_empty(&turn_id, "turnId")?;
    let client = session_client(&state, &session_id)?;
    client
        .request(
            "turn/unqueue",
            json!({
                "commandId": new_command_id(),
                "sessionId": session_id,
                "turnId": turn_id,
            }),
        )
        .await
}

/// Inject guidance into the currently running turn without creating a new
/// queued turn. The renderer supplies the turn id it observed in the latest
/// admission/start acknowledgement; the host rejects stale targets.
#[tauri::command]
async fn steer_input(
    state: State<'_, AppState>,
    session_id: String,
    command_id: String,
    expected_turn_id: String,
    text: String,
    input_parts: Option<Value>,
) -> Result<Value, String> {
    let session_id = require_non_empty(&session_id, "sessionId")?;
    let command_id = require_non_empty(&command_id, "commandId")?;
    let expected_turn_id = require_non_empty(&expected_turn_id, "expectedTurnId")?;
    if input_parts.is_none() && text.trim().is_empty() {
        return Err("empty input".to_string());
    }
    let input = input_parts.unwrap_or_else(|| json!([{ "type": "text", "text": text }]));
    validate_turn_input_parts(&input)?;
    let client = session_client(&state, &session_id)?;
    client
        .request(
            "turn/steer",
            json!({
                "commandId": command_id,
                "sessionId": session_id,
                "expectedTurnId": expected_turn_id,
                "input": input,
            }),
        )
        .await
}

const MAX_TURN_INPUT_PARTS: usize = 8;
const MAX_TURN_IMAGE_BYTES: usize = 5 * 1024 * 1024;

/// Validate the stable MSP `turn/start.input` subset before it reaches the
/// sidecar. The host remains authoritative, but rejecting malformed or
/// oversized browser payloads here keeps errors local and predictable.
fn validate_turn_input_parts(input: &Value) -> Result<(), String> {
    let parts = input
        .as_array()
        .ok_or_else(|| "inputParts must be a JSON array".to_string())?;
    if parts.is_empty() {
        return Err("inputParts must contain at least one part".to_string());
    }
    if parts.len() > MAX_TURN_INPUT_PARTS {
        return Err(format!(
            "inputParts cannot contain more than {MAX_TURN_INPUT_PARTS} parts"
        ));
    }
    for (index, part) in parts.iter().enumerate() {
        let object = part
            .as_object()
            .ok_or_else(|| format!("inputParts[{index}] must be an object"))?;
        let kind = object
            .get("type")
            .and_then(Value::as_str)
            .ok_or_else(|| format!("inputParts[{index}].type is required"))?;
        match kind {
            "text" => {
                let value = object
                    .get("text")
                    .and_then(Value::as_str)
                    .ok_or_else(|| format!("inputParts[{index}].text is required"))?;
                if value.trim().is_empty() {
                    return Err(format!("inputParts[{index}].text must not be empty"));
                }
                if value.chars().count() > 120_000 {
                    return Err(format!("inputParts[{index}].text exceeds 120000 characters"));
                }
            }
            "image" => {
                let media_type = object
                    .get("mediaType")
                    .and_then(Value::as_str)
                    .filter(|value| value.starts_with("image/"))
                    .ok_or_else(|| {
                        format!("inputParts[{index}].mediaType must be an image MIME type")
                    })?;
                let encoded = object
                    .get("base64Data")
                    .and_then(Value::as_str)
                    .filter(|value| !value.is_empty())
                    .ok_or_else(|| format!("inputParts[{index}].base64Data is required"))?;
                let decoded = base64::engine::general_purpose::STANDARD
                    .decode(encoded)
                    .map_err(|_| format!("inputParts[{index}].base64Data is invalid"))?;
                if decoded.is_empty() || decoded.len() > MAX_TURN_IMAGE_BYTES {
                    return Err(format!(
                        "inputParts[{index}] image exceeds the {} MB limit",
                        MAX_TURN_IMAGE_BYTES / 1024 / 1024
                    ));
                }
                if object.get("width").is_some() != object.get("height").is_some() {
                    return Err(format!(
                        "inputParts[{index}].width and height must be provided together"
                    ));
                }
                let _ = media_type;
            }
            other => {
                return Err(format!(
                    "inputParts[{index}] has unsupported type {other:?}"
                ));
            }
        }
    }
    Ok(())
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
    interrupt_session(&app, &state, &session_id).await
}

/// Send the interrupt command without changing local turn state. Keeping the
/// transport request separate makes the admission-only semantics testable
/// without constructing a Tauri application handle.
async fn request_interrupt(state: &AppState, session_id: &str) -> Result<Value, String> {
    let client = session_client(state, session_id)?;
    client
        .request(
            "turn/interrupt",
            json!({
                "commandId": new_command_id(),
                "sessionId": session_id,
                "retract": false,
            }),
        )
        .await
}

/// Shared body of `cancel_session`: request an interrupt and let the host
/// prove the terminal state. An accepted `turn/interrupt` is admission only;
/// the renderer remains in its stopping state until `turn/completed`,
/// `turn/retracted` or another terminal notification arrives. This avoids a
/// late response being rendered as a new turn after the UI already declared
/// the conversation idle.
async fn interrupt_session(
    app: &AppHandle,
    state: &State<'_, AppState>,
    session_id: &str,
) -> Result<(), String> {
    // Clone the client out of the lock first: the std guard must never be
    // held across an await (it is !Send through the child handle).
    let result = request_interrupt(state, session_id).await;
    match result {
        Ok(_) => Ok(()),
        Err(error) => {
            mark_running(state, session_id, false);
            emit(app, "status", session_id, "cancelled", String::new());
            Err(format!("turn interrupt failed: {error}"))
        }
    }
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
    let _ = interrupt_session(&app, &state, &session_id).await;
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
    if let Ok(mut seen) = state.item_deltas_seen.lock() {
        seen.retain(|(sid, _)| *sid != session_id);
    }
    if let Ok(mut emitted) = state.item_fallback_emitted.lock() {
        emitted.retain(|(sid, _)| *sid != session_id);
    }
    if let Ok(mut watchers) = state.workspace_watchers.lock() {
        watchers.remove(&session_id);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    struct RecordingChild {
        writes: mpsc::UnboundedSender<Vec<u8>>,
        fail_write: bool,
    }

    impl msp::ChildTransport for RecordingChild {
        fn write(&mut self, buf: &[u8]) -> Result<(), String> {
            if self.fail_write {
                return Err("fixture write failed".to_string());
            }
            self.writes
                .send(buf.to_vec())
                .map_err(|_| "fixture receiver dropped".to_string())
        }

        fn kill(self: Box<Self>) -> Result<(), String> {
            Ok(())
        }
    }

    fn fixture_client(fail_write: bool) -> (Arc<MspClient>, mpsc::UnboundedReceiver<Vec<u8>>) {
        let (writes, received) = mpsc::unbounded_channel();
        let child = RecordingChild { writes, fail_write };
        let (notify_tx, _) = mpsc::unbounded_channel();
        let client = Arc::new(MspClient::new(
            Arc::new(tokio::sync::Mutex::new(Some(Box::new(child)))),
            notify_tx,
        ));
        (client, received)
    }

    async fn fixture_frame(rx: &mut mpsc::UnboundedReceiver<Vec<u8>>) -> Value {
        let bytes = tokio::time::timeout(std::time::Duration::from_secs(1), rx.recv())
            .await
            .expect("fixture did not receive a request")
            .expect("fixture channel closed");
        serde_json::from_slice::<Value>(bytes.strip_suffix(b"\n").unwrap_or(&bytes))
            .expect("fixture request must be valid JSON")
    }

    fn register_fixture_session(
        state: &AppState,
        session_id: &str,
        workspace: &str,
        client: Arc<MspClient>,
    ) {
        let root = PathBuf::from(workspace);
        state.hosts.lock().unwrap().insert(root.clone(), client.clone());
        state
            .hosts
            .lock()
            .unwrap()
            .bind(session_id, &root, &client)
            .unwrap();
        state.sessions.lock().unwrap().insert(
            session_id.to_string(),
            SessionMeta {
                session_id: session_id.to_string(),
                workspace: workspace.to_string(),
                running: false,
                session_durability: None,
                approval_mode: None,
                granted_capabilities: None,
            },
        );
    }

    fn empty_state() -> AppState {
        AppState {
            resume_mutex: tokio::sync::Mutex::new(()),
            hosts: Mutex::new(Hosts::default()),
            workspace: Mutex::new(None),
            sessions: Mutex::new(HashMap::new()),
            host_durability: Mutex::new(HashMap::new()),
            host_capabilities: Mutex::new(HashMap::new()),
            approvals: Mutex::new(HashMap::new()),
            item_kinds: Mutex::new(HashMap::new()),
            subagent_meta: Mutex::new(HashMap::new()),
            item_deltas_seen: Mutex::new(HashSet::new()),
            item_fallback_emitted: Mutex::new(HashSet::new()),
            host_mutex: tokio::sync::Mutex::new(()),
            event_seq: Mutex::new(0),
            event_buffer: Mutex::new(std::collections::VecDeque::new()),
            terminals: terminal::TerminalRegistry::default(),
            setup_cancellations: Mutex::new(HashMap::new()),
            mcp_servers: Arc::new(Mutex::new(HashMap::new())),
            workspace_watchers: Mutex::new(HashMap::new()),
        }
    }

    #[test]
    fn notification_lanes_are_scoped_by_session_identity() {
        let state = empty_state();
        let mut events = Vec::new();
        let mut emit = |event: &str, sid: &str, kind: &str, payload: String| {
            events.push((event.to_string(), sid.to_string(), kind.to_string(), payload));
        };
        route_notification_with_emit(
            &state,
            "item/started",
            &json!({"sessionId":"session-a","itemId":"same-item","item":{"kind":"reasoning"}}),
            &mut emit,
        );
        route_notification_with_emit(
            &state,
            "item/started",
            &json!({"sessionId":"session-b","itemId":"same-item","item":{"kind":"agentMessage"}}),
            &mut emit,
        );
        route_notification_with_emit(
            &state,
            "item/delta",
            &json!({"sessionId":"session-a","itemId":"same-item","delta":"private reasoning"}),
            &mut emit,
        );
        route_notification_with_emit(
            &state,
            "item/delta",
            &json!({"sessionId":"session-b","itemId":"same-item","delta":"public answer"}),
            &mut emit,
        );
        let deltas = events
            .iter()
            .filter(|(_, _, kind, _)| kind == "thinking" || kind == "output")
            .collect::<Vec<_>>();
        assert_eq!(deltas.len(), 2);
        assert_eq!(deltas[0].0, "thinking");
        assert_eq!(deltas[0].1, "session-a");
        assert_eq!(deltas[1].0, "output");
        assert_eq!(deltas[1].1, "session-b");
    }

    #[test]
    fn approval_cards_are_isolated_when_ids_repeat_between_sessions() {
        let state = empty_state();
        let mut events = Vec::new();
        let mut emit = |event: &str, sid: &str, kind: &str, payload: String| {
            events.push((event.to_string(), sid.to_string(), kind.to_string(), payload));
        };
        for (sid, requirement) in [("session-a", "req-a"), ("session-b", "req-b")] {
            route_notification_with_emit(
                &state,
                "approval/requested",
                &json!({
                    "sessionId": sid,
                    "approvalId": "same-approval",
                    "currentRequirementId": requirement,
                    "subject": {"kind":"shell","command":"echo safe"}
                }),
                &mut emit,
            );
        }
        let approvals = state.approvals.lock().unwrap();
        assert_eq!(approvals.len(), 2);
        assert_eq!(approvals[&(String::from("session-a"), String::from("same-approval"))].session_id, "session-a");
        assert_eq!(approvals[&(String::from("session-b"), String::from("same-approval"))].requirement_id, json!("req-b"));
        assert_eq!(events.iter().filter(|e| e.0 == "tool_request").count(), 2);
    }

    #[tokio::test]
    async fn send_input_keeps_session_routes_and_correlates_out_of_order_replies() {
        let state = Arc::new(empty_state());
        let (client_a, mut frames_a) = fixture_client(false);
        let (client_b, mut frames_b) = fixture_client(false);
        register_fixture_session(state.as_ref(), "session-a", "fixture-a", client_a.clone());
        register_fixture_session(state.as_ref(), "session-b", "fixture-b", client_b.clone());

        let task_a = tokio::spawn({
            let state = state.clone();
            async move {
                send_input_for_state(
                    state.as_ref(),
                    "session-a".to_string(),
                    "client-message-a".to_string(),
                    "inspect A".to_string(),
                    None,
                )
                .await
            }
        });
        let task_b = tokio::spawn({
            let state = state.clone();
            async move {
                send_input_for_state(
                    state.as_ref(),
                    "session-b".to_string(),
                    "client-message-b".to_string(),
                    "inspect B".to_string(),
                    None,
                )
                .await
            }
        });

        let frame_a = fixture_frame(&mut frames_a).await;
        let frame_b = fixture_frame(&mut frames_b).await;
        assert_eq!(frame_a["method"], "turn/start");
        assert_eq!(frame_b["method"], "turn/start");
        assert_eq!(frame_a["params"]["sessionId"], "session-a");
        assert_eq!(frame_b["params"]["sessionId"], "session-b");
        assert_eq!(frame_a["params"]["input"][0]["text"], "inspect A");
        assert_eq!(frame_b["params"]["input"][0]["text"], "inspect B");

        // Deliver B first even though A was admitted first. Each response is
        // ingested by its owning client and must wake only its own caller.
        client_b
            .ingest(json!({
                "jsonrpc": "2.0",
                "id": frame_b["id"],
                "result": {"status": "accepted", "turnId": "turn-b"}
            }))
            .await;
        client_a
            .ingest(json!({
                "jsonrpc": "2.0",
                "id": frame_a["id"],
                "result": {"status": "accepted", "turnId": "turn-a"}
            }))
            .await;

        assert_eq!(task_a.await.unwrap().unwrap()["turnId"], "turn-a");
        assert_eq!(task_b.await.unwrap().unwrap()["turnId"], "turn-b");
        assert!(state.sessions.lock().unwrap()["session-a"].running);
        assert!(state.sessions.lock().unwrap()["session-b"].running);
    }

    #[tokio::test]
    async fn send_input_write_failure_is_bounded_and_does_not_mark_running() {
        let state = empty_state();
        let (client, _frames) = fixture_client(true);
        register_fixture_session(&state, "session-a", "fixture-a", client);

        let error = send_input_for_state(
            &state,
            "session-a".to_string(),
            "client-message-a".to_string(),
            "inspect A".to_string(),
            None,
        )
        .await
        .unwrap_err();

        assert!(error.contains("sidecar write failed"), "{error}");
        assert!(!state.sessions.lock().unwrap()["session-a"].running);
    }

    #[tokio::test]
    async fn interrupt_ack_keeps_session_running_until_terminal_notification() {
        let state = Arc::new(empty_state());
        let (client, mut frames) = fixture_client(false);
        register_fixture_session(state.as_ref(), "session-a", "fixture-a", client.clone());
        state.sessions.lock().unwrap().get_mut("session-a").unwrap().running = true;

        let request = tokio::spawn({
            let state = state.clone();
            async move { request_interrupt(state.as_ref(), "session-a").await }
        });
        let frame = fixture_frame(&mut frames).await;
        assert_eq!(frame["method"], "turn/interrupt");
        assert_eq!(frame["params"]["sessionId"], "session-a");
        client
            .ingest(json!({
                "jsonrpc": "2.0",
                "id": frame["id"],
                "result": {"status": "accepted", "turnId": "turn-a"}
            }))
            .await;

        assert_eq!(request.await.unwrap().unwrap()["status"], "accepted");
        // The admission ack alone must not flip the live session to idle.
        assert!(state.sessions.lock().unwrap()["session-a"].running);

        let mut events = Vec::new();
        let mut emit = |event: &str, sid: &str, kind: &str, payload: String| {
            events.push((event.to_string(), sid.to_string(), kind.to_string(), payload));
        };
        route_notification_with_emit(
            state.as_ref(),
            "turn/completed",
            &json!({"sessionId":"session-a","turnId":"turn-a","terminal":"cancelled"}),
            &mut emit,
        );
        assert!(!state.sessions.lock().unwrap()["session-a"].running);
        assert_eq!(events.last().map(|event| event.2.as_str()), Some("cancelled"));
    }

    #[test]
    fn turn_retracted_is_terminal_cancellation() {
        let state = empty_state();
        state.sessions.lock().unwrap().insert(
            "session-a".to_string(),
            SessionMeta {
                session_id: "session-a".to_string(),
                workspace: "C:/fixture".to_string(),
                running: true,
                session_durability: None,
                approval_mode: None,
                granted_capabilities: None,
            },
        );
        let mut events = Vec::new();
        let mut emit = |event: &str, sid: &str, kind: &str, payload: String| {
            events.push((event.to_string(), sid.to_string(), kind.to_string(), payload));
        };
        route_notification_with_emit(
            &state,
            "turn/retracted",
            &json!({"sessionId":"session-a","turnId":"turn-a","reason":"interrupted"}),
            &mut emit,
        );

        assert!(!state.sessions.lock().unwrap()["session-a"].running);
        let (_, sid, kind, payload) = events.last().expect("terminal status event");
        assert_eq!(sid, "session-a");
        assert_eq!(kind, "cancelled");
        assert!(payload.contains("\"terminal\":\"cancelled\""));
        assert!(payload.contains("\"turnId\":\"turn-a\""));
    }

    #[test]
    fn approval_resolution_without_decision_fails_closed() {
        let state = empty_state();
        let mut events = Vec::new();
        let mut emit = |event: &str, sid: &str, kind: &str, payload: String| {
            events.push((event.to_string(), sid.to_string(), kind.to_string(), payload));
        };
        route_notification_with_emit(
            &state,
            "approval/resolved",
            &json!({"sessionId":"session-a","approvalId":"approval-a"}),
            &mut emit,
        );

        let (_, sid, kind, payload) = events.last().expect("approval resolution event");
        assert_eq!(sid, "session-a");
        assert_eq!(kind, "approval/resolved");
        assert!(payload.contains("\"decision\":\"unknown\""));
        assert!(payload.contains("\"terminal\":true"));
    }

    #[tokio::test]
    async fn stdout_pump_reassembles_frames_and_routes_notifications() {
        let (writes, mut frames) = mpsc::unbounded_channel();
        let (notify_tx, mut notify_rx) = mpsc::unbounded_channel();
        let child = RecordingChild { writes, fail_write: false };
        let client = Arc::new(MspClient::new(
            Arc::new(tokio::sync::Mutex::new(Some(Box::new(child)))),
            notify_tx,
        ));
        let stderr_tail = Arc::new(Mutex::new(Vec::new()));
        let mut out_buf = Vec::new();

        let request = tokio::spawn({
            let client = client.clone();
            async move { client.request("model/list", Value::Null).await }
        });
        let request_frame = fixture_frame(&mut frames).await;
        let mut response = serde_json::to_vec(&json!({
            "jsonrpc": "2.0",
            "id": request_frame["id"],
            "result": {"models": []}
        }))
        .unwrap();
        response.push(b'\n');
        let split_at = response.len() / 2;
        ingest_stdout_chunk(&client, &mut out_buf, &stderr_tail, &response[..split_at]).await;
        assert!(!request.is_finished(), "partial stdout must not complete a request");
        ingest_stdout_chunk(&client, &mut out_buf, &stderr_tail, &response[split_at..]).await;
        assert_eq!(request.await.unwrap().unwrap()["models"], json!([]));

        let mut notification = serde_json::to_vec(&json!({
            "jsonrpc": "2.0",
            "method": "turn/started",
            "params": {"sessionId": "s"}
        }))
        .unwrap();
        notification.push(b'\n');
        ingest_stdout_chunk(&client, &mut out_buf, &stderr_tail, &notification).await;
        let (method, params) = tokio::time::timeout(std::time::Duration::from_secs(1), notify_rx.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(method, "turn/started");
        assert_eq!(params["sessionId"], "s");

        ingest_stdout_chunk(&client, &mut out_buf, &stderr_tail, b"not-json\n").await;
        assert!(stderr_tail.lock().unwrap()[0].contains("unparsable frame"));
    }

    #[tokio::test]
    async fn command_event_pump_handles_shell_errors_and_closed_channel() {
        let (tx, rx) = tauri::async_runtime::channel(16);
        let (writes, mut frames) = mpsc::unbounded_channel();
        let (notify_tx, mut notify_rx) = mpsc::unbounded_channel();
        let child = RecordingChild { writes, fail_write: false };
        let client = Arc::new(MspClient::new(
            Arc::new(tokio::sync::Mutex::new(Some(Box::new(child)))),
            notify_tx,
        ));
        let stderr_tail = Arc::new(Mutex::new(Vec::new()));
        let pump = tokio::spawn(consume_command_events(rx, client.clone(), stderr_tail.clone()));

        let request = tokio::spawn({
            let client = client.clone();
            async move { client.request("model/list", Value::Null).await }
        });
        let request_frame = fixture_frame(&mut frames).await;
        let response = format!(
            "{}\n",
            serde_json::to_string(&json!({
                "jsonrpc": "2.0",
                "id": request_frame["id"],
                "result": {"models": []}
            })).unwrap()
        );
        let split_at = response.len() / 2;
        tx.send(CommandEvent::Stdout(response.as_bytes()[..split_at].to_vec())).await.unwrap();
        assert!(!request.is_finished(), "partial shell stdout must not complete a request");
        tx.send(CommandEvent::Stdout(response.as_bytes()[split_at..].to_vec())).await.unwrap();
        assert_eq!(request.await.unwrap().unwrap()["models"], json!([]));

        tx.send(CommandEvent::Stderr(b"token=secret\n".to_vec())).await.unwrap();
        tx.send(CommandEvent::Error("pipe lost".to_string())).await.unwrap();
        tx.send(CommandEvent::Stdout(b"not-json\n".to_vec())).await.unwrap();
        drop(tx);

        assert!(matches!(pump.await.unwrap(), PumpExit::ChannelClosed));
        let diagnostics = stderr_tail.lock().unwrap().join(" | ");
        assert!(diagnostics.contains("[redacted]"));
        assert!(diagnostics.contains("shell command error: pipe lost"));
        assert!(diagnostics.contains("unparsable frame"));
        assert!(notify_rx.try_recv().is_err());
    }

    #[tokio::test]
    async fn command_event_pump_preserves_exit_payload_and_wakes_pending_request() {
        let (tx, rx) = tauri::async_runtime::channel(4);
        let (writes, mut frames) = mpsc::unbounded_channel();
        let (notify_tx, _notify_rx) = mpsc::unbounded_channel();
        let child = RecordingChild { writes, fail_write: false };
        let client = Arc::new(MspClient::new(
            Arc::new(tokio::sync::Mutex::new(Some(Box::new(child)))),
            notify_tx,
        ));
        let stderr_tail = Arc::new(Mutex::new(Vec::new()));
        let pump = tokio::spawn(consume_command_events(rx, client.clone(), stderr_tail));

        let request = tokio::spawn({
            let client = client.clone();
            async move { client.request("model/list", Value::Null).await }
        });
        let request_frame = fixture_frame(&mut frames).await;
        assert_eq!(request_frame["method"], "model/list");

        tx.send(CommandEvent::Terminated(TerminatedPayload {
            code: Some(17),
            signal: None,
        }))
        .await
        .unwrap();

        let exit = pump.await.unwrap();
        assert!(matches!(
            exit,
            PumpExit::Terminated(TerminatedPayload {
                code: Some(17),
                signal: None
            })
        ));
        let request_error = tokio::time::timeout(std::time::Duration::from_secs(1), request)
            .await
            .unwrap()
            .unwrap()
            .unwrap_err();
        assert_eq!(request_error, "sidecar dropped the response");
    }

    #[tokio::test]
    async fn command_event_pump_flushes_unterminated_response_before_exit() {
        let (tx, rx) = tauri::async_runtime::channel(4);
        let (writes, mut frames) = mpsc::unbounded_channel();
        let (notify_tx, _notify_rx) = mpsc::unbounded_channel();
        let child = RecordingChild { writes, fail_write: false };
        let client = Arc::new(MspClient::new(
            Arc::new(tokio::sync::Mutex::new(Some(Box::new(child)))),
            notify_tx,
        ));
        let stderr_tail = Arc::new(Mutex::new(Vec::new()));
        let pump = tokio::spawn(consume_command_events(rx, client.clone(), stderr_tail));

        let request = tokio::spawn({
            let client = client.clone();
            async move { client.request("model/list", Value::Null).await }
        });
        let request_frame = fixture_frame(&mut frames).await;
        let response = serde_json::to_vec(&json!({
            "jsonrpc": "2.0",
            "id": request_frame["id"],
            "result": {"models": []}
        }))
        .unwrap();
        tx.send(CommandEvent::Stdout(response)).await.unwrap();
        assert!(!request.is_finished(), "unterminated stdout must wait for flush");
        tx.send(CommandEvent::Terminated(TerminatedPayload {
            code: Some(0),
            signal: None,
        }))
        .await
        .unwrap();

        assert!(matches!(pump.await.unwrap(), PumpExit::Terminated(_)));
        assert_eq!(request.await.unwrap().unwrap()["models"], json!([]));
    }

    #[test]
    fn generated_tauri_invoke_routes_send_input_through_session_state() {
        let app = tauri::test::mock_builder()
            .manage(empty_state())
            .invoke_handler(tauri::generate_handler![send_input])
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock Tauri app should build");
        let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .expect("mock webview should build");

        let (client, mut frames) = fixture_client(false);
        let state = app.state::<AppState>();
        register_fixture_session(state.inner(), "session-a", "fixture-a", client.clone());

        let responder = std::thread::spawn(move || {
            tauri::async_runtime::block_on(async move {
                let frame = fixture_frame(&mut frames).await;
                assert_eq!(frame["method"], "turn/start");
                assert_eq!(frame["params"]["sessionId"], "session-a");
                assert_eq!(frame["params"]["commandId"], "ipc-command");
                client
                    .ingest(json!({
                        "jsonrpc": "2.0",
                        "id": frame["id"],
                        "result": {"status": "accepted", "turnId": "turn-ipc"}
                    }))
                    .await;
            });
        });

        let response = tauri::test::get_ipc_response(
            &webview,
            tauri::webview::InvokeRequest {
                cmd: "send_input".into(),
                callback: tauri::ipc::CallbackFn(0),
                error: tauri::ipc::CallbackFn(1),
                url: if cfg!(any(windows, target_os = "android")) {
                    "http://tauri.localhost"
                } else {
                    "tauri://localhost"
                }
                .parse()
                .unwrap(),
                body: tauri::ipc::InvokeBody::Json(json!({
                    "sessionId": "session-a",
                    "commandId": "ipc-command",
                    "text": "inspect through invoke",
                    "inputParts": null
                })),
                headers: Default::default(),
                invoke_key: tauri::test::INVOKE_KEY.to_string(),
            },
        )
        .expect("send_input invoke should succeed")
        .deserialize::<Value>()
        .expect("send_input response should be JSON");

        responder.join().expect("fixture responder should finish");
        assert_eq!(response["turnId"], "turn-ipc");
        assert!(state.inner().sessions.lock().unwrap()["session-a"].running);
    }

    #[test]
    fn generated_tauri_invoke_routes_user_shell_through_granted_host_capability() {
        let app = tauri::test::mock_builder()
            .manage(empty_state())
            .invoke_handler(tauri::generate_handler![user_shell])
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock Tauri app should build");
        let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .expect("mock webview should build");

        let (client, mut frames) = fixture_client(false);
        let state = app.state::<AppState>();
        register_fixture_session(state.inner(), "session-shell", "fixture-shell", client.clone());
        state
            .inner()
            .host_capabilities
            .lock()
            .unwrap()
            .insert(PathBuf::from("fixture-shell"), vec!["userShell".to_string()]);

        let responder = std::thread::spawn(move || {
            tauri::async_runtime::block_on(async move {
                let frame = fixture_frame(&mut frames).await;
                assert_eq!(frame["method"], "session/userShell");
                assert_eq!(frame["params"]["sessionId"], "session-shell");
                assert_eq!(frame["params"]["commandId"], "command-shell");
                assert_eq!(frame["params"]["commandText"], "git status --short");
                client
                    .ingest(json!({
                        "jsonrpc": "2.0",
                        "id": frame["id"],
                        "result": {"status": "accepted", "commandId": "command-shell"}
                    }))
                    .await;
            });
        });

        let response = tauri::test::get_ipc_response(
            &webview,
            tauri::webview::InvokeRequest {
                cmd: "user_shell".into(),
                callback: tauri::ipc::CallbackFn(0),
                error: tauri::ipc::CallbackFn(1),
                url: if cfg!(any(windows, target_os = "android")) {
                    "http://tauri.localhost"
                } else {
                    "tauri://localhost"
                }
                .parse()
                .unwrap(),
                body: tauri::ipc::InvokeBody::Json(json!({
                    "sessionId": "session-shell",
                    "commandId": "command-shell",
                    "commandText": "git status --short"
                })),
                headers: Default::default(),
                invoke_key: tauri::test::INVOKE_KEY.to_string(),
            },
        )
        .expect("user_shell invoke should succeed")
        .deserialize::<Value>()
        .expect("user_shell response should be JSON");

        responder.join().expect("fixture responder should finish");
        assert_eq!(response["status"], "accepted");
    }

    #[test]
    fn generated_tauri_invoke_approves_only_the_target_session() {
        let app = tauri::test::mock_builder()
            .manage(empty_state())
            .invoke_handler(tauri::generate_handler![approve])
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock Tauri app should build");
        let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .expect("mock webview should build");

        let (client_a, mut frames_a) = fixture_client(false);
        let (client_b, _frames_b) = fixture_client(false);
        let state = app.state::<AppState>();
        register_fixture_session(state.inner(), "session-a", "fixture-a", client_a.clone());
        register_fixture_session(state.inner(), "session-b", "fixture-b", client_b);
        let mut emitted = Vec::new();
        let mut emit = |event: &str, sid: &str, kind: &str, payload: String| {
            emitted.push((event.to_string(), sid.to_string(), kind.to_string(), payload));
        };
        for (sid, requirement) in [("session-a", "req-a"), ("session-b", "req-b")] {
            route_notification_with_emit(
                state.inner(),
                "approval/requested",
                &json!({
                    "sessionId": sid,
                    "approvalId": "same-approval",
                    "currentRequirementId": requirement,
                    "subject": {"kind":"shell","command":"echo safe"}
                }),
                &mut emit,
            );
        }
        assert_eq!(emitted.len(), 2);

        let responder = std::thread::spawn(move || {
            tauri::async_runtime::block_on(async move {
                let frame = fixture_frame(&mut frames_a).await;
                assert_eq!(frame["method"], "approval/decide");
                assert_eq!(frame["params"]["sessionId"], "session-a");
                assert_eq!(frame["params"]["approvalId"], "same-approval");
                assert_eq!(frame["params"]["requirementId"], "req-a");
                client_a
                    .ingest(json!({
                        "jsonrpc": "2.0",
                        "id": frame["id"],
                        "result": {"terminal": true}
                    }))
                    .await;
            });
        });

        let response = tauri::test::get_ipc_response(
            &webview,
            tauri::webview::InvokeRequest {
                cmd: "approve".into(),
                callback: tauri::ipc::CallbackFn(0),
                error: tauri::ipc::CallbackFn(1),
                url: if cfg!(any(windows, target_os = "android")) {
                    "http://tauri.localhost"
                } else {
                    "tauri://localhost"
                }
                .parse()
                .unwrap(),
                body: tauri::ipc::InvokeBody::Json(json!({
                    "sessionId": "session-a",
                    "approvalId": "same-approval",
                    "choiceId": "allow-once"
                })),
                headers: Default::default(),
                invoke_key: tauri::test::INVOKE_KEY.to_string(),
            },
        )
        .expect("approve invoke should succeed")
        .deserialize::<bool>()
        .expect("approve response should be a boolean");

        responder.join().expect("approval responder should finish");
        assert!(response);
        let approvals = state.inner().approvals.lock().unwrap();
        assert!(!approvals.contains_key(&("session-a".to_string(), "same-approval".to_string())));
        assert!(approvals.contains_key(&("session-b".to_string(), "same-approval".to_string())));
    }

    #[test]
    fn generated_tauri_invoke_answers_user_input_on_the_target_session() {
        let app = tauri::test::mock_builder()
            .manage(empty_state())
            .invoke_handler(tauri::generate_handler![answer_input])
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock Tauri app should build");
        let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .expect("mock webview should build");

        let (client, mut frames) = fixture_client(false);
        let state = app.state::<AppState>();
        register_fixture_session(state.inner(), "session-a", "fixture-a", client.clone());

        let responder = std::thread::spawn(move || {
            tauri::async_runtime::block_on(async move {
                let frame = fixture_frame(&mut frames).await;
                assert_eq!(frame["method"], "userInput/answer");
                assert_eq!(frame["params"]["sessionId"], "session-a");
                assert_eq!(frame["params"]["userInputId"], "input-a");
                assert_eq!(frame["params"]["answers"][0]["questionId"], "q1");
                assert_eq!(frame["params"]["answers"][0]["selectedLabel"], "Yes");
                client
                    .ingest(json!({
                        "jsonrpc": "2.0",
                        "id": frame["id"],
                        "result": {"status": "accepted"}
                    }))
                    .await;
            });
        });

        let response = tauri::test::get_ipc_response(
            &webview,
            tauri::webview::InvokeRequest {
                cmd: "answer_input".into(),
                callback: tauri::ipc::CallbackFn(0),
                error: tauri::ipc::CallbackFn(1),
                url: if cfg!(any(windows, target_os = "android")) {
                    "http://tauri.localhost"
                } else {
                    "tauri://localhost"
                }
                .parse()
                .unwrap(),
                body: tauri::ipc::InvokeBody::Json(json!({
                    "sessionId": "session-a",
                    "userInputId": "input-a",
                    "answers": [{"questionId": "q1", "selectedLabel": "Yes"}]
                })),
                headers: Default::default(),
                invoke_key: tauri::test::INVOKE_KEY.to_string(),
            },
        )
        .expect("answer_input invoke should succeed")
        .deserialize::<Value>()
        .expect("answer_input response should be JSON");

        responder.join().expect("input responder should finish");
        assert!(response.is_null());
    }

    #[tokio::test]
    async fn session_start_retries_without_posture_only_on_host_ceiling() {
        let (client, mut frames) = fixture_client(false);
        let request = tokio::spawn({
            let client = client.clone();
            async move {
                request_session_start(
                    &client,
                    json!({"commandId":"cmd","workspaceRoot":"C:/fixture","approvalMode":"allowAll"}),
                    Some("yolo"),
                )
                .await
            }
        });
        let first = fixture_frame(&mut frames).await;
        assert_eq!(first["method"], "session/start");
        assert_eq!(first["params"]["approvalMode"], "allowAll");
        client
            .ingest(json!({
                "jsonrpc": "2.0",
                "id": first["id"],
                "error": {
                    "code": -32030,
                    "message": "requested approval mode exceeds host ceiling",
                    "data": {"kind": "commandRejected", "reason": "approval_mode_ceiling", "retryable": false}
                }
            }))
            .await;
        let fallback = fixture_frame(&mut frames).await;
        assert_eq!(fallback["method"], "session/start");
        assert!(fallback["params"].get("approvalMode").is_none());
        client
            .ingest(json!({
                "jsonrpc": "2.0",
                "id": fallback["id"],
                "result": {"session": {"sessionId": "session-a", "approvalMode": {"mode": "promptUnmatched"}}}
            }))
            .await;
        let result = request.await.unwrap().unwrap();
        assert_eq!(result["session"]["sessionId"], "session-a");
    }

    #[test]
    fn initialize_capability_grants_are_bounded_and_cached_per_workspace() {
        let mut grants = HashMap::new();
        let root = PathBuf::from("C:/fixture");
        let result = json!({
            "grantedCapabilities": ["userShell", "", 42, "mcp", "userShell"]
        });
        assert_eq!(
            initialize_granted_capabilities(&result),
            Some(vec!["userShell".to_string(), "mcp".to_string(), "userShell".to_string()])
        );
        cache_initialize_granted_capabilities(&mut grants, &root, &result);
        assert_eq!(grants.get(&root).unwrap().len(), 3);
        cache_initialize_granted_capabilities(&mut grants, &root, &json!({}));
        assert!(!grants.contains_key(&root));
    }

    #[test]
    fn user_shell_payload_validates_identity_and_bounds_command_text() {
        let payload = user_shell_payload("session-a", "command-a", "echo ready").unwrap();
        assert_eq!(payload["sessionId"], "session-a");
        assert_eq!(payload["commandId"], "command-a");
        assert_eq!(payload["commandText"], "echo ready");
        assert!(user_shell_payload("", "command-a", "echo ready").is_err());
        assert!(user_shell_payload("session-a", "command-a", " ").is_err());
        let too_long = "x".repeat(MAX_USER_SHELL_COMMAND_CHARS + 1);
        assert!(user_shell_payload("session-a", "command-a", &too_long).is_err());
    }

    #[test]
    fn user_shell_deltas_use_the_tool_lane_and_keep_item_identity() {
        let state = empty_state();
        let mut events = Vec::new();
        let mut emit = |event: &str, sid: &str, kind: &str, payload: String| {
            events.push((event.to_string(), sid.to_string(), kind.to_string(), payload));
        };
        route_notification_with_emit(
            &state,
            "item/started",
            &json!({
                "sessionId": "session-a",
                "item": {"itemId":"shell-1", "kind":"userShell", "commandText":"git status"}
            }),
            &mut emit,
        );
        route_notification_with_emit(
            &state,
            "item/delta",
            &json!({"sessionId":"session-a","itemId":"shell-1","field":"output","delta":"clean"}),
            &mut emit,
        );
        let started = events.iter().find(|(_, _, kind, _)| kind == "item_started").unwrap();
        assert!(started.3.contains("git status"));
        let shell = events.iter().find(|(_, _, kind, _)| kind == "shell_output").unwrap();
        assert_eq!(shell.1, "session-a");
        assert!(shell.3.contains("shell-1"));
        assert!(events.iter().all(|(_, _, kind, _)| kind != "output"));
    }

    #[test]
    fn completed_user_shell_without_delta_is_replayed_once_and_closed() {
        let state = empty_state();
        let mut events = Vec::new();
        let mut emit = |event: &str, sid: &str, kind: &str, payload: String| {
            events.push((event.to_string(), sid.to_string(), kind.to_string(), payload));
        };
        let completed = json!({
            "sessionId": "session-a",
            "item": {
                "itemId": "shell-complete",
                "kind": "userShell",
                "commandText": "echo ready",
                "visibleOutput": "ready\n",
                "status": "completed"
            }
        });
        route_notification_with_emit(&state, "item/completed", &completed, &mut emit);
        route_notification_with_emit(&state, "item/updated", &completed, &mut emit);
        let shells = events.iter().filter(|(_, _, kind, _)| kind == "shell_output").collect::<Vec<_>>();
        assert_eq!(shells.len(), 1, "a repeated completed item must not duplicate output");
        assert!(shells[0].3.contains("ready"));
        assert!(events.iter().any(|(_, _, kind, payload)| {
            kind == "item_done" && payload.contains("shell-complete")
        }));
    }

    #[test]
    fn completed_reasoning_without_delta_uses_the_thinking_lane() {
        let state = empty_state();
        let mut events = Vec::new();
        let mut emit = |event: &str, sid: &str, kind: &str, payload: String| {
            events.push((event.to_string(), sid.to_string(), kind.to_string(), payload));
        };
        route_notification_with_emit(
            &state,
            "item/completed",
            &json!({
                "sessionId": "session-a",
                "item": {
                    "itemId": "reasoning-complete",
                    "kind": "reasoning",
                    "summary": ["inspect", "respond"],
                    "status": "completed"
                }
            }),
            &mut emit,
        );
        let thinking = events.iter().find(|(_, _, kind, _)| kind == "thinking").unwrap();
        let thinking_payload: Value = serde_json::from_str(&thinking.3).unwrap();
        assert_eq!(thinking_payload["text"], "inspect\n\nrespond");
        assert!(events.iter().all(|(_, _, kind, _)| kind != "output"));
    }

    #[test]
    fn fork_params_name_an_explicit_completed_turn() {
        let params = fork_request_params("cmd-1", "session-1", Some("turn-7"));
        assert_eq!(params["commandId"], "cmd-1");
        assert_eq!(params["sessionId"], "session-1");
        assert_eq!(params["excludeItems"], true);
        assert_eq!(params["cutPoint"]["lastTurnId"], "turn-7");
    }

    #[test]
    fn fork_params_omit_empty_cut_point_for_latest_turn() {
        let params = fork_request_params("cmd-1", "session-1", Some("  "));
        assert!(params.get("cutPoint").is_none());
    }

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
    fn session_approval_projection_accepts_host_shapes_and_ignores_empty_values() {
        assert_eq!(session_approval_mode(&json!({"approvalMode": "promptUnmatched"})), Some("promptUnmatched".into()));
        assert_eq!(session_approval_mode(&json!({"approval_mode": {"mode": "allowAll"}})), Some("allowAll".into()));
        assert_eq!(session_approval_mode(&json!({"approvalMode": {"mode": "onRequest"}})), Some("onRequest".into()));
        assert_eq!(session_approval_mode(&json!({"approvalMode": "  "})), None);
        assert_eq!(session_approval_mode(&json!({"approvalMode": {"mode": ""}})), None);
        assert_eq!(session_approval_mode(&json!({})), None);
    }

    #[test]
    fn approval_mode_ceiling_detection_is_specific_and_case_sensitive() {
        assert!(is_approval_mode_ceiling("MSP error: approval_mode_ceiling"));
        assert!(is_approval_mode_ceiling("command rejected (approval mode ceiling)"));
        assert!(!is_approval_mode_ceiling("approval required for this command"));
    }

    #[test]
    fn event_buffer_gap_is_reported_only_when_frames_were_dropped() {
        assert!(!event_buffer_gap(9, Some(10)));
        assert!(!event_buffer_gap(10, Some(10)));
        assert!(event_buffer_gap(9, Some(11)));
        assert!(!event_buffer_gap(99, None));
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
    fn initialize_durability_is_optional_but_preserves_explicit_host_fact() {
        assert_eq!(
            initialize_session_durability(&json!({"sessionDurability":"ephemeral"})),
            Some("ephemeral".to_string())
        );
        assert_eq!(
            initialize_session_durability(&json!({"sessionDurability":"  "})),
            None
        );
        assert_eq!(initialize_session_durability(&json!({})), None);
    }

    #[test]
    fn missing_durability_clears_the_previous_workspace_observation() {
        let root = PathBuf::from("C:/fixture");
        let mut facts = HashMap::new();
        cache_initialize_session_durability(
            &mut facts,
            &root,
            &json!({"sessionDurability":"ephemeral"}),
        );
        assert_eq!(facts.get(&root).map(String::as_str), Some("ephemeral"));
        cache_initialize_session_durability(&mut facts, &root, &json!({}));
        assert!(facts.get(&root).is_none());
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

    #[test]
    fn turn_input_parts_accept_text_and_bounded_image() {
        let valid = json!([
            {"type": "text", "text": "Review this"},
            {"type": "image", "mediaType": "image/png", "base64Data": "AQID"}
        ]);
        assert!(validate_turn_input_parts(&valid).is_ok());
    }

    #[test]
    fn turn_input_parts_reject_unknown_or_malformed_images() {
        let unknown = json!([{"type": "file", "path": "README.md"}]);
        assert!(validate_turn_input_parts(&unknown).is_err());
        let malformed = json!([
            {"type": "image", "mediaType": "image/png", "base64Data": "not-base64"}
        ]);
        assert!(validate_turn_input_parts(&malformed).is_err());
        let mismatched_dimensions = json!([
            {"type": "image", "mediaType": "image/png", "base64Data": "AQID", "width": 2}
        ]);
        assert!(validate_turn_input_parts(&mismatched_dimensions).is_err());
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
    fn native_browser_url_accepts_http_https_and_bare_hosts() {
        assert_eq!(
            validate_native_browser_url("https://example.com/docs")
                .unwrap()
                .scheme(),
            "https"
        );
        assert_eq!(
            validate_native_browser_url("example.com/docs")
                .unwrap()
                .as_str(),
            "https://example.com/docs"
        );
        assert_eq!(
            validate_native_browser_url("http://localhost:4173/")
                .unwrap()
                .host_str(),
            Some("localhost")
        );
    }

    #[test]
    fn native_browser_url_rejects_non_web_schemes_credentials_and_invalid_hosts() {
        for value in [
            "javascript:alert(1)",
            "file:///etc/passwd",
            "data:text/plain,hello",
            "https://user:password@example.com/",
            "https://",
            "   ",
        ] {
            assert!(validate_native_browser_url(value).is_err(), "accepted {value}");
        }
    }

    #[test]
    fn native_browser_url_is_bounded() {
        let value = format!("https://example.com/{}", "a".repeat(MAX_BROWSER_URL_CHARS));
        let error = validate_native_browser_url(&value).unwrap_err();
        assert!(error.contains("limited"));
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
        .plugin(tauri_plugin_notification::init())
        .manage(AppState {
            resume_mutex: tokio::sync::Mutex::new(()),
            hosts: Mutex::new(Hosts::default()),
            workspace: Mutex::new(None),
            sessions: Mutex::new(HashMap::new()),
            host_durability: Mutex::new(HashMap::new()),
            host_capabilities: Mutex::new(HashMap::new()),
            approvals: Mutex::new(HashMap::new()),
            item_kinds: Mutex::new(HashMap::new()),
            subagent_meta: Mutex::new(HashMap::new()),
            item_deltas_seen: Mutex::new(HashSet::new()),
            item_fallback_emitted: Mutex::new(HashSet::new()),
            host_mutex: tokio::sync::Mutex::new(()),
            event_seq: Mutex::new(0),
            event_buffer: Mutex::new(std::collections::VecDeque::new()),
            terminals: terminal::TerminalRegistry::default(),
            setup_cancellations: Mutex::new(HashMap::new()),
            mcp_servers: Arc::new(Mutex::new(HashMap::new())),
            workspace_watchers: Mutex::new(HashMap::new()),
        })
        .invoke_handler(tauri::generate_handler![
            start_session,
            fork_session,
            set_approval_mode,
            resume_session,
            read_session_history,
            read_queue_snapshot,
            list_pending_requests,
            restore_sessions,
            send_input,
            user_shell,
            unqueue_turn,
            steer_input,
            approve,
            answer_input,
            cancel_input,
            cancel_session,
            kill_session,
            set_workspace,
            check_scope,
            git_status,
            git_diff,
            git_stage,
            git_restore,
            git_apply_hunk,
            git_commit,
            git_push,
            git_create_pr,
            git_worktree_create,
            git_worktree_create_session,
            git_worktree_remove,
            git_worktree_inspect,
            worktree_setup_run,
            worktree_setup_readiness,
            worktree_setup_cancel,
            mcp_local_probe,
            mcp_local_call,
            mcp_local_start,
            mcp_local_refresh,
            mcp_local_poll,
            mcp_local_call_persistent,
            mcp_local_stop,
            mcp_local_running,
            skills_scan,
            skills_read_resources,
            terminal_open,
            terminal_write,
            terminal_resize,
            terminal_read,
            terminal_close,
            files_list,
            file_read,
            files_watch,
            files_unwatch,
            file_open,
            artifact_export,
            browser_download_write,
            browser_download_fetch,
            probe_startup,
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
            collect_diagnostics,
            open_native_browser,
        ])
        .build(tauri::generate_context!())
        .expect("failed to build muse-desktop app")
        .run(|app, event| {
            // Clean shutdown: kill every workspace sidecar so no `muse`
            // process survives app exit.
            if let RunEvent::Exit = event {
                let state: State<AppState> = app.state();
                state.terminals.close_all();
                if let Ok(active) = state.setup_cancellations.lock() {
                    for flag in active.values() {
                        flag.store(true, Ordering::Relaxed);
                    }
                }
                let clients = state.hosts.lock().map(|mut h| h.drain()).unwrap_or_default();
                for client in clients { tauri::async_runtime::block_on(client.shutdown()); }
                if let Ok(mut servers) = state.mcp_servers.lock() {
                    servers.clear();
                };
                if let Ok(mut watchers) = state.workspace_watchers.lock() {
                    watchers.clear();
                };
            }
        });
}
