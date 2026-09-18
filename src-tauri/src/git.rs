//! Git inspection and guarded mutations for the conversation Review panel.
//!
//! Every mutation builds on an observed revision and bounded diff snapshot, so
//! a review can never imply that a file changed merely because a response
//! mentioned it.

use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
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
    pub remotes: Vec<GitRemote>,
    pub files: Vec<GitStatusFile>,
    pub observed_at: u64,
}

#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GitRemote {
    pub name: String,
    pub url: String,
}

#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitResult {
    pub hash: String,
    pub branch: Option<String>,
    pub subject: String,
}

#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GitPushResult {
    pub remote: String,
    pub branch: String,
    pub head: String,
}

#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GitPrResult {
  pub url: String,
  pub base: String,
  pub head: String,
  pub existing: bool,
}

#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GitWorktreeResult {
    pub repo_root: String,
    pub path: String,
    pub branch: String,
    pub base: String,
    pub created_at: u64,
}

#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GitWorktreeInspection {
    pub repo_root: String,
    pub path: String,
    pub branch: Option<String>,
    pub head: Option<String>,
    pub clean: bool,
    pub conflicted: bool,
    pub file_count: usize,
    /// Ignored files are reported separately from tracked/untracked changes:
    /// they are not removable by Review, but can hide generated artifacts
    /// during a handoff or setup review.
    pub ignored_file_count: usize,
    pub active_signals: Vec<String>,
    pub branch_referenced_elsewhere: bool,
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

fn redact_remote_url(raw: &str) -> String {
    let Some(scheme) = raw.find("://") else {
        return raw.to_string();
    };
    let authority_start = scheme + 3;
    let Some(at) = raw[authority_start..].find('@') else {
        return raw.to_string();
    };
    format!(
        "{}***@{}",
        &raw[..authority_start],
        &raw[authority_start + at + 1..]
    )
}

fn parse_remotes(bytes: &[u8]) -> Vec<GitRemote> {
    let mut remotes = Vec::new();
    for line in decode(bytes).lines() {
        let mut parts = line.split_whitespace();
        let Some(name) = parts.next() else { continue };
        let Some(url) = parts.next() else { continue };
        if !remotes.iter().any(|remote: &GitRemote| remote.name == name) {
            remotes.push(GitRemote {
                name: name.to_string(),
                url: redact_remote_url(url),
            });
        }
    }
    remotes
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

fn git_command_with_input(root: &Path, args: &[&str], input: &str) -> Result<Vec<u8>, String> {
    if !root.is_dir() {
        return Err(format!("workspace is not a directory: {}", root.display()));
    }
    let mut child = Command::new("git")
        .args(args)
        .current_dir(root)
        .env("LC_ALL", "C")
        .env("LANG", "C")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("could not start git: {e}"))?;
    if let Some(stdin) = child.stdin.as_mut() {
        stdin
            .write_all(input.as_bytes())
            .map_err(|e| format!("could not provide git patch: {e}"))?;
    }
    let output = child
        .wait_with_output()
        .map_err(|e| format!("could not finish git: {e}"))?;
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
        remotes: Vec::new(),
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
        &[
            "diff",
            "--no-ext-diff",
            "--binary",
            "--full-index",
            "--no-color",
        ],
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
    snapshot.remotes = git_command(&canonical, &["remote", "-v"])
        .map(|output| parse_remotes(&output))
        .unwrap_or_default();
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
        // `Path` only understands the host OS syntax. Git paths cross the
        // Tauri boundary as strings, so reject Windows drive/UNC forms even
        // when the supervisor itself is running on Linux (CI and WSL).
        let windows_absolute = path.starts_with("\\\\")
            || path.starts_with("//")
            || (path.len() >= 2
                && path.as_bytes()[0].is_ascii_alphabetic()
                && path.as_bytes()[1] == b':');
        let normalized = path.replace('\\', "/");
        if candidate.is_absolute()
            || windows_absolute
            || normalized.split('/').any(|segment| segment == "..")
            || candidate.components().any(|component| {
                matches!(
                    component,
                    Component::ParentDir | Component::RootDir | Component::Prefix(_)
                )
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
            return Err(
                "repository HEAD changed; refresh Review before applying this action".to_string(),
            );
        }
    }
    if let Some(expected) = expected_status.filter(|value| !value.trim().is_empty()) {
        if current.fingerprint != expected {
            return Err(
                "repository status changed; refresh Review before applying this action".to_string(),
            );
        }
    }
    if let Some(expected) = expected_patch {
        let actual = diff(root, scope, None)?.patch;
        if actual != expected {
            return Err(
                "the selected diff changed; refresh Review before applying this action".to_string(),
            );
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
        return Err(
            "untracked files are not deleted by Review; remove them explicitly in the project"
                .to_string(),
        );
    }
    let flag = if scope == "staged" {
        "--staged"
    } else {
        "--worktree"
    };
    let mut args = vec!["restore", flag, "--"];
    args.extend(paths.iter().map(String::as_str));
    git_command(&canonical, &args)?;
    status(&canonical)
}

fn extract_hunk_patch(patch: &str, path: &str, hunk_header: &str) -> Result<String, String> {
    let lines: Vec<&str> = patch.lines().collect();
    let mut section_start = None;
    let mut section_end = lines.len();
    for (index, line) in lines.iter().enumerate() {
        if !line.starts_with("diff --git ") {
            continue;
        }
        if let Some(start) = section_start {
            section_end = index;
            if diff_path_pair(lines[start]).0 == path {
                section_start = Some(start);
                break;
            }
        }
        section_start = Some(index);
    }
    let start = section_start.ok_or_else(|| format!("file is not present in the observed diff: {path}"))?;
    if section_end == lines.len() && diff_path_pair(lines[start]).0 != path {
        return Err(format!("file is not present in the observed diff: {path}"));
    }
    if diff_path_pair(lines[start]).0 != path {
        return Err(format!("file is not present in the observed diff: {path}"));
    }
    let hunk_start = (start + 1..section_end)
        .find(|index| lines[*index] == hunk_header)
        .ok_or_else(|| "selected hunk is not present in the observed diff".to_string())?;
    let hunk_end = (hunk_start + 1..section_end)
        .find(|index| lines[*index].starts_with("@@ "))
        .unwrap_or(section_end);
    let first_hunk = (start + 1..hunk_start)
        .find(|index| lines[*index].starts_with("@@ "))
        .unwrap_or(hunk_start);
    if lines[start + 1..hunk_start]
        .iter()
        .any(|line| line.starts_with("Binary files ") || *line == "GIT binary patch")
    {
        return Err("binary files do not support hunk actions".to_string());
    }
    let mut selected_lines = lines[start..first_hunk].to_vec();
    selected_lines.extend_from_slice(&lines[hunk_start..hunk_end]);
    let mut selected = selected_lines.join("\n");
    selected.push('\n');
    Ok(selected)
}

/// Apply exactly one observed unified diff hunk. The full diff snapshot is
/// checked first; the selected hunk is then extracted server-side so the UI
/// cannot submit an arbitrary patch or path.
pub fn apply_hunk(
    root: &Path,
    path: &str,
    scope: &str,
    action: &str,
    hunk_header: &str,
    expected_head: Option<String>,
    expected_status: Option<String>,
    expected_patch: Option<String>,
) -> Result<GitStatusSnapshot, String> {
    validate_paths(&[path.to_string()])?;
    if scope != "staged" && scope != "unstaged" {
        return Err(format!("unknown hunk scope: {scope}"));
    }
    if action != "stage" && action != "unstage" && action != "discard" {
        return Err(format!("unknown hunk action: {action}"));
    }
    if (action == "stage" || action == "discard") && scope != "unstaged" {
        return Err("stage and discard hunk actions require an unstaged diff".to_string());
    }
    if action == "unstage" && scope != "staged" {
        return Err("unstage hunk actions require a staged diff".to_string());
    }
    let canonical = root
        .canonicalize()
        .map_err(|e| format!("cannot resolve repository {}: {e}", root.display()))?;
    verify_mutation_observation(
        &canonical,
        scope,
        expected_head.as_deref(),
        expected_status.as_deref(),
        expected_patch.as_deref(),
    )?;
    let observed = diff(&canonical, scope, None)?;
    if observed.patch_truncated {
        return Err("the observed diff is truncated; load a smaller diff before applying a hunk".to_string());
    }
    let selected = extract_hunk_patch(&observed.patch, path, hunk_header)?;
    let mut args = vec!["apply", "--whitespace=nowarn"];
    if action == "stage" || action == "unstage" {
        args.push("--cached");
    }
    if action == "unstage" || action == "discard" {
        args.push("--reverse");
    }
    args.push("-");
    git_command_with_input(&canonical, &args, &selected)?;
    status(&canonical)
}

fn validate_ref(value: &str, label: &str) -> Result<(), String> {
    let value = value.trim();
    if value.is_empty() {
        return Err(format!("{label} must not be empty"));
    }
    if value.starts_with('-') || value.contains('\0') || value.chars().any(char::is_whitespace) {
        return Err(format!("{label} is not a safe Git reference"));
    }
    Ok(())
}

fn worktree_path(root: &Path, relative_path: &str) -> Result<PathBuf, String> {
    let value = relative_path.trim();
    if value.is_empty() {
        return Err("worktree path must not be empty".to_string());
    }
    let relative = Path::new(value);
    if relative.is_absolute() || relative.components().any(|component| {
        matches!(component, Component::ParentDir | Component::RootDir | Component::Prefix(_))
    }) {
        return Err("worktree path must be relative and stay inside .muse/worktrees".to_string());
    }
    let mut components = relative.components();
    if components.next() != Some(Component::Normal(".muse".as_ref()))
        || components.next() != Some(Component::Normal("worktrees".as_ref()))
        || components.next().is_none()
    {
        return Err("worktree path must start with .muse/worktrees/".to_string());
    }
    let candidate = root.join(relative);
    if candidate.exists() {
        return Err(format!("worktree path already exists: {}", candidate.display()));
    }
    if let Some(parent) = candidate.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("could not prepare worktree parent: {e}"))?;
    }
    Ok(candidate)
}

/// Create a managed worktree below `.muse/worktrees/` from an explicit base
/// ref. The path and refs are validated before Git runs; no shell is involved.
pub fn create_worktree(
    root: &Path,
    branch: &str,
    relative_path: &str,
    base_ref: &str,
) -> Result<GitWorktreeResult, String> {
    validate_ref(branch, "worktree branch")?;
    validate_ref(base_ref, "worktree base")?;
    let canonical = root
        .canonicalize()
        .map_err(|e| format!("cannot resolve repository {}: {e}", root.display()))?;
    let candidate = worktree_path(&canonical, relative_path)?;
    // Keep the worktree argument relative to `current_dir`; Windows Git
    // rejects the extended `//?/C:` spelling returned by canonicalize().
    let candidate_display = relative_path.trim().to_string();
    let args = [
        "worktree",
        "add",
        "-b",
        branch.trim(),
        candidate_display.as_str(),
        base_ref.trim(),
    ];
    if let Err(error) = git_command(&canonical, &args) {
        let _ = std::fs::remove_dir(&candidate);
        return Err(error);
    }
    let path = candidate
        .canonicalize()
        .map_err(|e| format!("worktree created but path cannot be resolved: {e}"))?;
    Ok(GitWorktreeResult {
        repo_root: canonical.display().to_string(),
        path: path.display().to_string(),
        branch: branch.trim().to_string(),
        base: base_ref.trim().to_string(),
        created_at: now_ms(),
    })
}

/// Remove a managed worktree after verifying that its canonical path remains
/// below `.muse/worktrees/`. This operation is intentionally forceful only
/// after the UI's explicit confirmation; paths outside the managed root are
/// rejected before Git runs.
fn resolve_managed_worktree(root: &Path, path: &str) -> Result<(PathBuf, PathBuf), String> {
    let canonical = root
        .canonicalize()
        .map_err(|e| format!("cannot resolve repository {}: {e}", root.display()))?;
    let managed_root = canonical.join(".muse").join("worktrees");
    let managed_root = managed_root
        .canonicalize()
        .map_err(|e| format!("cannot resolve managed worktree root: {e}"))?;
    let raw_candidate = Path::new(path.trim());
    let candidate_path = if raw_candidate.is_absolute() {
        raw_candidate.to_path_buf()
    } else {
        canonical.join(raw_candidate)
    };
    let candidate = candidate_path
        .canonicalize()
        .map_err(|e| format!("cannot resolve worktree path: {e}"))?;
    if candidate == managed_root || !candidate.starts_with(&managed_root) || !candidate.is_dir() {
        return Err("worktree path is outside .muse/worktrees".to_string());
    }
    Ok((canonical, candidate))
}

/// Report conservative signals that a worktree may still be in use. Git's
/// lock and in-progress markers are portable across the supported hosts; a
/// missing signal never proves that no external process is running.
fn worktree_activity(
    repo_root: &Path,
    candidate: &Path,
    branch: Option<&str>,
) -> (Vec<String>, bool) {
    let mut signals = Vec::new();
    let markers = [
        ("index lock", "index.lock"),
        ("merge in progress", "MERGE_HEAD"),
        ("cherry-pick in progress", "CHERRY_PICK_HEAD"),
        ("revert in progress", "REVERT_HEAD"),
        ("rebase in progress", "rebase-merge"),
        ("rebase in progress", "rebase-apply"),
    ];
    for (label, marker) in markers {
        let Ok(raw) = git_command(candidate, &["rev-parse", "--git-path", marker]) else {
            continue;
        };
        let raw = decode(&raw).trim().to_string();
        if raw.is_empty() {
            continue;
        }
        let marker_path = Path::new(&raw);
        let marker_path = if marker_path.is_absolute() {
            marker_path.to_path_buf()
        } else {
            candidate.join(marker_path)
        };
        if marker_path.exists() && !signals.iter().any(|value| value == label) {
            signals.push(label.to_string());
        }
    }

    let branch_referenced_elsewhere = branch.is_some_and(|branch| {
        let target = format!("refs/heads/{branch}");
        let Ok(bytes) = git_command(repo_root, &["worktree", "list", "--porcelain"]) else {
            return false;
        };
        let mut current_path: Option<PathBuf> = None;
        for line in decode(&bytes).lines() {
            if let Some(raw) = line.strip_prefix("worktree ") {
                current_path = Path::new(raw.trim()).canonicalize().ok();
            } else if line == format!("branch {target}") {
                if current_path.as_deref() != Some(candidate) {
                    return true;
                }
            }
        }
        false
    });
    if branch_referenced_elsewhere {
        signals.push("branch checked out elsewhere".to_string());
    }
    (signals, branch_referenced_elsewhere)
}

/// Count ignored files without returning their paths. Ignored content is
/// intentionally kept out of the renderer transcript; the count is enough to
/// prompt an explicit review while preserving the existing status bounds.
fn ignored_file_count(root: &Path) -> usize {
    let Ok(bytes) = git_command(
        root,
        &["ls-files", "--others", "--ignored", "--exclude-standard", "-z"],
    ) else {
        return 0;
    };
    bytes
        .split(|byte| *byte == 0)
        .filter(|entry| !entry.is_empty())
        .take(MAX_FILES)
        .count()
}

/// Inspect one managed worktree before a retention or handoff action.
pub fn inspect_worktree(root: &Path, path: &str) -> Result<GitWorktreeInspection, String> {
    let (canonical, candidate) = resolve_managed_worktree(root, path)?;
    let snapshot = status(&candidate)?;
    let (active_signals, branch_referenced_elsewhere) =
        worktree_activity(&canonical, &candidate, snapshot.branch.as_deref());
    Ok(GitWorktreeInspection {
        repo_root: canonical.display().to_string(),
        path: candidate.display().to_string(),
        branch: snapshot.branch,
        head: snapshot.head,
        clean: snapshot.files.is_empty(),
        conflicted: snapshot.files.iter().any(|file| file.conflicted),
        file_count: snapshot.files.len(),
        ignored_file_count: ignored_file_count(&candidate),
        active_signals,
        branch_referenced_elsewhere,
        observed_at: now_ms(),
    })
}

/// Remove a managed worktree only after its working tree is clean. Dirty
/// checkouts are preserved so a mistaken cleanup cannot discard user work.
pub fn remove_worktree(root: &Path, path: &str) -> Result<(), String> {
    let inspection = inspect_worktree(root, path)?;
    if !inspection.clean {
        return Err(
            "worktree has uncommitted changes; inspect and commit or clean it before removal"
                .to_string(),
        );
    }
    if !inspection.active_signals.is_empty() {
        return Err(format!(
            "worktree appears active ({}); stop the operation and inspect again before removal",
            inspection.active_signals.join(", ")
        ));
    }
    if inspection.branch_referenced_elsewhere {
        return Err(
            "worktree branch is checked out elsewhere; refresh the inspection before removal"
                .to_string(),
        );
    }
    let canonical = Path::new(&inspection.repo_root);
    let candidate = Path::new(&inspection.path);
    let relative = candidate
        .strip_prefix(&canonical)
        .map_err(|_| "worktree path is outside the repository".to_string())?
        .to_string_lossy()
        .replace('\\', "/");
    git_command(&canonical, &["worktree", "remove", "--force", &relative])?;
    Ok(())
}

/// Commit the current index after checking the status/diff observation used
/// by the Review UI. Git hook failures and empty indexes remain user-visible.
pub fn commit(
    root: &Path,
    message: &str,
    expected_head: Option<String>,
    expected_status: Option<String>,
    expected_patch: Option<String>,
) -> Result<GitCommitResult, String> {
    let message = message.trim();
    if message.is_empty() {
        return Err("commit message must not be empty".to_string());
    }
    if message.chars().count() > 500 {
        return Err("commit message is limited to 500 characters".to_string());
    }
    let canonical = root
        .canonicalize()
        .map_err(|e| format!("cannot resolve repository {}: {e}", root.display()))?;
    let current = verify_mutation_observation(
        &canonical,
        "staged",
        expected_head.as_deref(),
        expected_status.as_deref(),
        expected_patch.as_deref(),
    )?;
    if !current.files.iter().any(|file| file.staged) {
        return Err("nothing staged to commit".to_string());
    }
    git_command(&canonical, &["commit", "-m", message])?;
    let hash =
        head(&canonical).ok_or_else(|| "commit succeeded but HEAD is unavailable".to_string())?;
    let subject = git_command(&canonical, &["log", "-1", "--format=%s"])
        .map(|bytes| decode(&bytes).trim().to_string())
        .unwrap_or_else(|_| message.to_string());
    let branch = git_command(&canonical, &["branch", "--show-current"])
        .ok()
        .map(|bytes| decode(&bytes).trim().to_string())
        .filter(|value| !value.is_empty());
    Ok(GitCommitResult {
        hash,
        branch,
        subject,
    })
}

/// Push an explicit branch to an explicit remote. The refspec is written as
/// `HEAD:refs/heads/<branch>` so the current checkout can never redirect the
/// push to another branch by default.
pub fn push(
    root: &Path,
    remote: &str,
    branch: &str,
    expected_head: Option<String>,
) -> Result<GitPushResult, String> {
    validate_ref(remote, "remote")?;
    validate_ref(branch, "branch")?;
    let expected = expected_head
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "push requires an observed HEAD".to_string())?;
    let canonical = root
        .canonicalize()
        .map_err(|e| format!("cannot resolve repository {}: {e}", root.display()))?;
    let current =
        head(&canonical).ok_or_else(|| "cannot push without a repository HEAD".to_string())?;
    if current != expected {
        return Err("repository HEAD changed; refresh Review before pushing".to_string());
    }
    let remotes = git_command(&canonical, &["remote"])?;
    if !decode(&remotes)
        .lines()
        .any(|name| name.trim() == remote.trim())
    {
        return Err(format!("remote does not exist: {remote}"));
    }
    let refspec = format!("HEAD:refs/heads/{branch}");
    git_command(&canonical, &["push", remote.trim(), &refspec])?;
    Ok(GitPushResult {
        remote: remote.trim().to_string(),
        branch: branch.trim().to_string(),
        head: current,
    })
}

fn ensure_remote(canonical: &Path, remote: &str) -> Result<(), String> {
    let remotes = git_command(canonical, &["remote"])?;
    if !decode(&remotes)
        .lines()
        .any(|name| name.trim() == remote.trim())
    {
        return Err(format!("remote does not exist: {remote}"));
    }
    Ok(())
}

/// Fetch one explicitly selected remote without pruning unrelated refs.
/// Fetch is deliberately separate from pull: it updates remote-tracking refs
/// while leaving the checked-out worktree untouched.
pub fn fetch(root: &Path, remote: &str) -> Result<GitStatusSnapshot, String> {
    validate_ref(remote, "remote")?;
    let canonical = root
        .canonicalize()
        .map_err(|e| format!("cannot resolve repository {}: {e}", root.display()))?;
    ensure_remote(&canonical, remote)?;
    git_command(&canonical, &["fetch", "--no-prune", remote.trim()])?;
    status(&canonical)
}

/// Fast-forward the current checkout from an explicit remote branch.
///
/// Pull is guarded by both the observed HEAD and the complete status
/// fingerprint, and requires a clean worktree. `--ff-only` prevents an
/// implicit merge commit or conflict resolution from being hidden behind one
/// button; the user can inspect and resolve a divergent branch explicitly.
pub fn pull(
    root: &Path,
    remote: &str,
    branch: &str,
    expected_head: Option<String>,
    expected_status: Option<String>,
) -> Result<GitStatusSnapshot, String> {
    validate_ref(remote, "remote")?;
    validate_ref(branch, "branch")?;
    let expected = expected_head
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "pull requires an observed HEAD".to_string())?;
    let expected_status = expected_status
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "pull requires an observed repository status".to_string())?;
    let canonical = root
        .canonicalize()
        .map_err(|e| format!("cannot resolve repository {}: {e}", root.display()))?;
    let current = status(&canonical)?;
    if current.head.as_deref() != Some(expected) {
        return Err("repository HEAD changed; refresh Review before pulling".to_string());
    }
    if current.fingerprint != expected_status {
        return Err("repository status changed; refresh Review before pulling".to_string());
    }
    if !current.files.is_empty() {
        return Err(
            "pull requires a clean worktree; commit or stash local changes before pulling"
                .to_string(),
        );
    }
    ensure_remote(&canonical, remote)?;
    let current_branch = current
        .branch
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "pull requires a checked-out branch".to_string())?;
    git_command(
        &canonical,
        &["pull", "--ff-only", remote.trim(), branch.trim()],
    )?;
    let next = status(&canonical)?;
    if next.branch.as_deref() != Some(current_branch) {
        return Err("pull changed the checked-out branch unexpectedly".to_string());
    }
    Ok(next)
}

fn gh_command(root: &Path, args: &[&str]) -> Result<String, String> {
    let output = Command::new("gh")
        .args(args)
        .current_dir(root)
        .env("GH_NO_UPDATE_NOTIFIER", "1")
        .output()
        .map_err(|e| format!("could not start GitHub CLI: {e}"))?;
    if !output.status.success() {
        let detail = decode(&output.stderr).trim().to_string();
        return Err(if detail.is_empty() {
            format!("gh {} failed with {}", args.join(" "), output.status)
        } else {
            detail
        });
    }
    Ok(decode(&output.stdout))
}

/// Parse the bounded JSON returned by `gh pr list --json url`. The command is
/// filtered to one open PR by the caller; this helper only accepts a verified
/// HTTP(S) URL and ignores malformed rows rather than exposing arbitrary text.
fn parse_existing_pr_url(output: &str) -> Result<Option<String>, String> {
    let parsed: serde_json::Value = serde_json::from_str(output)
        .map_err(|e| format!("GitHub CLI returned invalid pull request JSON: {e}"))?;
    let rows = parsed
        .as_array()
        .ok_or_else(|| "GitHub CLI returned an unexpected pull request list".to_string())?;
    for row in rows.iter().take(1) {
        let Some(url) = row.get("url").and_then(serde_json::Value::as_str) else {
            continue;
        };
        if url.starts_with("https://") || url.starts_with("http://") {
            return Ok(Some(url.to_string()));
        }
    }
    Ok(None)
}

/// Create a GitHub pull request through the user's existing `gh` auth. No
/// credentials are read from or written to web storage, and merge is never
/// attempted by this command.
pub fn create_pr(
    root: &Path,
    title: &str,
    body: &str,
    base: &str,
    head_branch: &str,
) -> Result<GitPrResult, String> {
    let title = title.trim();
    let body = body.trim();
    if title.is_empty() {
        return Err("pull request title must not be empty".to_string());
    }
    if title.chars().count() > 200 || body.chars().count() > 20_000 {
        return Err("pull request title/body exceeds its size limit".to_string());
    }
    validate_ref(base, "base branch")?;
    validate_ref(head_branch, "head branch")?;
    let canonical = root
        .canonicalize()
        .map_err(|e| format!("cannot resolve repository {}: {e}", root.display()))?;
    let existing = gh_command(
        &canonical,
        &[
            "pr",
            "list",
            "--head",
            head_branch.trim(),
            "--base",
            base.trim(),
            "--state",
            "open",
            "--json",
            "url",
            "--limit",
            "1",
        ],
    )?;
    if let Some(url) = parse_existing_pr_url(&existing)? {
        return Ok(GitPrResult {
            url,
            base: base.trim().to_string(),
            head: head_branch.trim().to_string(),
            existing: true,
        });
    }
    let output = gh_command(
        &canonical,
        &[
            "pr",
            "create",
            "--base",
            base.trim(),
            "--head",
            head_branch.trim(),
            "--title",
            title,
            "--body",
            body,
        ],
    )?;
    let url = output
        .lines()
        .rev()
        .flat_map(str::split_whitespace)
        .map(|value| value.trim_matches(|c: char| matches!(c, ')' | ']' | '.' | ',')))
        .find(|value| value.starts_with("https://") || value.starts_with("http://"))
        .ok_or_else(|| "GitHub CLI created a pull request but returned no URL".to_string())?;
    Ok(GitPrResult {
        url: url.to_string(),
        base: base.trim().to_string(),
        head: head_branch.trim().to_string(),
        existing: false,
    })
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
        // Keep reruns deterministic when an earlier assertion aborted before
        // its cleanup path.
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let run = |args: &[&str]| {
            let output = Command::new("git")
                .args(args)
                .current_dir(&root)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "git {:?}: {}",
                args,
                decode(&output.stderr)
            );
        };
        run(&["init", "--quiet"]);
        // Keep commit tests independent of the runner's global Git identity.
        // CI images intentionally have no user.name/user.email configured.
        run(&["config", "user.email", "test@example.com"]);
        run(&["config", "user.name", "Muse test"]);
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
    fn create_worktree_checks_path_and_returns_real_checkout() {
        let root = fixture_repo();
        let result = create_worktree(&root, "task/one", ".muse/worktrees/agent-one", "HEAD")
            .unwrap();
        assert_eq!(result.branch, "task/one");
        assert_eq!(result.base, "HEAD");
        assert!(Path::new(&result.path).join("main.txt").is_file());
        assert!(result.path.starts_with(&result.repo_root));
        assert!(create_worktree(&root, "task/two", "../outside", "HEAD").is_err());
        assert!(create_worktree(&root, "task/two", ".muse/other/agent", "HEAD").is_err());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn create_worktree_rejects_existing_path_and_unsafe_refs() {
        let root = fixture_repo();
        fs::create_dir_all(root.join(".muse/worktrees/existing")).unwrap();
        assert!(create_worktree(&root, "-bad", ".muse/worktrees/one", "HEAD").is_err());
        assert!(create_worktree(&root, "task/one", ".muse/worktrees/existing", "HEAD").is_err());
        assert!(create_worktree(&root, "task/two", ".muse/worktrees/two", "--bad").is_err());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn remove_worktree_stays_confined_to_managed_root() {
        let root = fixture_repo();
        let created = create_worktree(&root, "task/remove", ".muse/worktrees/remove", "HEAD")
            .unwrap();
        remove_worktree(&root, &created.path).unwrap();
        assert!(!Path::new(&created.path).exists());
        assert!(remove_worktree(&root, root.to_string_lossy().as_ref()).is_err());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn inspect_reports_dirty_worktree_and_cleanup_preserves_it() {
        let root = fixture_repo();
        fs::write(root.join(".gitignore"), "target/\n").unwrap();
        let add_ignore = Command::new("git")
            .args(["-C", root.to_string_lossy().as_ref(), "add", "--", ".gitignore"])
            .output()
            .unwrap();
        assert!(add_ignore.status.success());
        let commit_ignore = Command::new("git")
            .args([
                "-C",
                root.to_string_lossy().as_ref(),
                "commit",
                "--quiet",
                "-m",
                "ignore generated files",
            ])
            .output()
            .unwrap();
        assert!(commit_ignore.status.success());
        let created = create_worktree(&root, "task/inspect", ".muse/worktrees/inspect", "HEAD")
            .unwrap();
        fs::create_dir_all(Path::new(&created.path).join("target")).unwrap();
        fs::write(Path::new(&created.path).join("target/generated.bin"), b"generated").unwrap();
        fs::write(Path::new(&created.path).join("main.txt"), "changed\n").unwrap();
        let inspected = inspect_worktree(&root, &created.path).unwrap();
        assert!(!inspected.clean);
        assert_eq!(inspected.file_count, 1);
        assert_eq!(inspected.ignored_file_count, 1);
        assert!(remove_worktree(&root, &created.path).is_err());
        let restored = Command::new("git")
            .args(["-C", &created.path, "restore", "--", "main.txt"])
            .output()
            .unwrap();
        assert!(restored.status.success());
        remove_worktree(&root, &created.path).unwrap();
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn inspect_reports_git_activity_and_cleanup_preserves_a_locked_worktree() {
        let root = fixture_repo();
        let created = create_worktree(&root, "task/active", ".muse/worktrees/active", "HEAD")
            .unwrap();
        let raw_lock = decode(
            &git_command(Path::new(&created.path), &["rev-parse", "--git-path", "index.lock"])
                .unwrap(),
        )
        .trim()
        .to_string();
        let lock = if Path::new(&raw_lock).is_absolute() {
            PathBuf::from(&raw_lock)
        } else {
            Path::new(&created.path).join(&raw_lock)
        };
        fs::write(&lock, b"locked").unwrap();
        let inspected = inspect_worktree(&root, &created.path).unwrap();
        assert!(inspected.clean);
        assert!(inspected.active_signals.iter().any(|signal| signal == "index lock"));
        assert!(remove_worktree(&root, &created.path).is_err());
        fs::remove_file(lock).unwrap();
        remove_worktree(&root, &created.path).unwrap();
        let _ = fs::remove_dir_all(root);
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
    fn apply_hunk_stages_unstages_and_discards_only_the_selected_hunk() {
        let root = fixture_repo();
        let original = (1..=30).map(|line| format!("line-{line}\n")).collect::<String>();
        fs::write(root.join("main.txt"), &original).unwrap();
        let commit_base = Command::new("git")
            .args(["add", "--", "main.txt"])
            .current_dir(&root)
            .output()
            .unwrap();
        assert!(commit_base.status.success());
        let commit_base = Command::new("git")
            .args(["commit", "--quiet", "-m", "expanded base"])
            .current_dir(&root)
            .output()
            .unwrap();
        assert!(commit_base.status.success());
        let mut changed = original.clone();
        changed = changed.replace("line-2\n", "changed-2\n");
        changed = changed.replace("line-25\n", "changed-25\n");
        fs::write(root.join("main.txt"), changed).unwrap();
        let before = status(&root).unwrap();
        let patch = diff(&root, "unstaged", None).unwrap();
        assert_eq!(patch.files[0].hunks.len(), 2);
        let second = patch.files[0].hunks[1].header.clone();
        let staged = apply_hunk(
            &root,
            "main.txt",
            "unstaged",
            "stage",
            &second,
            before.head.clone(),
            Some(before.fingerprint.clone()),
            Some(patch.patch.clone()),
        )
        .unwrap();
        assert!(staged.files[0].staged && staged.files[0].unstaged);
        let staged_patch = decode(&git_command(&root, &["diff", "--cached"]).unwrap());
        let unstaged_patch = decode(&git_command(&root, &["diff"]).unwrap());
        assert!(staged_patch.contains("line-25"));
        assert!(unstaged_patch.contains("line-2"));

        let staged_diff = diff(&root, "staged", None).unwrap();
        let unstage = apply_hunk(
            &root,
            "main.txt",
            "staged",
            "unstage",
            &staged_diff.files[0].hunks[0].header,
            staged.head.clone(),
            Some(staged.fingerprint.clone()),
            Some(staged_diff.patch.clone()),
        )
        .unwrap();
        assert!(unstage.files[0].unstaged);
        assert!(!unstage.files[0].staged);

        let remaining = diff(&root, "unstaged", None).unwrap();
        let discard = apply_hunk(
            &root,
            "main.txt",
            "unstaged",
            "discard",
            &remaining.files[0].hunks[0].header,
            unstage.head,
            Some(unstage.fingerprint),
            Some(remaining.patch),
        )
        .unwrap();
        assert!(discard.files[0].unstaged);
        let final_patch = diff(&root, "unstaged", None).unwrap();
        assert!(!final_patch.patch.contains("+changed-2\n"));
        assert!(final_patch.patch.contains("+changed-25\n"));
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

    #[test]
    fn commit_returns_new_hash_and_subject() {
        let root = fixture_repo();
        fs::write(root.join("main.txt"), "one\ntwo\n").unwrap();
        let before = status(&root).unwrap();
        let unstaged = diff(&root, "unstaged", None).unwrap();
        let path = vec!["main.txt".to_string()];
        let staged = stage(
            &root,
            &path,
            before.head,
            Some(before.fingerprint),
            Some(unstaged.patch),
        )
        .unwrap();
        let staged_diff = diff(&root, "staged", None).unwrap();
        let result = commit(
            &root,
            "Add second line",
            staged.head.clone(),
            Some(staged.fingerprint),
            Some(staged_diff.patch),
        )
        .unwrap();
        assert_ne!(result.hash, "");
        assert_eq!(result.subject, "Add second line");
        assert_ne!(result.hash, staged.head.unwrap_or_default());
        assert!(status(&root).unwrap().files.is_empty());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn push_requires_an_existing_explicit_remote() {
        let root = fixture_repo();
        let head_hash = status(&root).unwrap().head;
        let error = push(&root, "origin", "main", head_hash).unwrap_err();
        assert!(error.contains("remote does not exist"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn fetch_requires_an_existing_explicit_remote() {
        let root = fixture_repo();
        let error = fetch(&root, "origin").unwrap_err();
        assert!(error.contains("remote does not exist"));
        assert!(fetch(&root, "--all").is_err());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn pull_rejects_dirty_or_stale_observations_before_git_runs() {
        let root = fixture_repo();
        let remote = root.with_file_name(format!(
            "{}-remote.git",
            root.file_name().unwrap().to_string_lossy()
        ));
        let remote_path = remote.to_string_lossy().to_string();
        let _ = fs::remove_dir_all(&remote);
        let init_remote = Command::new("git")
            .args(["init", "--bare", "--quiet", &remote_path])
            .current_dir(&root)
            .output()
            .unwrap();
        assert!(init_remote.status.success());
        let add_remote = Command::new("git")
            .args(["remote", "add", "origin", &remote_path])
            .current_dir(&root)
            .output()
            .unwrap();
        assert!(add_remote.status.success());
        let before = status(&root).unwrap();
        fs::write(root.join("main.txt"), "dirty\n").unwrap();
        let error = pull(
            &root,
            "origin",
            "main",
            before.head.clone(),
            Some(before.fingerprint.clone()),
        )
        .unwrap_err();
        assert!(error.contains("status changed"));
        let after_dirty = status(&root).unwrap();
        let error = pull(
            &root,
            "origin",
            "main",
            after_dirty.head,
            Some(after_dirty.fingerprint),
        )
        .unwrap_err();
        assert!(error.contains("clean worktree"));
        let _ = fs::remove_dir_all(&remote);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn fetch_then_pull_fast_forwards_only_the_checked_out_branch() {
        let root = fixture_repo();
        let remote = root.with_file_name(format!(
            "{}-remote.git",
            root.file_name().unwrap().to_string_lossy()
        ));
        let remote_path = remote.to_string_lossy().to_string();
        let _ = fs::remove_dir_all(&remote);
        let clone = root.with_file_name(format!(
            "{}-clone",
            root.file_name().unwrap().to_string_lossy()
        ));
        let clone_path = clone.to_string_lossy().to_string();
        let _ = fs::remove_dir_all(&clone);
        let run_root = |args: &[&str]| {
            let output = Command::new("git")
                .args(args)
                .current_dir(&root)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "git {:?}: {}",
                args,
                decode(&output.stderr)
            );
        };
        run_root(&["branch", "-M", "main"]);
        let init_remote = Command::new("git")
            .args(["init", "--bare", "--quiet", &remote_path])
            .current_dir(&root)
            .output()
            .unwrap();
        assert!(init_remote.status.success());
        run_root(&["remote", "add", "origin", &remote_path]);
        run_root(&["push", "--quiet", "origin", "HEAD:refs/heads/main"]);
        let set_remote_head = Command::new("git")
            .args([
                "--git-dir",
                &remote_path,
                "symbolic-ref",
                "HEAD",
                "refs/heads/main",
            ])
            .current_dir(&root)
            .output()
            .unwrap();
        assert!(
            set_remote_head.status.success(),
            "symbolic-ref: {}",
            decode(&set_remote_head.stderr)
        );
        run_root(&["branch", "--set-upstream-to=origin/main", "main"]);
        let clone_result = Command::new("git")
            .args(["clone", "--quiet", &remote_path, &clone_path])
            .current_dir(&root)
            .output()
            .unwrap();
        assert!(
            clone_result.status.success(),
            "clone: {}",
            decode(&clone_result.stderr)
        );
        let run_clone = |args: &[&str]| {
            let output = Command::new("git")
                .args(args)
                .current_dir(&clone)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "git clone {:?}: {}",
                args,
                decode(&output.stderr)
            );
        };
        run_clone(&["config", "user.email", "test@example.com"]);
        run_clone(&["config", "user.name", "Muse test"]);
        fs::write(clone.join("remote.txt"), "remote update\n").unwrap();
        run_clone(&["add", "--", "remote.txt"]);
        run_clone(&["commit", "--quiet", "-m", "remote update"]);
        run_clone(&["push", "--quiet", "origin", "HEAD:refs/heads/main"]);

        let fetched = fetch(&root, "origin").unwrap();
        assert_eq!(fetched.branch.as_deref(), Some("main"));
        assert_eq!(fetched.behind, 1);
        let pulled = pull(
            &root,
            "origin",
            "main",
            fetched.head.clone(),
            Some(fetched.fingerprint.clone()),
        )
        .unwrap();
        assert_eq!(pulled.behind, 0);
        assert_eq!(pulled.ahead, 0);
        assert!(root.join("remote.txt").is_file());
        let _ = fs::remove_dir_all(&clone);
        let _ = fs::remove_dir_all(&remote);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn refs_reject_option_injection_and_whitespace() {
        assert!(validate_ref("--force", "branch").is_err());
        assert!(validate_ref("feature bad", "branch").is_err());
        assert!(validate_ref("feature/review", "branch").is_ok());
    }

    #[test]
    fn existing_pr_parser_accepts_only_a_bounded_http_url() {
        assert_eq!(
            parse_existing_pr_url(r#"[{"url":"https://github.com/acme/repo/pull/4"}]"#)
                .unwrap(),
            Some("https://github.com/acme/repo/pull/4".to_string())
        );
        assert_eq!(parse_existing_pr_url("[]").unwrap(), None);
        assert_eq!(parse_existing_pr_url(r#"[{"url":"file:///tmp/pr"}]"#).unwrap(), None);
        assert!(parse_existing_pr_url("not json").is_err());
    }
}
