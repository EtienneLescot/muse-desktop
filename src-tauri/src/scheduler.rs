//! Native scheduler lease shared by separate Muse-Desktop processes.
//!
//! The renderer already has a small localStorage lease for multiple windows.
//! A file held open by the native process extends the same invariant to two
//! independently launched app processes: only one process may admit a due
//! occurrence at a time, and a crashed process releases the OS handle.
//!
//! This module is deliberately only a lease. It does not execute prompts or
//! start hosts in the background; those operations still require the explicit
//! session and authorization contracts owned by the renderer/sidecar.

use serde::{Deserialize, Serialize};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

pub const SCHEMA: &str = "muse-desktop.native-scheduler-lease.v1";
const LEASE_FILE: &str = "scheduler-lease.lock";
const MIN_TTL_MS: u64 = 5_000;
const MAX_TTL_MS: u64 = 120_000;
const MAX_OWNER_CHARS: usize = 120;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LeaseRecord {
    pub schema: String,
    pub owner_id: String,
    pub expires_at: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LeaseResponse {
    pub schema: String,
    pub acquired: bool,
    pub owner_id: Option<String>,
    pub expires_at: Option<u64>,
    pub native: bool,
}

/// The open handle is the process-level lock. Keep it in AppState for the
/// lifetime of the claim; dropping it is the crash-safe release path.
pub struct NativeLease {
    path: PathBuf,
    record: LeaseRecord,
    file: File,
}

pub enum ClaimOutcome {
    Acquired(NativeLease),
    Blocked(LeaseRecord),
}

impl std::fmt::Debug for NativeLease {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("NativeLease")
            .field("path", &self.path)
            .field("record", &self.record)
            .finish_non_exhaustive()
    }
}

fn bounded_owner(owner_id: &str) -> Result<String, String> {
    let owner = owner_id.trim();
    if owner.is_empty() {
        return Err("scheduler lease owner is empty".to_string());
    }
    if owner.chars().count() > MAX_OWNER_CHARS {
        return Err(format!(
            "scheduler lease owner exceeds {MAX_OWNER_CHARS} characters"
        ));
    }
    Ok(owner.to_string())
}

fn bounded_ttl(ttl_ms: u64) -> u64 {
    ttl_ms.clamp(MIN_TTL_MS, MAX_TTL_MS)
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(u128::from(u64::MAX)) as u64)
        .unwrap_or(0)
}

fn lease_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join(LEASE_FILE)
}

fn read_record(path: &Path) -> Option<LeaseRecord> {
    let mut file = File::open(path).ok()?;
    let mut raw = String::new();
    file.read_to_string(&mut raw).ok()?;
    let record = serde_json::from_str::<LeaseRecord>(&raw).ok()?;
    if record.schema != SCHEMA || record.owner_id.is_empty() || record.expires_at == 0 {
        return None;
    }
    Some(record)
}

fn write_record(file: &mut File, record: &LeaseRecord) -> Result<(), String> {
    let raw = serde_json::to_vec(record)
        .map_err(|error| format!("scheduler lease encode failed: {error}"))?;
    file.set_len(0)
        .map_err(|error| format!("scheduler lease truncate failed: {error}"))?;
    file.seek(SeekFrom::Start(0))
        .map_err(|error| format!("scheduler lease seek failed: {error}"))?;
    file.write_all(&raw)
        .map_err(|error| format!("scheduler lease write failed: {error}"))?;
    file.sync_all()
        .map_err(|error| format!("scheduler lease flush failed: {error}"))?;
    Ok(())
}

fn response(record: Option<&LeaseRecord>, acquired: bool) -> LeaseResponse {
    LeaseResponse {
        schema: SCHEMA.to_string(),
        acquired,
        owner_id: record.map(|value| value.owner_id.clone()),
        expires_at: record.map(|value| value.expires_at),
        native: true,
    }
}

/// Try to claim the process-level lease. An expired record may be removed and
/// retried; the open handle acquired by `create_new` is the actual lock.
pub fn claim(
    app_data_dir: &Path,
    owner_id: &str,
    now: u64,
    ttl_ms: u64,
) -> Result<ClaimOutcome, String> {
    let owner = bounded_owner(owner_id)?;
    if now == 0 {
        return Err("scheduler lease time is invalid".to_string());
    }
    fs::create_dir_all(app_data_dir)
        .map_err(|error| format!("scheduler lease directory unavailable: {error}"))?;
    let path = lease_path(app_data_dir);
    let expires_at = now.saturating_add(bounded_ttl(ttl_ms));
    for attempt in 0..2 {
        match OpenOptions::new()
            .create_new(true)
            .read(true)
            .write(true)
            .open(&path)
        {
            Ok(mut file) => {
                let record = LeaseRecord {
                    schema: SCHEMA.to_string(),
                    owner_id: owner.clone(),
                    expires_at,
                };
                if let Err(error) = write_record(&mut file, &record) {
                    drop(file);
                    let _ = fs::remove_file(&path);
                    return Err(error);
                }
                let lease = NativeLease { path, record, file };
                return Ok(ClaimOutcome::Acquired(lease));
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists && attempt == 0 => {
                let Some(current) = read_record(&path) else {
                    // A creator may still be writing the record, or a prior
                    // build may have left an unknown schema. Never delete an
                    // unreadable lock: fail closed and let the next tick
                    // retry after the owner has finished writing.
                    return Err("scheduler lease record is unreadable; retry later".to_string());
                };
                if current.expires_at > now {
                    return Ok(ClaimOutcome::Blocked(current));
                }
                // An expired file can be left behind after a process crash.
                // On Windows an active owner normally prevents this remove;
                // in that case the next claim remains safely rejected.
                if fs::remove_file(&path).is_err() {
                    return Err("scheduler lease is expired but cannot be replaced".to_string());
                }
            }
            Err(error) => return Err(format!("scheduler lease claim failed: {error}")),
        }
    }
    Err("scheduler lease claim could not be completed".to_string())
}

impl NativeLease {
    pub fn owner_id(&self) -> &str {
        &self.record.owner_id
    }

    pub fn expires_at(&self) -> u64 {
        self.record.expires_at
    }

    pub fn response(&self) -> LeaseResponse {
        response(Some(&self.record), true)
    }

    pub fn renew(
        &mut self,
        owner_id: &str,
        now: u64,
        ttl_ms: u64,
    ) -> Result<LeaseResponse, String> {
        let owner = bounded_owner(owner_id)?;
        if owner != self.record.owner_id {
            return Err("scheduler lease belongs to another owner".to_string());
        }
        if now == 0 || self.record.expires_at <= now {
            return Err("scheduler lease has expired".to_string());
        }
        self.record.expires_at = now.saturating_add(bounded_ttl(ttl_ms));
        write_record(&mut self.file, &self.record)?;
        Ok(response(Some(&self.record), true))
    }

    pub fn release(self) {
        let path = self.path.clone();
        drop(self);
        let _ = fs::remove_file(path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(label: &str) -> PathBuf {
        let path =
            std::env::temp_dir().join(format!("muse-scheduler-{label}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn claim_is_exclusive_and_release_allows_next_owner() {
        let dir = temp_dir("exclusive");
        let lease = match claim(&dir, "one", 10_000, 30_000).unwrap() {
            ClaimOutcome::Acquired(lease) => lease,
            ClaimOutcome::Blocked(_) => panic!("first claim should acquire"),
        };
        let blocked = match claim(&dir, "two", 10_001, 30_000).unwrap() {
            ClaimOutcome::Blocked(record) => record,
            ClaimOutcome::Acquired(_) => panic!("second claim should be blocked"),
        };
        assert_eq!(blocked.owner_id, "one");
        lease.release();
        let second = match claim(&dir, "two", 10_002, 30_000).unwrap() {
            ClaimOutcome::Acquired(lease) => lease,
            ClaimOutcome::Blocked(_) => panic!("released claim should acquire"),
        };
        second.release();
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn expired_record_can_be_reclaimed() {
        let dir = temp_dir("expired");
        let lease = match claim(&dir, "one", 10_000, 5_000).unwrap() {
            ClaimOutcome::Acquired(lease) => lease,
            ClaimOutcome::Blocked(_) => panic!("first claim should acquire"),
        };
        // Simulate the crashed owner by dropping the handle without removing
        // its file; claim removes the expired record and creates a new lock.
        drop(lease);
        let next = match claim(&dir, "two", 20_000, 5_000).unwrap() {
            ClaimOutcome::Acquired(lease) => lease,
            ClaimOutcome::Blocked(_) => panic!("expired claim should be reclaimable"),
        };
        next.release();
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn renew_rejects_expired_or_different_owner() {
        let dir = temp_dir("renew");
        let mut lease = match claim(&dir, "one", 10_000, 30_000).unwrap() {
            ClaimOutcome::Acquired(lease) => lease,
            ClaimOutcome::Blocked(_) => panic!("first claim should acquire"),
        };
        assert!(lease.renew("two", 10_001, 30_000).is_err());
        assert!(lease.renew("one", 40_001, 30_000).is_err());
        lease.release();
        let _ = fs::remove_dir_all(dir);
    }
}
