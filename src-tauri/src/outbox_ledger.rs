//! Native persistence for the renderer send outbox (M0-03).
//!
//! The hook remains the live SSOT and performs server verification before an
//! ambiguous retry. This file only mirrors bounded entries under app data so
//! a webview reload cannot erase the original prompt or idempotency key.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

pub const SCHEMA: &str = "muse-desktop.native-outbox.v1";
pub const FILE_NAME: &str = "outbox.json";
pub const MAX_BYTES: usize = 4 * 1024 * 1024;

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

fn ledger_path(dir: &Path) -> PathBuf {
    dir.join(FILE_NAME)
}

fn valid_envelope(value: &serde_json::Value) -> bool {
    value.get("schema").and_then(serde_json::Value::as_str) == Some(SCHEMA)
        && value
            .get("sessions")
            .is_some_and(serde_json::Value::is_object)
}

pub fn read(dir: &Path) -> Result<Vec<u8>, String> {
    let path = ledger_path(dir);
    if !path.exists() {
        return Ok(format!(r#"{{"schema":"{SCHEMA}","sessions":{{}}}}"#).into_bytes());
    }
    let bytes =
        fs::read(&path).map_err(|error| format!("could not read outbox ledger: {error}"))?;
    if bytes.len() > MAX_BYTES {
        return Err(format!("outbox ledger exceeds {MAX_BYTES} bytes"));
    }
    let value: serde_json::Value = serde_json::from_slice(&bytes)
        .map_err(|_| "outbox ledger is not valid JSON".to_string())?;
    if !valid_envelope(&value) {
        return Err("outbox ledger has an unknown schema".to_string());
    }
    Ok(bytes)
}

pub fn write(dir: &Path, payload: &str) -> Result<(), String> {
    if payload.len() > MAX_BYTES {
        return Err(format!("outbox ledger exceeds {MAX_BYTES} bytes"));
    }
    let value: serde_json::Value =
        serde_json::from_str(payload).map_err(|_| "outbox ledger is not valid JSON".to_string())?;
    if !valid_envelope(&value) {
        return Err("outbox ledger has an unknown schema".to_string());
    }
    fs::create_dir_all(dir)
        .map_err(|error| format!("could not create outbox data directory: {error}"))?;
    let target = ledger_path(dir);
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    let counter = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    let temp = dir.join(format!(
        ".{FILE_NAME}.{}-{nonce}-{counter}.tmp",
        std::process::id()
    ));
    let result = (|| {
        let mut file = OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(&temp)
            .map_err(|error| format!("could not stage outbox ledger: {error}"))?;
        file.write_all(payload.as_bytes())
            .map_err(|error| format!("could not write outbox ledger: {error}"))?;
        file.sync_all()
            .map_err(|error| format!("could not flush outbox ledger: {error}"))?;
        fs::rename(&temp, &target)
            .or_else(|_| {
                if target.exists() {
                    fs::remove_file(&target)?;
                }
                fs::rename(&temp, &target)
            })
            .map_err(|error| format!("could not commit outbox ledger: {error}"))?;
        Ok::<(), String>(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(label: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!("muse-outbox-{label}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn missing_and_valid_payload_round_trip() {
        let dir = temp_dir("roundtrip");
        let empty = format!(r#"{{"schema":"{SCHEMA}","sessions":{{}}}}"#);
        assert_eq!(String::from_utf8(read(&dir).unwrap()).unwrap(), empty);
        let payload = format!(r#"{{"schema":"{SCHEMA}","sessions":{{"session-1":[]}}}}"#);
        write(&dir, &payload).unwrap();
        assert_eq!(String::from_utf8(read(&dir).unwrap()).unwrap(), payload);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn malformed_envelope_and_oversized_payload_are_rejected() {
        let dir = temp_dir("invalid");
        assert!(write(&dir, r#"{"schema":"wrong","sessions":{}}"#).is_err());
        fs::write(ledger_path(&dir), r#"{"schema":"wrong","sessions":{}}"#).unwrap();
        assert!(read(&dir).is_err());
        let large = "x".repeat(MAX_BYTES + 1);
        assert!(write(&dir, &large).is_err());
        fs::remove_dir_all(dir).unwrap();
    }
}
