//! Native persistence for the in-app notification inbox.
//!
//! This is a durability mirror for the renderer SSOT. It deliberately stores
//! only the bounded notification envelope; OS delivery still depends on the
//! native notification service and app lifecycle.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

pub const SCHEMA: &str = "muse-desktop.native-notifications.v1";
pub const FILE_NAME: &str = "notifications.json";
pub const MAX_BYTES: usize = 1 * 1024 * 1024;

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

fn ledger_path(dir: &Path) -> PathBuf {
    dir.join(FILE_NAME)
}

pub fn read(dir: &Path) -> Result<Vec<u8>, String> {
    let path = ledger_path(dir);
    if !path.exists() {
        return Ok(format!(r#"{{"schema":"{SCHEMA}","notifications":[]}}"#).into_bytes());
    }
    let bytes = fs::read(&path).map_err(|error| format!("could not read notification ledger: {error}"))?;
    if bytes.len() > MAX_BYTES {
        return Err(format!("notification ledger exceeds {MAX_BYTES} bytes"));
    }
    let value: serde_json::Value = serde_json::from_slice(&bytes)
        .map_err(|_| "notification ledger is not valid JSON".to_string())?;
    if value.get("schema").and_then(serde_json::Value::as_str) != Some(SCHEMA) ||
        !value.get("notifications").is_some_and(serde_json::Value::is_array)
    {
        return Err("notification ledger has an unknown schema".to_string());
    }
    Ok(bytes)
}

pub fn write(dir: &Path, payload: &str) -> Result<(), String> {
    if payload.as_bytes().len() > MAX_BYTES {
        return Err(format!("notification ledger exceeds {MAX_BYTES} bytes"));
    }
    let value: serde_json::Value = serde_json::from_str(payload)
        .map_err(|_| "notification ledger is not valid JSON".to_string())?;
    if value.get("schema").and_then(serde_json::Value::as_str) != Some(SCHEMA) ||
        !value.get("notifications").is_some_and(serde_json::Value::is_array)
    {
        return Err("notification ledger has an unknown schema".to_string());
    }
    fs::create_dir_all(dir).map_err(|error| format!("could not create notification data directory: {error}"))?;
    let target = ledger_path(dir);
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    let counter = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    let temp = dir.join(format!(".{FILE_NAME}.{}-{nonce}-{counter}.tmp", std::process::id()));
    let result = (|| {
        let mut file = OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(&temp)
            .map_err(|error| format!("could not stage notification ledger: {error}"))?;
        file.write_all(payload.as_bytes())
            .map_err(|error| format!("could not write notification ledger: {error}"))?;
        file.sync_all()
            .map_err(|error| format!("could not flush notification ledger: {error}"))?;
        fs::rename(&temp, &target)
            .or_else(|_| {
                if target.exists() {
                    fs::remove_file(&target)?;
                }
                fs::rename(&temp, &target)
            })
            .map_err(|error| format!("could not commit notification ledger: {error}"))?;
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
        let path = std::env::temp_dir().join(format!("muse-notifications-{label}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn missing_ledger_is_enveloped_and_valid_payload_round_trips() {
        let dir = temp_dir("roundtrip");
        let empty = format!(r#"{{"schema":"{SCHEMA}","notifications":[]}}"#);
        assert_eq!(String::from_utf8(read(&dir).unwrap()).unwrap(), empty);
        write(&dir, &empty).unwrap();
        assert_eq!(String::from_utf8(read(&dir).unwrap()).unwrap(), empty);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn rejects_unknown_schema_and_oversized_payload() {
        let dir = temp_dir("invalid");
        assert!(write(&dir, r#"{"schema":"wrong","notifications":[]}"#).is_err());
        assert!(write(&dir, &"x".repeat(MAX_BYTES + 1)).is_err());
        fs::remove_dir_all(dir).unwrap();
    }
}
