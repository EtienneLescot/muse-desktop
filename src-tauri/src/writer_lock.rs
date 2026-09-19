//! Cross-process writer leases for orchestration targets.
//!
//! MSP does not define a writer/file-lock RPC. Muse therefore keeps an OS
//! advisory lock per declared target path. The lock is held by a live file
//! descriptor, so a crashed process releases it automatically; the metadata
//! file is only a bounded diagnostic and never grants access by itself.

use fs2::FileExt;
use serde::Serialize;
use serde_json::json;
use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

const MAX_PATHS: usize = 80;
const MAX_PATH_CHARS: usize = 240;
const MAX_AGENT_CHARS: usize = 160;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Conflict {
    pub agent: String,
    pub target_path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcquireResponse {
    pub granted: bool,
    pub token: Option<String>,
    pub conflicts: Vec<Conflict>,
}

struct Lease {
    files: Vec<(String, PathBuf, File)>,
}

pub struct Registry {
    leases: Mutex<HashMap<String, Lease>>,
}

impl Default for Registry {
    fn default() -> Self {
        Self {
            leases: Mutex::new(HashMap::new()),
        }
    }
}

fn normalize_workspace(value: &str) -> Result<PathBuf, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err("workspace must not be empty".to_string());
    }
    let path = fs::canonicalize(trimmed)
        .map_err(|error| format!("workspace cannot be resolved: {error}"))?;
    if !path.is_dir() {
        return Err("workspace must be a directory".to_string());
    }
    Ok(path)
}

fn normalize_target(value: &str) -> Result<String, String> {
    let mut path = value.trim().replace('\\', "/");
    while path.starts_with("./") {
        path = path[2..].to_string();
    }
    while path.ends_with('/') {
        path.pop();
    }
    if path.is_empty() || path.len() > MAX_PATH_CHARS || path.starts_with('/') || path.contains(':')
    {
        return Err("target paths must be bounded relative paths".to_string());
    }
    let parts: Vec<&str> = path.split('/').collect();
    if parts
        .iter()
        .any(|part| part.is_empty() || *part == "." || *part == "..")
    {
        return Err("target paths may not contain traversal segments".to_string());
    }
    Ok(parts.join("/").to_ascii_lowercase())
}

fn targets(values: &[String]) -> Result<Vec<String>, String> {
    if values.is_empty() {
        return Err("at least one target path is required".to_string());
    }
    let mut result = Vec::new();
    for value in values.iter().take(MAX_PATHS) {
        let normalized = normalize_target(value)?;
        if !result.contains(&normalized) {
            result.push(normalized);
        }
    }
    if result.is_empty() {
        return Err("at least one valid target path is required".to_string());
    }
    Ok(result)
}

fn fnv_hex(value: &str) -> String {
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in value.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}

fn lock_path(workspace: &Path, target: &str) -> PathBuf {
    let workspace_key = fnv_hex(&workspace.to_string_lossy().to_ascii_lowercase());
    let target_key = fnv_hex(target);
    std::env::temp_dir()
        .join("muse-desktop-writer-locks")
        .join(workspace_key)
        .join(format!("{target_key}.lock"))
}

fn read_agent(file: &mut File) -> String {
    let _ = file.seek(SeekFrom::Start(0));
    let mut raw = String::new();
    let _ = file.read_to_string(&mut raw);
    serde_json::from_str::<serde_json::Value>(&raw)
        .ok()
        .and_then(|value| {
            value
                .get("agent")
                .and_then(serde_json::Value::as_str)
                .map(str::to_string)
        })
        .unwrap_or_else(|| "another Muse process".to_string())
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// Acquire all target locks in deterministic order. Partial acquisitions are
/// immediately released when one path is busy, so callers never hold a
/// misleading subset of their declared targets.
pub fn acquire(
    registry: &Registry,
    workspace: &str,
    agent: &str,
    requested_targets: &[String],
    owner_id: &str,
) -> Result<AcquireResponse, String> {
    let workspace_path = normalize_workspace(workspace)?;
    let workspace_key = workspace_path.to_string_lossy().to_string();
    let safe_agent = agent
        .trim()
        .chars()
        .take(MAX_AGENT_CHARS)
        .collect::<String>();
    let safe_owner = owner_id.trim().chars().take(160).collect::<String>();
    if safe_agent.is_empty() || safe_owner.is_empty() {
        return Err("agent and ownerId are required".to_string());
    }
    let mut target_list = targets(requested_targets)?;
    target_list.sort();

    let mut opened: Vec<(String, PathBuf, File)> = Vec::new();
    let mut conflicts = Vec::new();
    for target in &target_list {
        let path = lock_path(&workspace_path, target);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("writer lock directory failed: {e}"))?;
        }
        let mut file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .open(&path)
            .map_err(|e| format!("writer lock open failed: {e}"))?;
        if let Err(_error) = file.try_lock_exclusive() {
            conflicts.push(Conflict {
                agent: read_agent(&mut file),
                target_path: target.clone(),
            });
            let _ = file.unlock();
            break;
        }
        opened.push((target.clone(), path, file));
    }
    if !conflicts.is_empty() {
        for (_, path, file) in opened {
            let _ = file.unlock();
            let _ = fs::remove_file(path);
        }
        return Ok(AcquireResponse {
            granted: false,
            token: None,
            conflicts,
        });
    }

    let token = format!(
        "{safe_owner}-{}",
        fnv_hex(&format!("{workspace_key}:{safe_agent}:{:?}", target_list))
    );
    for (_, _, file) in &mut opened {
        file.set_len(0)
            .map_err(|e| format!("writer lock metadata failed: {e}"))?;
        file.seek(SeekFrom::Start(0))
            .map_err(|e| format!("writer lock metadata seek failed: {e}"))?;
        let payload = serde_json::to_vec(
            &json!({ "agent": safe_agent, "ownerId": safe_owner, "acquiredAt": now_ms() }),
        )
        .map_err(|e| format!("writer lock metadata encode failed: {e}"))?;
        file.write_all(&payload)
            .map_err(|e| format!("writer lock metadata write failed: {e}"))?;
        file.flush()
            .map_err(|e| format!("writer lock metadata flush failed: {e}"))?;
    }
    registry
        .leases
        .lock()
        .map_err(|_| "writer lock registry unavailable".to_string())?
        .insert(token.clone(), Lease { files: opened });
    Ok(AcquireResponse {
        granted: true,
        token: Some(token),
        conflicts,
    })
}

pub fn release(registry: &Registry, token: &str) -> Result<bool, String> {
    let lease = registry
        .leases
        .lock()
        .map_err(|_| "writer lock registry unavailable".to_string())?
        .remove(token);
    let Some(lease) = lease else {
        return Ok(false);
    };
    for (_, path, file) in lease.files {
        let _ = file.unlock();
        let _ = fs::remove_file(path);
    }
    Ok(true)
}

pub fn release_all(registry: &Registry) {
    let tokens = registry
        .leases
        .lock()
        .map(|leases| leases.keys().cloned().collect::<Vec<_>>())
        .unwrap_or_default();
    for token in tokens {
        let _ = release(registry, &token);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn second_registry_conflicts_and_release_reopens_path() {
        let root =
            std::env::temp_dir().join(format!("muse-writer-lock-test-{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        let first = Registry::default();
        let second = Registry::default();
        let workspace = root.to_string_lossy().to_string();
        let paths = vec!["src/App.tsx".to_string()];
        let a = acquire(&first, &workspace, "a", &paths, "owner-a").unwrap();
        assert!(a.granted);
        let b = acquire(&second, &workspace, "b", &paths, "owner-b").unwrap();
        assert!(!b.granted);
        assert_eq!(b.conflicts[0].target_path, "src/app.tsx");
        release(&first, a.token.as_deref().unwrap()).unwrap();
        let c = acquire(&second, &workspace, "b", &paths, "owner-c").unwrap();
        assert!(c.granted);
        release(&second, c.token.as_deref().unwrap()).unwrap();
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn rejects_traversal_and_empty_targets() {
        let root =
            std::env::temp_dir().join(format!("muse-writer-lock-test-{}-bad", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        let registry = Registry::default();
        let workspace = root.to_string_lossy().to_string();
        assert!(acquire(&registry, &workspace, "a", &[], "owner").is_err());
        assert!(acquire(
            &registry,
            &workspace,
            "a",
            &["../secret".to_string()],
            "owner"
        )
        .is_err());
        let _ = fs::remove_dir_all(root);
    }
}
