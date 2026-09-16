//! Read-only Git inspection for the conversation Review panel.
//!
//! This module deliberately exposes status and diff snapshots only. Mutating
//! operations (stage, revert, commit and push) build on the observed revision
//! in later roadmap slices, so a review can never imply that a file changed
//! merely because a response mentioned it.

use std::path::{Component, Path};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;

const MAX_PATCH_CHARS: usize = 240_000;
const MAX_FILES: usize = 2_000;
const MAX_HUNKS_PER_FILE: usize = 200;

#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GitStatusFile {
    pub path: String,
    pub original_path: Option<String>,
    pub index_status: String,
    pub worktree_status: String,
    pub change_type: String,
    pub staged: bool,
    pub unstaged: bool,
    pub untracked: bool,
    pub conflicted: bool,
    pub binary: bool,
}

#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GitStatusSnapshot {
    pub repo_root: String,
    pub branch: Option<String>,
    pub head: Option<String>,
    pub upstream: Option<String>,
    pub ahead: u64,
    pub behind: u64,
    pub fingerprint: String,
    pub files: Vec<GitStatusFile>,
    pub observed_at: u64,
}

#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GitDiffHunk {
    pub header: String,
    pub old_start: u64,
    pub old_lines: u64,
    pub new_start: u64,
    pub new_lines: u64,
}

#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GitDiffFile {
    pub path: String,
    pub old_path: Option<String>,
    pub status: String,
    pub binary: bool,
    pub additions: u64,
    pub deletions: u64,
    pub hunks: Vec<GitDiffHunk>,
}

#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GitDiffSnapshot {
    pub repo_root: String,
    pub scope: String,
    pub base_ref: Option<String>,
    pub patch: String,
    pub patch_truncated: bool,
    pub files: Vec<GitDiffFile>,
    pub observed_at: u64,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis().min(u128::from(u64::MAX)) as u64)
        .unwrap_or(0)
}

fn decode(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

/// Stable, local fingerprint for the exact porcelain status payload. It is
/// sent back with mutations so a concurrent edit cannot be overwritten by a
/// stale Review action. This is intentionally not a cryptographic claim: it
/// only guards the short-lived UI observation window.
fn status_fingerprint(bytes: &[u8]) -> String {
    status_fingerprint_parts(&[bytes])
}

fn status_fingerprint_parts(parts: &[&[u8]]) -> String {
    let mut hash = 0xcbf29ce484222325u64;
    for part in parts {
        for byte in *part {
            hash ^= u64::from(*byte);
            hash = hash.wrapping_mul(0x100000001b3);
        }
        hash ^= 0xff;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}

fn git_command(root: &Path, args: &[&str]) -> Result<Vec<u8>, String> {
    if !root.is_dir() {
        return Err(format!("workspace is not a directory: {}", root.display()));
    }
    let output = Command::new("git")
        .args(args)
        .current_dir(root)
        .env("LC_ALL", "C")
        .env("LANG", "C")
        .output()
        .map_err(|e| format!("could not start git: {e}"))?;
    if !output.status.success() {
        let detail = decode(&output.stderr).trim().to_string();
        return Err(if detail.is_empty() {
            format!("git {} failed with {}", args.join(" "), output.status)
        } else {
            detail
        });
    }
    Ok(output.stdout)
}

fn parse_branch_header(header: &str) -> (Option<String>, Option<String>, u64, u64) {
    let value = header.strip_prefix("## ").unwrap_or(header).trim();
    if value == "Initial commit on No branch" || value == "No commits yet on No branch" {
        return (None, None, 0, 0);
    }
    let (branch_part, counts) = value.split_once(" [").unwrap_or((value, ""));
    let counts = counts.trim_start_matches('[').trim_end_matches(']');
    let (branch, upstream) = branch_part
        .split_once("...")
        .map(|(b, u)| (Some(b.to_string()), Some(u.to_string())))
        .unwrap_or_else(|| (Some(branch_part.to_string()), None));
    let ahead = counts
        .split(',')
        .find_map(|part| part.trim().strip_prefix("ahead ")?.parse().ok())
        .unwrap_or(0);
    let behind = counts
        .split(',')
        .find_map(|part| part.trim().strip_prefix("behind ")?.parse().ok())
        .unwrap_or(0);
    (branch, upstream, ahead, behind)
}

fn status_change_type(index: char, worktree: char) -> String {
    let c = if index != ' ' { index } else { worktree };
    match c {
        'A' => "added",
        'D' => "deleted",
        'R' => "renamed",
        'C' => "copied",
        'U' => "conflicted",
        '?' => "untracked",
        'T' => "type changed",
        _ => "modified",
    }
    .to_string()
}

/// Parse `git status --porcelain=v1 -z --branch` without splitting paths on
/// whitespace. `-z` is essential for spaces, Unicode and rename pairs.
pub fn parse_status(bytes: &[u8], repo_root: &str) -> GitStatusSnapshot {
    let mut fields = bytes.split(|b| *b == 0).filter(|f| !f.is_empty());
    let (branch, upstream, ahead, behind) = fields
        .next()
        .map(|h| parse_branch_header(&decode(h)))
        .unwrap_or((None, None, 0, 0));
    let mut files = Vec::new();
    while let Some(raw) = fields.next() {
        if raw.len() < 3 || files.len() >= MAX_FILES {
            continue;
        }
        let index = raw[0] as char;
        let worktree = raw[1] as char;
        let path = decode(&raw[3..]);
        let original_path = if matches!(index, 'R' | 'C') {
            fields.next().map(decode)
        } else {
            None
        };
        let untracked = index == '?' && worktree == '?';
        let conflicted = index == 'U' || worktree == 'U';
        files.push(GitStatusFile {
            path,
            original_path,
            index_status: index.to_string(),
            worktree_status: worktree.to_string(),
            change_type: status_change_type(index, worktree),
            staged: index != ' ' && index != '?',
            unstaged: worktree != ' ' && worktree != '?',
            untracked,
            conflicted,
            binary: false,
        });
    }
    GitStatusSnapshot {
        repo_root: repo_root.to_string(),
        branch,
        head: None,
        upstream,
        ahead,
        behind,
        fingerprint: status_fingerprint(bytes),
        files,
        observed_at: now_ms(),
    }
}

fn parse_hunk_header(header: &str) -> Option<GitDiffHunk> {
    let body = header.strip_prefix("@@ ")?.split(" @@").next()?;
    let (old, new) = body.split_once(' ')?;
    fn range(value: &str) -> Option<(u64, u64)> {
        let value = value
            .strip_prefix('+')
            .or_else(|| value.strip_prefix('-'))?;
        let (start, len) = value
            .split_once(',')
            .map(|(a, b)| (a, b))
            .unwrap_or((value, "1"));
        Some((start.parse().ok()?, len.parse().ok()?))
    }
    let (old_start, old_lines) = range(old)?;
    let (new_start, new_lines) = range(new)?;
    Some(GitDiffHunk {
        header: header.to_string(),
        old_start,
        old_lines,
        new_start,
        new_lines,
    })
}

fn diff_path_pair(header: &str) -> (String, Option<String>) {
    let raw = header.strip_prefix("diff --git ").unwrap_or("");
    let split = raw.rfind(" b/");
    match split {
        Some(i) => {
            let old = raw[..i].strip_prefix("a/").unwrap_or(&raw[..i]);
            let new = &raw[i + 3..];
            (new.to_string(), Some(old.to_string()))
        }
        None => (raw.to_string(), None),
    }
}

/// Parse a normal unified patch into file and hunk metadata. The complete
/// (bounded) patch is retained for the UI, while metadata stays cheap to
/// render in a file list.
pub fn parse_diff(
    patch_bytes: &[u8],
    root: &str,
    scope: &str,
    base_ref: Option<String>,
) -> GitDiffSnapshot {
    let full = decode(patch_bytes);
    let patch_truncated = full.chars().count() > MAX_PATCH_CHARS;
    let patch = full.chars().take(MAX_PATCH_CHARS).collect::<String>();
    let mut files = Vec::new();
    let mut current: Option<GitDiffFile> = None;
    for line in full.lines() {
        if line.starts_with("diff --git ") {
            if let Some(file) = current.take() {
                files.push(file);
            }
            let (path, old_path) = diff_path_pair(line);
            current = Some(GitDiffFile {
                path,
                old_path,
                status: "modified".to_string(),
                binary: false,
                additions: 0,
                deletions: 0,
                hunks: Vec::new(),
            });
            continue;
        }
        let Some(file) = current.as_mut() else {
            continue;
        };
        if line.starts_with("Binary files ") || line == "GIT binary patch" {
            file.binary = true;
            continue;
        }
        if line.starts_with("new file mode") {
            file.status = "added".to_string();
        } else if line.starts_with("deleted file mode") {
            file.status = "deleted".to_string();
        } else if line.starts_with("rename from") {
            file.status = "renamed".to_string();
            file.old_path = Some(line[12..].to_string());
        } else if line.starts_with("copy from") {
            file.status = "copied".to_string();
        } else if line.starts_with("@@ ") {
            if file.hunks.len() < MAX_HUNKS_PER_FILE {
                if let Some(hunk) = parse_hunk_header(line) {
                    file.hunks.push(hunk);
                }
            }
        } else if line.starts_with('+') && !line.starts_with("+++") {
            file.additions = file.additions.saturating_add(1);
        } else if line.starts_with('-') && !line.starts_with("---") {
            file.deletions = file.deletions.saturating_add(1);
        }
    }
    if let Some(file) = current {
        files.push(file);
    }
    files.truncate(MAX_FILES);
    GitDiffSnapshot {
        repo_root: root.to_string(),
        scope: scope.to_string(),
        base_ref,
        patch,
        patch_truncated,
        files,
        observed_at: now_ms(),
    }
}

fn head(root: &Path) -> Option<String> {
    git_command(root, &["rev-parse", "HEAD"])
        .ok()
        .map(|b| decode(&b).trim().to_string())
        .filter(|s| !s.is_empty())
}

pub fn status(root: &Path) -> Result<GitStatusSnapshot, String> {
    let canonical = root
        .canonicalize()
        .map_err(|e| format!("cannot resolve repository {}: {e}", root.display()))?;
    let bytes = git_command(
        &canonical,
        &[
            "status",
            "--porcelain=v1",
            "-z",
            "--branch",
            "--untracked-files=all",
        ],
    )?;
    let root_string = canonical.display().to_string();
    let mut snapshot = parse_status(&bytes, &root_string);
    // Status codes alone do not distinguish two edits to the same file. Add
    // both bounded unified diffs so mutating actions can reject a stale
    // observation even when the path/status pair is unchanged.
    let unstaged = git_command(
        &canonical,
        &["diff", "--no-ext-diff", "--binary", "--full-index", "--no-color"],
    )
    .unwrap_or_default();
    let staged = git_command(
        &canonical,
        &[
            "diff",
            "--cached",
            "--no-ext-diff",
            "--binary",
            "--full-index",
            "--no-color",
        ],
    )
    .unwrap_or_default();
    snapshot.fingerprint = status_fingerprint_parts(&[&bytes, &unstaged, &staged]);
    snapshot.head = head(&canonical);
    Ok(snapshot)
}

pub fn diff(root: &Path, scope: &str, base_ref: Option<String>) -> Result<GitDiffSnapshot, String> {
    let canonical = root
        .canonicalize()
        .map_err(|e| format!("cannot resolve repository {}: {e}", root.display()))?;
    let mut args = vec![
        "diff",
        "--no-ext-diff",
        "--binary",
        "--full-index",
        "--no-color",
    ];
    match scope {
        "unstaged" => {}
        "staged" => args.push("--cached"),
        "branch" => {
            let base = base_ref
                .as_deref()
                .filter(|r| !r.trim().is_empty())
                .ok_or_else(|| "branch diff requires an explicit baseRef".to_string())?;
            if base.trim_start().starts_with('-') {
                return Err("branch diff baseRef cannot start with '-'".to_string());
            }
            args.push(base);
        }
        _ => return Err(format!("unknown git diff scope: {scope}")),
    }
    args.push("--");
    let bytes = git_command(&canonical, &args)?;
    Ok(parse_diff(
        &bytes,
        &canonical.display().to_string(),
        scope,
        base_ref,
    ))
}

fn validate_paths(paths: &[String]) -> Result<(), String> {
    if paths.is_empty() {
        return Err("at least one repository-relative path is required".to_string());
    }
    for raw in paths {
        let path = raw.trim();
        if path.is_empty() {
            return Err("repository path must not be empty".to_string());
        }
        let candidate = Path::new(path);
        if candidate.is_absolute()
            || candidate.components().any(|component| {
                matches!(component, Component::ParentDir | Component::RootDir | Component::Prefix(_))
            })
        {
            return Err(format!("repository path is outside the workspace: {path}"));
        }
    }
    Ok(())
}

fn verify_mutation_observation(
    root: &Path,
    scope: &str,
    expected_head: Option<&str>,
    expected_status: Option<&str>,
    expected_patch: Option<&str>,
) -> Result<GitStatusSnapshot, String> {
    let current = status(root)?;
    if let Some(expected) = expected_head.filter(|value| !value.trim().is_empty()) {
        if current.head.as_deref() != Some(expected) {
            return Err("repository HEAD changed; refresh Review before applying this action".to_string());
        }
    }
    if let Some(expected) = expected_status.filter(|value| !value.trim().is_empty()) {
        if current.fingerprint != expected {
            return Err("repository status changed; refresh Review before applying this action".to_string());
        }
    }
    if let Some(expected) = expected_patch {
        let actual = diff(root, scope, None)?.patch;
        if actual != expected {
            return Err("the selected diff changed; refresh Review before applying this action".to_string());
        }
    }
    Ok(current)
}

/// Stage one or more repository-relative files after checking the exact
/// observation that produced the UI action.
pub fn stage(
    root: &Path,
    paths: &[String],
    expected_head: Option<String>,
    expected_status: Option<String>,
    expected_patch: Option<String>,
) -> Result<GitStatusSnapshot, String> {
    validate_paths(paths)?;
    let canonical = root
        .canonicalize()
        .map_err(|e| format!("cannot resolve repository {}: {e}", root.display()))?;
    verify_mutation_observation(
        &canonical,
        "unstaged",
        expected_head.as_deref(),
        expected_status.as_deref(),
        expected_patch.as_deref(),
    )?;
    let mut args = vec!["add", "--"];
    args.extend(paths.iter().map(String::as_str));
    git_command(&canonical, &args)?;
    status(&canonical)
}

/// Restore one or more files from either the index (`staged`) or worktree
/// (`unstaged`). Untracked files are never deleted by this action.
pub fn restore(
    root: &Path,
    paths: &[String],
    scope: &str,
    expected_head: Option<String>,
    expected_status: Option<String>,
    expected_patch: Option<String>,
) -> Result<GitStatusSnapshot, String> {
    validate_paths(paths)?;
    if scope != "staged" && scope != "unstaged" {
        return Err(format!("unknown restore scope: {scope}"));
    }
    let canonical = root
        .canonicalize()
        .map_err(|e| format!("cannot resolve repository {}: {e}", root.display()))?;
    let current = verify_mutation_observation(
        &canonical,
        scope,
        expected_head.as_deref(),
        expected_status.as_deref(),
        expected_patch.as_deref(),
    )?;
    if scope == "unstaged"
        && current
            .files
            .iter()
            .any(|file| paths.iter().any(|path| path == &file.path) && file.untracked)
    {
        return Err("untracked files are not deleted by Review; remove them explicitly in the project".to_string());
    }
    let flag = if scope == "staged" { "--staged" } else { "--worktree" };
    let mut args = vec!["restore", flag, "--"];
    args.extend(paths.iter().map(String::as_str));
    git_command(&canonical, &args)?;
    status(&canonical)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT_FIXTURE: AtomicU64 = AtomicU64::new(0);

    fn fixture_repo() -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "muse-git-test-{}-{}",
            std::process::id(),
            NEXT_FIXTURE.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&root).unwrap();
        let run = |args: &[&str]| {
            let output = Command::new("git")
                .args(args)
                .current_dir(&root)
                .output()
                .unwrap();
            assert!(output.status.success(), "git {:?}: {}", args, decode(&output.stderr));
        };
        run(&["init", "--quiet"]);
        fs::write(root.join("main.txt"), "one\n").unwrap();
        run(&["add", "--", "main.txt"]);
        run(&[
            "-c",
            "user.email=test@example.com",
            "-c",
            "user.name=Muse test",
            "commit",
            "--quiet",
            "-m",
            "initial",
        ]);
        root
    }

    #[test]
    fn status_uses_nul_delimiters_for_unicode_and_renames() {
        let bytes = b"## feature/x...origin/feature/x [ahead 2, behind 1]\0R  src/nouveau e.txt\0src/ancien e.txt\0 M src/caf\xC3\xA9.rs\0?? notes draft.md\0";
        let snapshot = parse_status(bytes, "/tmp/repo");
        assert_eq!(snapshot.branch.as_deref(), Some("feature/x"));
        assert_eq!(snapshot.upstream.as_deref(), Some("origin/feature/x"));
        assert_eq!((snapshot.ahead, snapshot.behind), (2, 1));
        assert_eq!(snapshot.files.len(), 3);
        assert_eq!(snapshot.files[0].change_type, "renamed");
        assert_eq!(
            snapshot.files[0].original_path.as_deref(),
            Some("src/ancien e.txt")
        );
        assert_eq!(snapshot.files[1].path, "src/café.rs");
        assert!(snapshot.files[2].untracked);
    }

    #[test]
    fn diff_extracts_hunks_counts_and_binary_marker() {
        let patch = b"diff --git a/src/lib.rs b/src/lib.rs\nindex 111..222 100644\n--- a/src/lib.rs\n+++ b/src/lib.rs\n@@ -3,2 +3,3 @@ fn main()\n old\n-old line\n+new line\n+another\ndiff --git a/assets/logo.png b/assets/logo.png\nBinary files a/assets/logo.png and b/assets/logo.png differ\n";
        let snapshot = parse_diff(patch, "/tmp/repo", "unstaged", None);
        assert_eq!(snapshot.files.len(), 2);
        assert_eq!(snapshot.files[0].additions, 2);
        assert_eq!(snapshot.files[0].deletions, 1);
        assert_eq!(snapshot.files[0].hunks[0].new_start, 3);
        assert!(snapshot.files[1].binary);
    }

    #[test]
    fn branch_diff_requires_explicit_base() {
        let error = diff(Path::new("."), "branch", None).unwrap_err();
        assert!(error.contains("explicit baseRef"));
    }

    #[test]
    fn branch_diff_rejects_option_like_base() {
        let error = diff(Path::new("."), "branch", Some("--cached".to_string())).unwrap_err();
        assert!(error.contains("cannot start with"));
    }

    #[test]
    fn status_fingerprint_changes_with_raw_payload() {
        let one = parse_status(b"## main\0", "/tmp/repo");
        let two = parse_status(b"## main\0 M src/main.rs\0", "/tmp/repo");
        assert_ne!(one.fingerprint, two.fingerprint);
    }

    #[test]
    fn mutation_paths_reject_absolute_and_parent_segments() {
        assert!(validate_paths(&["C:\\\\secret.txt".to_string()]).is_err());
        assert!(validate_paths(&["../outside.txt".to_string()]).is_err());
        assert!(validate_paths(&["src/main.rs".to_string()]).is_ok());
    }

    #[test]
    fn stage_and_restore_require_the_observed_snapshot() {
        let root = fixture_repo();
        fs::write(root.join("main.txt"), "one\ntwo\n").unwrap();
        let before = status(&root).unwrap();
        let unstaged = diff(&root, "unstaged", None).unwrap();
        let path = vec!["main.txt".to_string()];
        let staged = stage(
            &root,
            &path,
            before.head.clone(),
            Some(before.fingerprint.clone()),
            Some(unstaged.patch.clone()),
        )
        .unwrap();
        assert!(staged.files[0].staged);
        let staged_diff = diff(&root, "staged", None).unwrap();
        let unstaged_again = restore(
            &root,
            &path,
            "staged",
            staged.head.clone(),
            Some(staged.fingerprint.clone()),
            Some(staged_diff.patch),
        )
        .unwrap();
        assert!(unstaged_again.files[0].unstaged);
        let unstaged_diff = diff(&root, "unstaged", None).unwrap();
        let clean = restore(
            &root,
            &path,
            "unstaged",
            unstaged_again.head.clone(),
            Some(unstaged_again.fingerprint.clone()),
            Some(unstaged_diff.patch),
        )
        .unwrap();
        assert!(clean.files.is_empty());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn stale_status_rejects_a_mutation_before_git_runs() {
        let root = fixture_repo();
        fs::write(root.join("main.txt"), "one\ntwo\n").unwrap();
        let before = status(&root).unwrap();
        fs::write(root.join("main.txt"), "one\nthree\n").unwrap();
        let error = stage(
            &root,
            &["main.txt".to_string()],
            before.head,
            Some(before.fingerprint),
            None,
        )
        .unwrap_err();
        assert!(error.contains("status changed"));
        let _ = fs::remove_dir_all(root);
    }
}
