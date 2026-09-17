//! Bounded, workspace-scoped access to files on disk.
//!
//! The Files panel reads the conversation's canonical workspace directly. All
//! paths are resolved in Rust, symlink escapes are rejected, and both directory
//! listings and file content have explicit caps so a large repository cannot
//! block the UI or exhaust memory.

use base64::Engine as _;
use serde::Serialize;
use std::fs::{self, File};
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

const DEFAULT_ENTRY_LIMIT: usize = 200;
const MAX_ENTRY_LIMIT: usize = 500;
const DEFAULT_MAX_CHARS: usize = 120_000;
const MAX_READ_BYTES: u64 = 512 * 1024;
const MAX_IMAGE_BYTES: u64 = 5 * 1024 * 1024;

#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceFileEntry {
    pub path: String,
    pub name: String,
    pub kind: String,
    pub size: Option<u64>,
    pub modified_at: Option<u64>,
    pub accessible: bool,
}

#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileListSnapshot {
    pub root: String,
    pub path: String,
    pub entries: Vec<WorkspaceFileEntry>,
    pub truncated: bool,
    pub observed_at: u64,
}

#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileReadResult {
    pub path: String,
    pub size: u64,
    pub modified_at: Option<u64>,
    pub binary: bool,
    pub content: Option<String>,
    pub media_type: Option<String>,
    pub base64_data: Option<String>,
    pub truncated: bool,
    pub observed_at: u64,
}

pub fn list(
    root: &Path,
    relative_path: Option<String>,
    limit: Option<usize>,
) -> Result<FileListSnapshot, String> {
    let canonical_root = canonical_root(root)?;
    let directory = resolve_path(&canonical_root, relative_path.as_deref().unwrap_or("."))?;
    if !directory.is_dir() {
        return Err(format!(
            "workspace path is not a directory: {}",
            display_relative(&canonical_root, &directory)
        ));
    }
    let max_entries = limit
        .unwrap_or(DEFAULT_ENTRY_LIMIT)
        .clamp(1, MAX_ENTRY_LIMIT);
    let mut entries = Vec::new();
    let mut total = 0usize;
    let read_dir = fs::read_dir(&directory).map_err(|e| {
        format!(
            "cannot list {}: {e}",
            display_relative(&canonical_root, &directory)
        )
    })?;
    for item in read_dir {
        let item = item.map_err(|e| format!("cannot read workspace entry: {e}"))?;
        total += 1;
        if entries.len() >= max_entries {
            continue;
        }
        let path = item.path();
        let relative = path
            .strip_prefix(&canonical_root)
            .map_err(|_| "workspace entry escaped its root".to_string())?;
        let relative = relative.to_string_lossy().replace('\\', "/");
        let name = item.file_name().to_string_lossy().to_string();
        let link_meta =
            fs::symlink_metadata(&path).map_err(|e| format!("cannot inspect {relative}: {e}"))?;
        let is_symlink = link_meta.file_type().is_symlink();
        let target = if is_symlink {
            path.canonicalize().ok()
        } else {
            Some(path.clone())
        };
        let accessible = target
            .as_ref()
            .is_some_and(|candidate| candidate.starts_with(&canonical_root));
        let metadata = if accessible {
            fs::metadata(&path).ok()
        } else {
            None
        };
        let kind = if is_symlink {
            "symlink"
        } else if metadata.as_ref().is_some_and(|value| value.is_dir()) {
            "directory"
        } else {
            "file"
        };
        entries.push(WorkspaceFileEntry {
            path: relative,
            name,
            kind: kind.to_string(),
            size: metadata
                .as_ref()
                .filter(|value| value.is_file())
                .map(|value| value.len()),
            modified_at: metadata.as_ref().and_then(modified_at),
            accessible,
        });
    }
    entries.sort_by(|a, b| {
        let a_dir = a.kind == "directory";
        let b_dir = b.kind == "directory";
        b_dir.cmp(&a_dir).then_with(|| {
            a.name
                .to_ascii_lowercase()
                .cmp(&b.name.to_ascii_lowercase())
        })
    });
    let path = directory
        .strip_prefix(&canonical_root)
        .map(|value| value.to_string_lossy().replace('\\', "/"))
        .unwrap_or_default();
    Ok(FileListSnapshot {
        root: canonical_root.display().to_string(),
        path,
        entries,
        truncated: total > max_entries,
        observed_at: now_ms(),
    })
}

pub fn read(
    root: &Path,
    relative_path: &str,
    max_chars: Option<usize>,
) -> Result<FileReadResult, String> {
    let canonical_root = canonical_root(root)?;
    let file_path = resolve_path(&canonical_root, relative_path)?;
    let metadata =
        fs::metadata(&file_path).map_err(|e| format!("cannot inspect {relative_path}: {e}"))?;
    if !metadata.is_file() {
        return Err(format!("workspace path is not a file: {relative_path}"));
    }
    let size = metadata.len();
    let max_chars = max_chars
        .unwrap_or(DEFAULT_MAX_CHARS)
        .clamp(1, DEFAULT_MAX_CHARS);
    let file = File::open(&file_path).map_err(|e| format!("cannot read {relative_path}: {e}"))?;
    let mut bytes = Vec::new();
    file.take(MAX_READ_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("cannot read {relative_path}: {e}"))?;
    let probe_truncated = bytes.len() as u64 > MAX_READ_BYTES || size > MAX_READ_BYTES;
    if bytes.len() as u64 > MAX_READ_BYTES {
        bytes.truncate(MAX_READ_BYTES as usize);
    }
    let binary = bytes.contains(&0) || std::str::from_utf8(&bytes).is_err();
    let detected_media_type = image_media_type(&file_path);
    let image_bytes = if detected_media_type.is_some() && size <= MAX_IMAGE_BYTES {
        let mut full = Vec::with_capacity(size as usize);
        File::open(&file_path)
            .map_err(|e| format!("cannot read {relative_path}: {e}"))?
            .take(MAX_IMAGE_BYTES + 1)
            .read_to_end(&mut full)
            .map_err(|e| format!("cannot read {relative_path}: {e}"))?;
        (full.len() as u64 == size).then_some(full)
    } else {
        None
    };
    // A full image payload is available to the UI even when the bounded text
    // probe had to stop at MAX_READ_BYTES.
    let byte_truncated = probe_truncated && image_bytes.is_none();
    let (content, char_truncated) = if binary {
        (None, false)
    } else {
        let text =
            String::from_utf8(bytes).map_err(|_| format!("cannot decode {relative_path}"))?;
        let truncated = text.chars().count() > max_chars;
        let clipped: String = text.chars().take(max_chars).collect();
        (Some(clipped), truncated)
    };
    Ok(FileReadResult {
        path: relative_path.replace('\\', "/"),
        size,
        modified_at: modified_at(&metadata),
        binary,
        content,
        media_type: image_bytes
            .as_ref()
            .and_then(|_| detected_media_type.map(str::to_string)),
        base64_data: image_bytes
            .as_ref()
            .map(|value| base64::engine::general_purpose::STANDARD.encode(value)),
        truncated: byte_truncated || char_truncated,
        observed_at: now_ms(),
    })
}

fn image_media_type(path: &Path) -> Option<&'static str> {
    let extension = path.extension()?.to_str()?.to_ascii_lowercase();
    match extension.as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        "bmp" => Some("image/bmp"),
        "svg" => Some("image/svg+xml"),
        _ => None,
    }
}

/// Resolve one existing workspace entry for an explicit "open in system"
/// action. The same traversal and symlink guards as `list`/`read` apply; the
/// caller receives a canonical path only after the entry is proven to remain
/// inside the workspace root.
pub fn resolve_for_open(root: &Path, relative_path: &str) -> Result<PathBuf, String> {
    let canonical_root = canonical_root(root)?;
    let path = resolve_path(&canonical_root, relative_path)?;
    let metadata = fs::metadata(&path)
        .map_err(|e| format!("cannot inspect {}: {e}", relative_path.trim()))?;
    if !metadata.is_file() && !metadata.is_dir() {
        return Err(format!("workspace path cannot be opened: {}", relative_path.trim()));
    }
    Ok(path)
}

fn canonical_root(root: &Path) -> Result<PathBuf, String> {
    root.canonicalize()
        .map_err(|e| format!("cannot resolve workspace {}: {e}", root.display()))
        .and_then(|path| {
            if path.is_dir() {
                Ok(path)
            } else {
                Err(format!("workspace is not a directory: {}", path.display()))
            }
        })
}

fn resolve_path(root: &Path, raw: &str) -> Result<PathBuf, String> {
    let raw = raw.trim();
    if raw.is_empty() || raw.contains('\0') {
        return Err("workspace path must not be empty or contain NUL".to_string());
    }
    let windows_absolute = raw.starts_with("\\\\")
        || raw.starts_with("//")
        || (raw.len() >= 2 && raw.as_bytes()[0].is_ascii_alphabetic() && raw.as_bytes()[1] == b':');
    let normalized = raw.replace('\\', "/");
    let candidate = Path::new(&normalized);
    if windows_absolute || candidate.is_absolute() {
        return Err(format!("workspace path must be relative: {raw}"));
    }
    if candidate.components().any(|component| {
        matches!(
            component,
            Component::ParentDir | Component::RootDir | Component::Prefix(_)
        )
    }) {
        return Err(format!("workspace path escapes its root: {raw}"));
    }
    let candidate = if normalized == "." {
        root.to_path_buf()
    } else {
        root.join(candidate)
    };
    let canonical = candidate
        .canonicalize()
        .map_err(|e| format!("cannot resolve workspace path {raw}: {e}"))?;
    if !canonical.starts_with(root) {
        return Err(format!("workspace path escapes its root: {raw}"));
    }
    Ok(canonical)
}

fn display_relative(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .map(|value| {
            let text = value.to_string_lossy();
            if text.is_empty() {
                ".".to_string()
            } else {
                text.replace('\\', "/")
            }
        })
        .unwrap_or_else(|_| path.display().to_string())
}

fn modified_at(metadata: &fs::Metadata) -> Option<u64> {
    metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .map(|value| value.as_millis() as u64)
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT: AtomicU64 = AtomicU64::new(0);

    fn temp_root() -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "muse-files-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn list_and_read_are_bounded_and_real() {
        let root = temp_root();
        fs::create_dir(root.join("src")).unwrap();
        fs::write(root.join("src/main.ts"), "console.log('Muse')\n").unwrap();
        fs::write(root.join("image.bin"), [0u8, 1, 2, 3]).unwrap();
        let listing = list(&root, Some("src".to_string()), Some(10)).unwrap();
        assert_eq!(listing.entries[0].path, "src/main.ts");
        let text = read(&root, "src/main.ts", Some(100)).unwrap();
        assert_eq!(text.content.as_deref(), Some("console.log('Muse')\n"));
        assert!(!text.binary);
        assert!(text.media_type.is_none());
        let binary = read(&root, "image.bin", None).unwrap();
        assert!(binary.binary);
        assert!(binary.content.is_none());
        assert!(binary.base64_data.is_none());
        fs::write(root.join("pixel.png"), [137u8, 80, 78, 71]).unwrap();
        let image = read(&root, "pixel.png", None).unwrap();
        assert_eq!(image.media_type.as_deref(), Some("image/png"));
        assert!(image.base64_data.is_some());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn path_guard_rejects_traversal_and_cross_platform_absolute_forms() {
        let root = temp_root();
        fs::write(root.join("ok.txt"), "ok").unwrap();
        assert!(resolve_path(&root.canonicalize().unwrap(), "../outside.txt").is_err());
        assert!(resolve_path(&root.canonicalize().unwrap(), "C:\\\\secret.txt").is_err());
        assert!(resolve_path(&root.canonicalize().unwrap(), "ok.txt").is_ok());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn resolve_for_open_keeps_files_and_directories_in_workspace() {
        let root = temp_root();
        fs::create_dir(root.join("src")).unwrap();
        fs::write(root.join("src/main.ts"), "console.log('Muse')\n").unwrap();
        assert!(resolve_for_open(&root, "src/main.ts").unwrap().is_file());
        assert!(resolve_for_open(&root, "src").unwrap().is_dir());
        assert!(resolve_for_open(&root, "../outside").is_err());
        assert!(resolve_for_open(&root, "missing.txt").is_err());
        let _ = fs::remove_dir_all(root);
    }
}
