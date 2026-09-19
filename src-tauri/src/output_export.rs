//! Explicit export for completed host-owned rich outputs.
//!
//! The renderer chooses the destination through the native save dialog. This
//! module is the final trust boundary: it validates the absolute destination,
//! decodes a bounded base64 payload, and never creates directories or runs the
//! exported content.

use base64::Engine as _;
use std::fs;
use std::path::Path;

const MAX_OUTPUT_EXPORT_BYTES: usize = 10 * 1024 * 1024;
const MAX_OUTPUT_EXPORT_BASE64_CHARS: usize = ((MAX_OUTPUT_EXPORT_BYTES + 2) / 3) * 4 + 4;

pub fn write_base64(path: &Path, data: &str) -> Result<(), String> {
    if path.as_os_str().is_empty() {
        return Err("output export destination must not be empty".to_string());
    }
    if !path.is_absolute() {
        return Err("output export destination must be an absolute path".to_string());
    }
    if path.exists() && path.is_dir() {
        return Err("output export destination is a directory".to_string());
    }
    let parent = path
        .parent()
        .filter(|value| !value.as_os_str().is_empty())
        .ok_or_else(|| "output export destination has no parent folder".to_string())?;
    if !parent.is_dir() {
        return Err("output export destination folder does not exist".to_string());
    }
    if data.trim().len() > MAX_OUTPUT_EXPORT_BASE64_CHARS {
        return Err(format!(
            "output export payload is limited to {} MiB",
            MAX_OUTPUT_EXPORT_BYTES / 1024 / 1024
        ));
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data.trim())
        .map_err(|_| "output export payload is not valid base64".to_string())?;
    if bytes.is_empty() {
        return Err("output export payload is empty".to_string());
    }
    if bytes.len() > MAX_OUTPUT_EXPORT_BYTES {
        return Err(format!(
            "output export is limited to {} MiB",
            MAX_OUTPUT_EXPORT_BYTES / 1024 / 1024
        ));
    }
    fs::write(path, bytes).map_err(|error| format!("could not write output export: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn writes_bounded_base64_to_an_absolute_destination() {
        let root = std::env::temp_dir().join(format!("muse-output-export-{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        let target = root.join("report.pdf");
        write_base64(&target, "aGVsbG8=").unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"hello");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn rejects_relative_directory_invalid_and_oversized_payloads() {
        assert!(write_base64(Path::new("report.pdf"), "aGVsbG8=").is_err());
        let root =
            std::env::temp_dir().join(format!("muse-output-export-invalid-{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        assert!(write_base64(&root, "aGVsbG8=").is_err());
        assert!(write_base64(&root.join("bad.pdf"), "not-base64").is_err());
        let oversized =
            base64::engine::general_purpose::STANDARD.encode(vec![0u8; 10 * 1024 * 1024 + 1]);
        assert!(write_base64(&root.join("big.pdf"), &oversized).is_err());
        let _ = fs::remove_dir_all(root);
    }
}
