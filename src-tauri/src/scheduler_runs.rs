//! Native persistence for the scheduled-run ledger.
//!
//! The renderer remains the SSOT for the live state machine. This module only
//! mirrors its bounded JSON snapshot under app data, with staging + rename so
//! a webview reload cannot leave a half-written ledger behind.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

pub const SCHEMA: &str = "muse-desktop.native-schedule-runs.v1";
pub const FILE_NAME: &str = "schedule-runs.json";
pub const MAX_BYTES: usize = 2 * 1024 * 1024;

fn ledger_path(dir: &Path) -> PathBuf {
    dir.join(FILE_NAME)
}

/// Read one native snapshot. A missing file is an empty ledger; malformed or
/// oversized data is rejected so the renderer can keep its last good copy.
pub fn read(dir: &Path) -> Result<Vec<u8>, String> {
    let path = ledger_path(dir);
    if !path.exists() {
        return Ok(format!(r#"{{"schema":"{SCHEMA}","runs":[]}}"#).into_bytes());
    }
    let bytes = fs::read(&path).map_err(|error| format!("could not read scheduler ledger: {error}"))?;
    if bytes.len() > MAX_BYTES {
        return Err(format!("scheduler ledger exceeds {MAX_BYTES} bytes"));
    }
    let value: serde_json::Value = serde_json::from_slice(&bytes)
        .map_err(|_| "scheduler ledger is not valid JSON".to_string())?;
    if value.get("schema").and_then(serde_json::Value::as_str) != Some(SCHEMA) ||
        !value.get("runs").is_some_and(serde_json::Value::is_array)
    {
        return Err("scheduler ledger has an unknown schema".to_string());
    }
    Ok(bytes)
}

/// Atomically replace the native snapshot after validating its envelope.
pub fn write(dir: &Path, payload: &str) -> Result<(), String> {
    if payload.as_bytes().len() > MAX_BYTES {
        return Err(format!("scheduler ledger exceeds {MAX_BYTES} bytes"));
    }
    let value: serde_json::Value = serde_json::from_str(payload)
        .map_err(|_| "scheduler ledger is not valid JSON".to_string())?;
    if value.get("schema").and_then(serde_json::Value::as_str) != Some(SCHEMA) ||
        !value.get("runs").is_some_and(serde_json::Value::is_array)
    {
        return Err("scheduler ledger has an unknown schema".to_string());
    }
    fs::create_dir_all(dir).map_err(|error| format!("could not create scheduler data directory: {error}"))?;
    let target = ledger_path(dir);
    let temp = dir.join(format!(".{FILE_NAME}.{}.tmp", std::process::id()));
    let result = (|| {
        let mut file = OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(&temp)
            .map_err(|error| format!("could not stage scheduler ledger: {error}"))?;
        file.write_all(payload.as_bytes())
            .map_err(|error| format!("could not write scheduler ledger: {error}"))?;
        file.sync_all()
            .map_err(|error| format!("could not flush scheduler ledger: {error}"))?;
        fs::rename(&temp, &target)
            .or_else(|_| {
                // Windows cannot replace an existing file with rename. The
                // target is in our private app-data directory, and the staged
                // file has already been fully flushed before this fallback.
                if target.exists() {
                    fs::remove_file(&target)?;
                }
                fs::rename(&temp, &target)
            })
            .map_err(|error| format!("could not commit scheduler ledger: {error}"))?;
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
        let path = std::env::temp_dir().join(format!("muse-scheduler-runs-{label}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn missing_ledger_is_empty_but_enveloped_writes_round_trip() {
        let dir = temp_dir("roundtrip");
        let empty = format!(r#"{{"schema":"{SCHEMA}","runs":[]}}"#);
        assert_eq!(String::from_utf8(read(&dir).unwrap()).unwrap(), empty);
        let payload = format!(r#"{{"schema":"{SCHEMA}","runs":[{{"id":"run-1"}}]}}"#);
        write(&dir, &payload).unwrap();
        assert_eq!(String::from_utf8(read(&dir).unwrap()).unwrap(), payload);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn malformed_or_unknown_envelope_is_rejected() {
        let dir = temp_dir("invalid");
        assert!(write(&dir, r#"{"schema":"wrong","runs":[]}"#).is_err());
        fs::write(ledger_path(&dir), r#"{"schema":"wrong","runs":[]}"#).unwrap();
        assert!(read(&dir).is_err());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn oversized_payload_is_rejected_before_disk_write() {
        let dir = temp_dir("large");
        let payload = "x".repeat(MAX_BYTES + 1);
        assert!(write(&dir, &payload).is_err());
        assert!(!ledger_path(&dir).exists());
        fs::remove_dir_all(dir).unwrap();
    }
}
