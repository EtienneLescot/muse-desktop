//! Explicit local export for assistant artifacts.
//!
//! The renderer chooses the destination through the native save dialog. This
//! module only performs the final UTF-8 write after validating the target and
//! bounding the payload; it never creates directories or executes content.

use std::fs;
use std::path::Path;

const MAX_EXPORT_BYTES: usize = 2 * 1024 * 1024;

pub fn write_text(path: &Path, content: &str) -> Result<(), String> {
    if path.as_os_str().is_empty() {
        return Err("export destination must not be empty".to_string());
    }
    if !path.is_absolute() {
        return Err("export destination must be an absolute path".to_string());
    }
    if content.contains('\0') {
        return Err("artifact content contains an unsupported NUL character".to_string());
    }
    if content.len() > MAX_EXPORT_BYTES {
        return Err(format!(
            "artifact export is limited to {} MiB",
            MAX_EXPORT_BYTES / 1024 / 1024
        ));
    }
    if path.exists() && path.is_dir() {
        return Err("export destination is a directory".to_string());
    }
    let parent = path
        .parent()
        .filter(|value| !value.as_os_str().is_empty())
        .ok_or_else(|| "export destination has no parent folder".to_string())?;
    if !parent.is_dir() {
        return Err("export destination folder does not exist".to_string());
    }
    fs::write(path, content).map_err(|error| format!("could not write artifact export: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn writes_utf8_to_an_absolute_destination() {
        let root =
            std::env::temp_dir().join(format!("muse-artifact-export-{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        let target = root.join("snippet.ts");
        write_text(&target, "const café = true;\n").unwrap();
        assert_eq!(fs::read_to_string(&target).unwrap(), "const café = true;\n");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn rejects_relative_directory_and_oversized_destinations() {
        assert!(write_text(Path::new("snippet.ts"), "x").is_err());
        let root =
            std::env::temp_dir().join(format!("muse-artifact-export-dir-{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        assert!(write_text(&root, "x").is_err());
        assert!(write_text(&root.join("big.txt"), &"x".repeat(MAX_EXPORT_BYTES + 1)).is_err());
        let _ = fs::remove_dir_all(root);
    }
}
