//! Minimal MSP client: JSON-RPC 2.0 frames over the `muse serve` stdio host.
//!
//! Wire facts (from `muse schema generate-ts`, stable surface):
//! - every frame carries `"jsonrpc": "2.0"`;
//! - requests have a client-chosen `id` (string or integer) and `method`;
//! - notifications have no `id` and are never answered;
//! - responses carry exactly one of `result` / `error`;
//! - params are camelCase (`sessionId`, `commandId`, ...), omitted when empty.
//!
//! Framing assumption: one frame per line (no raw newlines inside a frame —
//! `serde_json` escapes them). Verified against the schema's frame types;
//! a live handshake cannot run in this sandbox (the host needs provider
//! credentials), so the assumption is documented here, not proven.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};
use tauri_plugin_shell::process::CommandChild;
use tokio::sync::{mpsc, oneshot, Mutex};

/// JSON-RPC error object on a response frame.
#[derive(Debug, Clone)]
pub struct RpcError {
    pub code: i64,
    pub message: String,
}

impl std::fmt::Display for RpcError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "MSP error {}: {}", self.code, self.message)
    }
}

impl std::error::Error for RpcError {}

/// Mint a UUIDv7 idempotency handle (SS3.1.1): 48-bit unix-ms timestamp,
/// version nibble 7, 74 random bits, variant bits 10xxxxxx.
pub fn new_command_id() -> String {
    let ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let mut rand = [0u8; 10];
    // Best-effort randomness; collisions only risk duplicate idempotency keys.
    if let Ok(mut f) = std::fs::File::open("/dev/urandom") {
        use std::io::Read;
        let _ = f.read_exact(&mut rand);
    }
    let r = u128::from_be_bytes([
        0, 0, 0, 0, 0, 0, rand[0], rand[1], rand[2], rand[3], rand[4], rand[5], rand[6], rand[7],
        rand[8], rand[9],
    ]);
    let ts = (ms & 0xFFFF_FFFF_FFFF) as u128;
    let v = (ts << 80) | (7u128 << 76) | ((r >> 2) & 0x0FFF_FFFF_FFFF_FFFF) ;
    let v = (v & !(0b11u128 << 62)) | (0b10u128 << 62);
    let b = v.to_be_bytes();
    format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7], b[8], b[9], b[10], b[11], b[12], b[13],
        b[14], b[15]
    )
}

/// Encode one request frame (single line, no trailing newline).
pub fn encode_request(id: u64, method: &str, params: Value) -> String {
    let mut frame = json!({"jsonrpc": "2.0", "id": id, "method": method});
    if !params.is_null() {
        frame["params"] = params;
    }
    serde_json::to_string(&frame).unwrap_or_default()
}

/// Encode one notification frame (no `id`; never answered).
pub fn encode_notification(method: &str, params: Value) -> String {
    let mut frame = json!({"jsonrpc": "2.0", "method": method});
    if !params.is_null() {
        frame["params"] = params;
    }
    serde_json::to_string(&frame).unwrap_or_default()
}

/// Split a byte chunk into complete lines; returns leftover partial line.
pub fn split_lines(buf: &mut Vec<u8>, chunk: &[u8]) -> Vec<String> {
    buf.extend_from_slice(chunk);
    let mut lines = Vec::new();
    while let Some(pos) = buf.iter().position(|&b| b == b'\n') {
        let line: Vec<u8> = buf.drain(..=pos).collect();
        let text = String::from_utf8_lossy(&line[..line.len().saturating_sub(1)])
            .trim_end_matches('\r')
            .to_string();
        if !text.trim().is_empty() {
            lines.push(text);
        }
    }
    lines
}

/// Route one parsed frame: responses complete a pending request by id,
/// notifications go to the event channel.
pub fn route_frame(
    frame: Value,
    pending: &mut HashMap<String, oneshot::Sender<Result<Value, RpcError>>>,
    notify_tx: &mpsc::UnboundedSender<(String, Value)>,
) {
    if let Some(id) = frame.get("id") {
        let key = id.to_string();
        if let Some(tx) = pending.remove(&key) {
            let out = if let Some(err) = frame.get("error") {
                Err(RpcError {
                    code: err.get("code").and_then(Value::as_i64).unwrap_or(-1),
                    message: err
                        .get("message")
                        .and_then(Value::as_str)
                        .unwrap_or("unknown error")
                        .to_string(),
                })
            } else {
                Ok(frame.get("result").cloned().unwrap_or(Value::Null))
            };
            let _ = tx.send(out);
        }
        return;
    }
    if let Some(method) = frame.get("method").and_then(Value::as_str) {
        let params = frame.get("params").cloned().unwrap_or(Value::Null);
        let _ = notify_tx.send((method.to_string(), params));
    }
}

/// The sidecar child, shared between the request writer (needs `&mut` for
/// `write`) and the owner (needs ownership for `kill`, which consumes).
pub type SharedChild = Arc<Mutex<Option<CommandChild>>>;

/// Live handle to one `muse serve` host process.
pub struct MspClient {
    child: SharedChild,
    next_id: AtomicU64,
    pending: Arc<Mutex<HashMap<String, oneshot::Sender<Result<Value, RpcError>>>>>,
    notify_tx: mpsc::UnboundedSender<(String, Value)>,
}

impl MspClient {
    pub fn new(
        child: SharedChild,
        notify_tx: mpsc::UnboundedSender<(String, Value)>,
    ) -> Self {
        Self {
            child,
            next_id: AtomicU64::new(1),
            pending: Arc::new(Mutex::new(HashMap::new())),
            notify_tx,
        }
    }

    /// Feed one parsed frame from the host's stdout into response routing
    /// (by id) or the notification channel (by method).
    pub async fn ingest(&self, frame: Value) {
        let mut pending = self.pending.lock().await;
        route_frame(frame, &mut pending, &self.notify_tx);
    }

    async fn remove_pending(&self, key: &str) {
        self.pending.lock().await.remove(key);
    }

    async fn write_line(&self, mut line: String) -> Result<(), String> {
        line.push('\n');
        let mut guard = self.child.lock().await;
        let child = guard
            .as_mut()
            .ok_or_else(|| "sidecar is gone (nowhere to write)".to_string())?;
        child
            .write(line.as_bytes())
            .map_err(|e| format!("sidecar write failed: {e}"))
    }

    /// Send a notification (MCP-style `initialized` included): no id, no reply.
    pub async fn notify(&self, method: &str, params: Value) -> Result<(), String> {
        self.write_line(encode_notification(method, params)).await
    }

    /// Send a request and wait for its response (120s cap: model turns ack fast;
    /// a missing response is a broken host, not a slow one).
    pub async fn request(&self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let key = id.to_string();
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(key.clone(), tx);
        if let Err(e) = self
            .write_line(encode_request(id, method, params))
            .await
        {
            self.remove_pending(&key).await;
            return Err(format!("sidecar write failed for {method}: {e}"));
        }
        match tokio::time::timeout(std::time::Duration::from_secs(120), rx).await {
            Ok(Ok(Ok(v))) => Ok(v),
            Ok(Ok(Err(e))) => Err(e.to_string()),
            Ok(Err(_)) => Err("sidecar dropped the response".to_string()),
            Err(_) => {
                self.remove_pending(&key).await;
                Err(format!("MSP request timed out: {method}"))
            }
        }
    }

    /// Kill the host process. One-way door: the owner builds a fresh client
    /// on respawn, so a killed client is never reused.
    pub async fn shutdown(&self) {
        let child = self.child.lock().await.take();
        if let Some(c) = child {
            let _ = c.kill();
        }
        // Fail every in-flight request so callers do not hang on a dead host.
        let mut pending = self.pending.lock().await;
        pending.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_ids_look_like_uuidv7() {
        let a = new_command_id();
        let b = new_command_id();
        assert_ne!(a, b);
        assert_eq!(a.len(), 36);
        assert_eq!(&a[14..15], "7", "version nibble must be 7: {a}");
        assert!(matches!(&a[19..20], "8" | "9" | "a" | "b"), "variant bits: {a}");
    }

    #[test]
    fn notification_frame_shape() {
        let f: Value = serde_json::from_str(&encode_notification("initialized", Value::Null)).unwrap();
        assert_eq!(f["jsonrpc"], "2.0");
        assert_eq!(f["method"], "initialized");
        assert!(f.get("id").is_none());
        assert!(f.get("params").is_none());
    }

    #[test]
    fn request_frame_shape() {
        let f: Value = serde_json::from_str(&encode_request(
            3,
            "session/start",
            json!({"commandId": "x", "workspaceRoot": "/tmp"}),
        ))
        .unwrap();
        assert_eq!(f["jsonrpc"], "2.0");
        assert_eq!(f["id"], 3);
        assert_eq!(f["method"], "session/start");
        assert_eq!(f["params"]["commandId"], "x");
        assert!(!encode_request(4, "model/list", Value::Null).contains("params"));
    }

    #[test]
    fn split_lines_buffers_partials() {
        let mut buf = Vec::new();
        assert!(split_lines(&mut buf, b"{\"a\":1").is_empty());
        let out = split_lines(&mut buf, b"}\n{\"b\":2}\n");
        assert_eq!(out, vec!["{\"a\":1}".to_string(), "{\"b\":2}".to_string()]);
        assert!(buf.is_empty());
    }

    #[tokio::test]
    async fn route_response_completes_pending() {
        let (tx, rx) = oneshot::channel();
        let mut pending = HashMap::new();
        pending.insert("7".to_string(), tx);
        let (ntx, _nrx) = mpsc::unbounded_channel();
        route_frame(json!({"jsonrpc":"2.0","id":7,"result":{"ok":true}}), &mut pending, &ntx);
        assert!(pending.is_empty());
        assert_eq!(rx.await.unwrap().unwrap()["ok"], true);
    }

    #[tokio::test]
    async fn route_error_and_notification() {
        let (tx, rx) = oneshot::channel();
        let mut pending = HashMap::new();
        pending.insert("8".to_string(), tx);
        let (ntx, mut nrx) = mpsc::unbounded_channel();
        route_frame(
            json!({"jsonrpc":"2.0","id":8,"error":{"code":-32052,"message":"stale"}}),
            &mut pending,
            &ntx,
        );
        assert!(rx.await.unwrap().unwrap_err().code == -32052);
        route_frame(
            json!({"jsonrpc":"2.0","method":"turn/completed","params":{"terminal":"cancelled"}}),
            &mut pending,
            &ntx,
        );
        let (m, p) = nrx.recv().await.unwrap();
        assert_eq!(m, "turn/completed");
        assert_eq!(p["terminal"], "cancelled");
    }
}
