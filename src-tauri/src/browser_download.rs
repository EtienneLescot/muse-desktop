//! Explicit browser link downloads.
//!
//! The renderer fetches a same-origin link only after an explicit user action
//! and chooses the destination through the native save dialog. This module is
//! the final trust boundary: it validates the absolute destination, decodes
//! bounded base64 bytes and never creates directories or executes content.

use base64::Engine as _;
use std::fs;
use std::path::Path;

const MAX_DOWNLOAD_BYTES: usize = 10 * 1024 * 1024;

pub fn write_base64(path: &Path, data: &str) -> Result<(), String> {
    if path.as_os_str().is_empty() {
        return Err("browser download destination must not be empty".to_string());
    }
    if !path.is_absolute() {
        return Err("browser download destination must be an absolute path".to_string());
    }
    if path.exists() && path.is_dir() {
        return Err("browser download destination is a directory".to_string());
    }
    let parent = path
        .parent()
        .filter(|value| !value.as_os_str().is_empty())
        .ok_or_else(|| "browser download destination has no parent folder".to_string())?;
    if !parent.is_dir() {
        return Err("browser download destination folder does not exist".to_string());
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data.trim())
        .map_err(|_| "browser download payload is not valid base64".to_string())?;
    if bytes.is_empty() {
        return Err("browser download payload is empty".to_string());
    }
    if bytes.len() > MAX_DOWNLOAD_BYTES {
        return Err(format!(
            "browser download is limited to {} MiB",
            MAX_DOWNLOAD_BYTES / 1024 / 1024
        ));
    }
    fs::write(path, bytes).map_err(|error| format!("could not write browser download: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn writes_bounded_base64_to_an_absolute_destination() {
        let root =
            std::env::temp_dir().join(format!("muse-browser-download-{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        let target = root.join("report.txt");
        write_base64(&target, "aGVsbG8=").unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"hello");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn rejects_relative_missing_parent_and_oversized_payloads() {
        assert!(write_base64(Path::new("report.txt"), "aA==").is_err());
        let missing_parent = std::env::temp_dir()
            .join(format!(
                "muse-browser-download-missing-{}",
                std::process::id()
            ))
            .join("report.txt");
        assert!(write_base64(&missing_parent, "aA==").is_err());
        let root = std::env::temp_dir().join(format!(
            "muse-browser-download-large-{}",
            std::process::id()
        ));
        fs::create_dir_all(&root).unwrap();
        let large =
            base64::engine::general_purpose::STANDARD.encode(vec![0u8; MAX_DOWNLOAD_BYTES + 1]);
        assert!(write_base64(&root.join("large.bin"), &large).is_err());
        let _ = fs::remove_dir_all(root);
    }
}
