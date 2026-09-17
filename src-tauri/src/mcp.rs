//! Small, explicit local MCP stdio client.
//!
//! Each probe/call is a short-lived process: initialize, exchange one
//! request, then terminate. This keeps credentials and subprocess state out
//! of the React store while still exercising the real MCP handshake and
//! tools/list/tools/call methods. The command is always supplied by an
//! explicit user gesture in the connector panel.

use serde::Serialize;
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

const MAX_COMMAND_CHARS: usize = 2_000;
const MAX_TOOL_NAME_CHARS: usize = 200;
const MAX_OUTPUT_CHARS: usize = 200_000;
const TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct McpTool {
    pub name: String,
    pub description: String,
    pub input_schema: Value,
}

#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProbeResult {
    pub protocol_version: String,
    pub server_name: String,
    pub server_version: String,
    pub tools: Vec<McpTool>,
    pub duration_ms: u64,
}

#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CallResult {
    pub tool_name: String,
    pub result: Value,
    pub is_error: bool,
    pub duration_ms: u64,
}

fn clip(value: String) -> String {
    if value.chars().count() <= MAX_OUTPUT_CHARS {
        return value;
    }
    let keep = value
        .chars()
        .rev()
        .take(MAX_OUTPUT_CHARS)
        .collect::<String>()
        .chars()
        .rev()
        .collect::<String>();
    format!("[MCP output clipped]\n{keep}")
}

fn bound_value(value: Value) -> Value {
    match serde_json::to_string(&value) {
        Ok(serialized) if serialized.chars().count() <= MAX_OUTPUT_CHARS => value,
        Ok(serialized) => Value::String(clip(serialized)),
        Err(_) => Value::String("[MCP result could not be serialized]".to_string()),
    }
}

fn spawn(command: &str, workspace: Option<&Path>) -> Result<Child, String> {
    let command = command.trim();
    if command.is_empty() {
        return Err("local MCP command must not be empty".to_string());
    }
    if command.chars().count() > MAX_COMMAND_CHARS {
        return Err(format!(
            "local MCP command is limited to {MAX_COMMAND_CHARS} characters"
        ));
    }
    let mut cmd = if cfg!(windows) {
        let mut c = Command::new("cmd");
        c.args(["/D", "/S", "/C", command]);
        c
    } else {
        let mut c = Command::new("sh");
        c.args(["-lc", command]);
        c
    };
    cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
    if let Some(root) = workspace {
        if !root.is_dir() {
            return Err(format!("MCP workspace is not a directory: {}", root.display()));
        }
        cmd.current_dir(root);
    }
    cmd.spawn()
        .map_err(|e| format!("could not start local MCP server: {e}"))
}

fn send(stdin: &mut ChildStdin, value: &Value) -> Result<(), String> {
    let bytes = serde_json::to_vec(value).map_err(|e| format!("MCP request encode failed: {e}"))?;
    write!(stdin, "Content-Length: {}\r\n\r\n", bytes.len())
        .and_then(|_| stdin.write_all(&bytes))
        .and_then(|_| stdin.flush())
        .map_err(|e| format!("MCP request write failed: {e}"))
}

fn read_framed<R: BufRead>(reader: &mut R) -> Result<Value, String> {
    let mut first = String::new();
    reader
        .read_line(&mut first)
        .map_err(|e| format!("MCP response read failed: {e}"))?;
    if first.is_empty() {
        return Err("local MCP server closed stdout before a response".to_string());
    }
    if first.to_ascii_lowercase().starts_with("content-length:") {
        let mut length: Option<usize> = first
            .split_once(':')
            .and_then(|(_, value)| value.trim().parse().ok());
        loop {
            let mut header = String::new();
            reader
                .read_line(&mut header)
                .map_err(|e| format!("MCP header read failed: {e}"))?;
            if header.trim().is_empty() {
                break;
            }
            if header.to_ascii_lowercase().starts_with("content-length:") {
                length = header
                    .split_once(':')
                    .and_then(|(_, value)| value.trim().parse().ok());
            }
        }
        let length = length.ok_or_else(|| "MCP response has an invalid Content-Length".to_string())?;
        if length > MAX_OUTPUT_CHARS {
            return Err("MCP response exceeds the 200000 character limit".to_string());
        }
        let mut bytes = vec![0; length];
        reader
            .read_exact(&mut bytes)
            .map_err(|e| format!("MCP framed body read failed: {e}"))?;
        serde_json::from_slice(&bytes).map_err(|e| format!("MCP response JSON invalid: {e}"))
    } else {
        serde_json::from_str(first.trim()).map_err(|e| format!("MCP response JSON invalid: {e}"))
    }
}

fn recv_response(
    rx: &mpsc::Receiver<Result<Value, String>>,
    started: Instant,
) -> Result<Value, String> {
    let remaining = TIMEOUT.saturating_sub(started.elapsed());
    rx.recv_timeout(remaining)
        .map_err(|_| "local MCP server timed out waiting for a response".to_string())?
}

fn begin(command: &str, workspace: Option<&Path>) -> Result<(Child, ChildStdin, mpsc::Receiver<Result<Value, String>>, Instant), String> {
    let mut child = spawn(command, workspace)?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "local MCP server stdin is unavailable".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "local MCP server stdout is unavailable".to_string())?;
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        loop {
            match read_framed(&mut reader) {
                Ok(value) => {
                    if tx.send(Ok(value)).is_err() {
                        break;
                    }
                }
                Err(error) => {
                    let _ = tx.send(Err(error));
                    break;
                }
            }
        }
    });
    let started = Instant::now();
    Ok((child, stdin, rx, started))
}

fn initialize(
    command: &str,
    workspace: Option<&Path>,
) -> Result<(Child, ChildStdin, mpsc::Receiver<Result<Value, String>>, Instant, String), String> {
    let (mut child, mut stdin, rx, started) = begin(command, workspace)?;
    let request = json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": "2025-06-18",
            "capabilities": {},
            "clientInfo": { "name": "muse-desktop", "version": "0.1.0" }
        }
    });
    if let Err(error) = send(&mut stdin, &request) {
        let _ = child.kill();
        return Err(error);
    }
    let response = match recv_response(&rx, started) {
        Ok(value) => value,
        Err(error) => {
            let _ = child.kill();
            return Err(error);
        }
    };
    if let Some(error) = response.get("error") {
        let _ = child.kill();
        return Err(format!("MCP initialize failed: {}", clip(error.to_string())));
    }
    let result = response
        .get("result")
        .ok_or_else(|| "MCP initialize response has no result".to_string())?;
    let protocol = result
        .get("protocolVersion")
        .and_then(Value::as_str)
        .unwrap_or("2025-06-18")
        .to_string();
    let server = result.get("serverInfo").cloned().unwrap_or(Value::Null);
    let server_name = server
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("local MCP server")
        .to_string();
    let server_version = server
        .get("version")
        .and_then(Value::as_str)
        .unwrap_or("unknown")
        .to_string();
    if let Err(error) = send(
        &mut stdin,
        &json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }),
    ) {
        let _ = child.kill();
        return Err(error);
    }
    Ok((child, stdin, rx, started, format!("{protocol}\u{0}{server_name}\u{0}{server_version}")))
}

fn decode_init(meta: &str) -> (String, String, String) {
    let mut parts = meta.split('\0');
    (
        parts.next().unwrap_or("2025-06-18").to_string(),
        parts.next().unwrap_or("local MCP server").to_string(),
        parts.next().unwrap_or("unknown").to_string(),
    )
}

fn request_after_init(
    mut child: Child,
    mut stdin: ChildStdin,
    rx: mpsc::Receiver<Result<Value, String>>,
    started: Instant,
    meta: String,
    method: &str,
    params: Value,
) -> Result<(Value, String, Instant), String> {
    let id = 2;
    if let Err(error) = send(
        &mut stdin,
        &json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }),
    ) {
        let _ = child.kill();
        return Err(error);
    }
    let response = recv_response(&rx, started);
    let _ = child.kill();
    let response = response?;
    if let Some(error) = response.get("error") {
        return Err(format!("MCP {method} failed: {}", clip(error.to_string())));
    }
    Ok((response.get("result").cloned().unwrap_or(Value::Null), meta, started))
}

fn parse_tools(result: &Value) -> Vec<McpTool> {
    result
        .get("tools")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|tool| {
            let name = tool.get("name")?.as_str()?.trim();
            if name.is_empty() || name.chars().count() > MAX_TOOL_NAME_CHARS {
                return None;
            }
            Some(McpTool {
                name: name.to_string(),
                description: tool
                    .get("description")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .chars()
                    .take(1_000)
                    .collect(),
                input_schema: bound_value(
                    tool.get("inputSchema").cloned().unwrap_or_else(|| json!({})),
                ),
            })
        })
        .take(500)
        .collect()
}

pub fn probe(command: &str, workspace: Option<&Path>) -> Result<ProbeResult, String> {
    let (child, stdin, rx, started, meta) = initialize(command, workspace)?;
    let (result, meta, started) = request_after_init(child, stdin, rx, started, meta, "tools/list", json!({}))?;
    let (protocol_version, server_name, server_version) = decode_init(&meta);
    Ok(ProbeResult {
        protocol_version,
        server_name,
        server_version,
        tools: parse_tools(&result),
        duration_ms: started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64,
    })
}

pub fn call(
    command: &str,
    workspace: Option<&Path>,
    tool_name: &str,
    arguments: Value,
) -> Result<CallResult, String> {
    let tool_name = tool_name.trim();
    if tool_name.is_empty() || tool_name.chars().count() > MAX_TOOL_NAME_CHARS {
        return Err("MCP tool name is empty or too long".to_string());
    }
    let arguments = if arguments.is_object() { arguments } else { json!({}) };
    let (child, stdin, rx, started, meta) = initialize(command, workspace)?;
    let (result, _meta, started) = request_after_init(
        child,
        stdin,
        rx,
        started,
        meta,
        "tools/call",
        json!({ "name": tool_name, "arguments": arguments }),
    )?;
    let is_error = result.get("isError").and_then(Value::as_bool).unwrap_or(false);
    Ok(CallResult {
        tool_name: tool_name.to_string(),
        result: bound_value(result),
        is_error,
        duration_ms: started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn parses_line_delimited_tools() {
        let value = parse_tools(&json!({
            "tools": [
                {"name":"read","description":"Read a file","inputSchema":{"type":"object"}},
                {"name":"","description":"ignored"},
                {"name":"write"}
            ]
        }));
        assert_eq!(value.len(), 2);
        assert_eq!(value[0].name, "read");
        assert_eq!(value[1].input_schema, json!({}));
    }

    #[test]
    fn reads_content_length_frames() {
        let body = br#"{"jsonrpc":"2.0","id":1,"result":{}}"#;
        let mut bytes = format!("Content-Length: {}\r\n\r\n", body.len()).into_bytes();
        bytes.extend_from_slice(body);
        let value = read_framed(&mut BufReader::new(Cursor::new(bytes))).unwrap();
        assert_eq!(value["id"], 1);
    }
}
