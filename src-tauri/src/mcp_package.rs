//! Native, atomic installation of validated MCP bundle files.
//!
//! The renderer parses the `.mcpb` zip and sends only bounded, validated
//! relative files here.  The native side owns the durable location under the
//! app data directory and never executes a package during installation.  A
//! caller must still perform a real MCP initialize/tools/list probe before
//! registering the package in the renderer connector SSOT.

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

const MAX_FILES: usize = 256;
const MAX_FILE_BYTES: usize = 4 * 1024 * 1024;
const MAX_TOTAL_BYTES: usize = 16 * 1024 * 1024;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageFileInput {
    pub path: String,
    pub base64_data: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageInstallResult {
    pub install_root: String,
    pub file_count: usize,
    pub total_bytes: usize,
}

fn safe_segment(raw: &str, label: &str) -> Result<String, String> {
    let value = raw.trim();
    if value.is_empty() || value.len() > 120 || value.contains('\0') ||
        value.contains('/') || value.contains('\\') || value == "." || value == ".." ||
        !value.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.')) {
        return Err(format!("MCP package {label} is invalid"));
    }
    Ok(value.to_string())
}

fn safe_relative_path(raw: &str) -> Result<PathBuf, String> {
    let value = raw.trim().replace('\\', "/");
    if value.is_empty() || value.len() > 400 || value.contains('\0') || value.starts_with('/') ||
        value.contains(":/") {
        return Err("MCP package file path must be relative".to_string());
    }
    let path = Path::new(&value);
    if path.components().any(|component| {
        matches!(component, Component::ParentDir | Component::RootDir | Component::Prefix(_))
    }) {
        return Err("MCP package file path escapes its install directory".to_string());
    }
    if path.components().any(|component| {
        matches!(component, Component::CurDir) || component.as_os_str().is_empty()
    }) {
        return Err("MCP package file path contains an empty segment".to_string());
    }
    Ok(path.to_path_buf())
}

fn package_root(app: &AppHandle, package_id: &str, version: &str) -> Result<PathBuf, String> {
    let id = safe_segment(package_id, "id")?;
    let version = safe_segment(version, "version")?;
    let base = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("cannot resolve app data directory: {error}"))?;
    Ok(base.join("mcp-packages").join(id).join(version))
}

/// Install one package revision. Existing revisions are immutable so a
/// rollback can always point at the previous root without copying files.
pub fn install(
    app: &AppHandle,
    package_id: &str,
    version: &str,
    files: Vec<PackageFileInput>,
) -> Result<PackageInstallResult, String> {
    if files.is_empty() || files.len() > MAX_FILES {
        return Err(format!("MCP package must contain between 1 and {MAX_FILES} files"));
    }
    let root = package_root(app, package_id, version)?;
    if root.exists() {
        return Err("this MCP package version is already installed".to_string());
    }
    let parent = root
        .parent()
        .ok_or_else(|| "MCP package install path has no parent".to_string())?;
    fs::create_dir_all(parent).map_err(|error| format!("cannot create MCP package directory: {error}"))?;
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    let stage = parent.join(format!(".stage-{}-{nonce}", std::process::id()));
    fs::create_dir_all(&stage).map_err(|error| format!("cannot create MCP package staging directory: {error}"))?;
    let result = (|| {
        let mut total = 0usize;
        for file in files.iter() {
            let relative = safe_relative_path(&file.path)?;
            let decoded = base64::engine::general_purpose::STANDARD
                .decode(file.base64_data.as_bytes())
                .map_err(|_| format!("MCP package file {} is not valid base64", file.path))?;
            if decoded.len() > MAX_FILE_BYTES {
                return Err(format!("MCP package file {} is too large", file.path));
            }
            total = total.saturating_add(decoded.len());
            if total > MAX_TOTAL_BYTES {
                return Err("MCP package contents exceed the size limit".to_string());
            }
            let target = stage.join(relative);
            if target.exists() {
                return Err(format!("MCP package contains duplicate path {}", file.path));
            }
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent).map_err(|error| format!("cannot create MCP package file directory: {error}"))?;
            }
            fs::write(target, decoded).map_err(|error| format!("cannot write MCP package file: {error}"))?;
        }
        fs::rename(&stage, &root).map_err(|error| format!("cannot commit MCP package atomically: {error}"))?;
        Ok(PackageInstallResult {
            install_root: root.to_string_lossy().into_owned(),
            file_count: files.len(),
            total_bytes: total,
        })
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(&stage);
    }
    result
}

/// Remove one package revision after a failed probe or explicit uninstall.
pub fn remove(app: &AppHandle, package_id: &str, version: &str) -> Result<bool, String> {
    let root = package_root(app, package_id, version)?;
    if !root.exists() {
        return Ok(false);
    }
    fs::remove_dir_all(root).map_err(|error| format!("cannot remove MCP package: {error}"))?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::{safe_relative_path, safe_segment};

    #[test]
    fn paths_stay_relative() {
        assert!(safe_relative_path("server/index.js").is_ok());
        assert!(safe_relative_path("../escape").is_err());
        assert!(safe_relative_path("/absolute").is_err());
        assert!(safe_relative_path("C:/absolute").is_err());
    }

    #[test]
    fn ids_are_path_safe() {
        assert!(safe_segment("mcpb-demo", "id").is_ok());
        assert!(safe_segment("demo/version", "version").is_err());
        assert!(safe_segment("..", "version").is_err());
    }
}
