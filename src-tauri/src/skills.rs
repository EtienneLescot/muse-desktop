//! Bounded, read-only discovery of workspace `SKILL.md` files.
//!
//! Discovery intentionally visits only conventional skill roots. It never
//! executes a skill, follows a symlink outside the workspace, or recursively
//! walks an arbitrary repository.

use serde::Serialize;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

const MAX_DOCUMENTS: usize = 100;
const MAX_BYTES: usize = 20_001;
const MAX_ERRORS: usize = 100;
const MAX_RESOURCES: usize = 20;
const MAX_RESOURCE_BYTES: usize = 20_001;

#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SkillDocument {
    pub path: String,
    pub source: String,
    pub text: String,
    pub truncated: bool,
}

#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SkillScanError {
    pub path: String,
    pub message: String,
}

#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SkillScanResult {
    pub root: String,
    pub documents: Vec<SkillDocument>,
    pub errors: Vec<SkillScanError>,
    pub scanned_at: u64,
}

#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SkillResource {
    pub path: String,
    pub content: String,
    pub truncated: bool,
}

#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SkillResourcesResult {
    pub resources: Vec<SkillResource>,
    pub errors: Vec<SkillScanError>,
    pub observed_at: u64,
}

pub fn scan(root: &Path) -> Result<SkillScanResult, String> {
    let root = root
        .canonicalize()
        .map_err(|e| format!("cannot resolve skills workspace {}: {e}", root.display()))?;
    if !root.is_dir() {
        return Err(format!(
            "skills workspace is not a directory: {}",
            root.display()
        ));
    }
    let mut out = SkillScanResult {
        root: root.display().to_string(),
        documents: Vec::new(),
        errors: Vec::new(),
        scanned_at: now_ms(),
    };

    // Project-local roots take precedence over repository-compatible roots
    // in the frontend resolver, while all remain confined to this workspace.
    scan_file(&root, &root.join("SKILL.md"), "project", &mut out);
    for (relative, source) in [
        (".agents/skills", "project"),
        (".muse/skills", "repo"),
        (".claude/skills", "repo"),
        ("skills", "repo"),
    ] {
        scan_root(&root, &root.join(relative), source, &mut out);
    }
    out.documents.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(out)
}

/// Read resources declared by a discovered skill at invocation time. Both
/// the SKILL.md and every resource must remain inside the skill directory.
pub fn read_resources(
    root: &Path,
    skill_path: &str,
    resource_paths: &[String],
) -> Result<SkillResourcesResult, String> {
    let root = root
        .canonicalize()
        .map_err(|e| format!("cannot resolve skills workspace {}: {e}", root.display()))?;
    if !root.is_dir() {
        return Err(format!(
            "skills workspace is not a directory: {}",
            root.display()
        ));
    }
    let skill_file = resolve_relative(&root, skill_path)?;
    if !skill_file.starts_with(&root) {
        return Err("skill path is outside the workspace".to_string());
    }
    if !skill_file.is_file()
        || skill_file.file_name().and_then(|name| name.to_str()) != Some("SKILL.md")
    {
        return Err("skill path must point to an existing SKILL.md".to_string());
    }
    let skill_dir = skill_file
        .parent()
        .ok_or_else(|| "skill path has no parent directory".to_string())?
        .canonicalize()
        .map_err(|e| format!("cannot resolve skill directory: {e}"))?;
    if !skill_dir.starts_with(&root) {
        return Err("skill directory is outside the workspace".to_string());
    }
    let mut result = SkillResourcesResult {
        resources: Vec::new(),
        errors: Vec::new(),
        observed_at: now_ms(),
    };
    for raw in resource_paths.iter().take(MAX_RESOURCES) {
        let raw = raw.trim();
        if raw.is_empty() {
            continue;
        }
        let candidate = match resolve_relative(&skill_dir, raw) {
            Ok(path) => path,
            Err(error) => {
                push_resource_error(&mut result, raw.to_string(), error);
                continue;
            }
        };
        if !candidate.starts_with(&skill_dir) || !is_safe_file(&root, &candidate) {
            push_resource_error(
                &mut result,
                raw.to_string(),
                "resource is outside the skill directory or not a regular file".to_string(),
            );
            continue;
        }
        let relative = candidate
            .strip_prefix(&root)
            .map(|value| value.to_string_lossy().replace('\\', "/"))
            .unwrap_or_else(|_| raw.replace('\\', "/"));
        let file = match fs::File::open(&candidate) {
            Ok(file) => file,
            Err(error) => {
                push_resource_error(
                    &mut result,
                    relative,
                    format!("cannot read resource: {error}"),
                );
                continue;
            }
        };
        let mut bytes = Vec::new();
        if let Err(error) = file.take(MAX_RESOURCE_BYTES as u64).read_to_end(&mut bytes) {
            push_resource_error(
                &mut result,
                relative,
                format!("cannot read resource: {error}"),
            );
            continue;
        }
        let truncated = bytes.len() > MAX_RESOURCE_BYTES - 1;
        if truncated {
            bytes.truncate(MAX_RESOURCE_BYTES - 1);
        }
        match String::from_utf8(bytes) {
            Ok(content) => result.resources.push(SkillResource {
                path: relative,
                content,
                truncated,
            }),
            Err(_) => push_resource_error(
                &mut result,
                relative,
                "resource is not valid UTF-8".to_string(),
            ),
        }
    }
    Ok(result)
}

fn resolve_relative(root: &Path, raw: &str) -> Result<PathBuf, String> {
    let raw = raw.trim();
    if raw.is_empty() || raw.contains('\0') {
        return Err("resource path must not be empty or contain NUL".to_string());
    }
    let candidate = Path::new(raw);
    if candidate.is_absolute()
        || candidate.components().any(|component| {
            matches!(
                component,
                std::path::Component::ParentDir
                    | std::path::Component::RootDir
                    | std::path::Component::Prefix(_)
            )
        })
    {
        return Err(
            "resource path must be relative and stay inside the skill directory".to_string(),
        );
    }
    root.join(candidate)
        .canonicalize()
        .map_err(|e| format!("resource is unavailable: {e}"))
}

fn push_resource_error(out: &mut SkillResourcesResult, path: String, message: String) {
    if out.errors.len() < MAX_ERRORS {
        out.errors.push(SkillScanError { path, message });
    }
}

fn scan_root(root: &Path, directory: &Path, source: &str, out: &mut SkillScanResult) {
    if out.documents.len() >= MAX_DOCUMENTS || !is_safe_directory(root, directory) {
        return;
    }
    let entries = match fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(_) => return, // Conventional roots are optional.
    };
    let mut children: Vec<PathBuf> = entries
        .filter_map(|entry| entry.ok().map(|e| e.path()))
        .collect();
    children.sort();
    for child in children {
        if out.documents.len() >= MAX_DOCUMENTS {
            break;
        }
        let metadata = match fs::symlink_metadata(&child) {
            Ok(metadata) => metadata,
            Err(_) => continue,
        };
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            continue;
        }
        // A skill is a directory containing SKILL.md. This bounded one-level
        // lookup also keeps unrelated nested repository files out of scope.
        let skill_file = child.join("SKILL.md");
        scan_file(root, &skill_file, source, out);
    }
}

fn scan_file(root: &Path, path: &Path, source: &str, out: &mut SkillScanResult) {
    if out.documents.len() >= MAX_DOCUMENTS || !is_safe_file(root, path) {
        return;
    }
    let relative = path
        .strip_prefix(root)
        .map(|value| value.to_string_lossy().replace('\\', "/"))
        .unwrap_or_else(|_| path.to_string_lossy().replace('\\', "/"));
    let file = match fs::File::open(path) {
        Ok(file) => file,
        Err(error) => {
            push_error(out, relative, format!("cannot read SKILL.md: {error}"));
            return;
        }
    };
    let mut bytes = Vec::new();
    if let Err(error) = file.take(MAX_BYTES as u64).read_to_end(&mut bytes) {
        push_error(out, relative, format!("cannot read SKILL.md: {error}"));
        return;
    }
    let truncated = bytes.len() > MAX_BYTES - 1;
    if truncated {
        bytes.truncate(MAX_BYTES - 1);
    }
    let text = match String::from_utf8(bytes) {
        Ok(text) => text,
        Err(_) => {
            push_error(out, relative, "SKILL.md is not valid UTF-8".to_string());
            return;
        }
    };
    out.documents.push(SkillDocument {
        path: relative,
        source: source.to_string(),
        text,
        truncated,
    });
}

fn is_safe_directory(root: &Path, path: &Path) -> bool {
    path.is_dir()
        && fs::symlink_metadata(path)
            .map(|metadata| !metadata.file_type().is_symlink())
            .unwrap_or(false)
        && path
            .canonicalize()
            .map(|candidate| candidate.starts_with(root))
            .unwrap_or(false)
}

fn is_safe_file(root: &Path, path: &Path) -> bool {
    fs::symlink_metadata(path)
        .map(|metadata| metadata.is_file() && !metadata.file_type().is_symlink())
        .unwrap_or(false)
        && path
            .canonicalize()
            .map(|candidate| candidate.starts_with(root))
            .unwrap_or(false)
}

fn push_error(out: &mut SkillScanResult, path: String, message: String) {
    if out.errors.len() < MAX_ERRORS {
        out.errors.push(SkillScanError { path, message });
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn scan_reads_known_roots_and_ignores_unrelated_files() {
        let base = std::env::temp_dir().join(format!("muse-skills-{}", std::process::id()));
        let root = base.join("repo");
        fs::create_dir_all(root.join(".agents/skills/alpha")).unwrap();
        fs::create_dir_all(root.join("nested/skills/beta")).unwrap();
        fs::write(
            root.join(".agents/skills/alpha/SKILL.md"),
            "---\nname: alpha\ndescription: A\n---\nDo it",
        )
        .unwrap();
        fs::write(
            root.join("nested/skills/beta/SKILL.md"),
            "---\nname: beta\ndescription: B\n---\nDo it",
        )
        .unwrap();
        let result = scan(&root).unwrap();
        assert_eq!(result.documents.len(), 1);
        assert_eq!(result.documents[0].path, ".agents/skills/alpha/SKILL.md");
        fs::remove_dir_all(base).ok();
    }

    #[test]
    fn scan_marks_large_documents_truncated() {
        let base = std::env::temp_dir().join(format!("muse-skills-large-{}", std::process::id()));
        let root = base.join("repo");
        fs::create_dir_all(root.join("skills/big")).unwrap();
        fs::write(root.join("skills/big/SKILL.md"), "x".repeat(MAX_BYTES)).unwrap();
        let result = scan(&root).unwrap();
        assert_eq!(result.documents.len(), 1);
        assert!(result.documents[0].truncated);
        fs::remove_dir_all(base).ok();
    }

    #[test]
    fn read_resources_stays_inside_skill_directory() {
        let base =
            std::env::temp_dir().join(format!("muse-skills-resource-{}", std::process::id()));
        let root = base.join("repo");
        fs::create_dir_all(root.join("skills/demo")).unwrap();
        fs::write(
            root.join("skills/demo/SKILL.md"),
            "---\nname: demo\ndescription: Demo\n---\nRun",
        )
        .unwrap();
        fs::write(root.join("skills/demo/guide.md"), "Use the guide.").unwrap();
        let result = read_resources(
            &root,
            "skills/demo/SKILL.md",
            &["guide.md".to_string(), "../secret.md".to_string()],
        )
        .unwrap();
        assert_eq!(result.resources.len(), 1);
        assert_eq!(result.resources[0].content, "Use the guide.");
        assert_eq!(result.errors.len(), 1);
        fs::remove_dir_all(base).ok();
    }
}
