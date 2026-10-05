//! Git inspection and guarded mutations for the conversation Review panel.
//!
//! Every mutation builds on an observed revision and bounded diff snapshot, so
//! a review can never imply that a file changed merely because a response
//! mentioned it.

use std::collections::HashSet;
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

/// Run git without judging its exit status (`merge-tree` answers conflicts
/// with exit 1 and its result on stdout). `index` points Git at an alternate
/// index, so a handoff can hash and write files without touching the
/// checkout's own index.
fn git_output(
    root: &Path,
    args: &[&str],
    input: Option<&str>,
    index: Option<&Path>,
) -> Result<std::process::Output, String> {
    if !root.is_dir() {
        return Err(format!("workspace is not a directory: {}", root.display()));
    }
    let mut command = Command::new("git");
    command
        .args(args)
        .current_dir(root)
        .env("LC_ALL", "C")
        .env("LANG", "C")
        .stdin(if input.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(index) = index {
        command.env("GIT_INDEX_FILE", index);
    }
    let mut child = command
        .spawn()
        .map_err(|e| format!("could not start git: {e}"))?;
    // Fed from another thread while this one drains stdout and stderr: Git
    // can fill stderr (a warning per file) before it reads all its input,
    // and then both sides would wait on each other forever.
    let writer = input.zip(child.stdin.take()).map(|(input, mut stdin)| {
        let input = input.to_owned();
        std::thread::spawn(move || stdin.write_all(input.as_bytes()))
    });
    let output = child
        .wait_with_output()
        .map_err(|e| format!("could not finish git: {e}"))?;
    if let Some(writer) = writer {
        writer
            .join()
            .unwrap_or_else(|_| Err(std::io::Error::other("the writer panicked")))
            .map_err(|e| format!("could not provide git input: {e}"))?;
    }
    Ok(output)
}

fn git_checked(args: &[&str], output: std::process::Output) -> Result<Vec<u8>, String> {
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

fn git_command(root: &Path, args: &[&str]) -> Result<Vec<u8>, String> {
    git_checked(args, git_output(root, args, None, None)?)
}

fn git_command_with_input(root: &Path, args: &[&str], input: &str) -> Result<Vec<u8>, String> {
    git_checked(args, git_output(root, args, Some(input), None)?)
}

fn git_with_index(
    root: &Path,
    index: &Path,
    args: &[&str],
    input: Option<&str>,
) -> Result<Vec<u8>, String> {
    git_checked(args, git_output(root, args, input, Some(index))?)
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
            // The app's own checkouts live in `.muse/`; repositories set up
            // before `.muse/.gitignore` existed listed them as changes.
            "--",
            ".",
            ":(exclude).muse",
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
    // `.muse/` holds the app's own checkouts. Without an ignore file every
    // worktree showed up as untracked "changes" of the repository in Review.
    let ignore = root.join(".muse").join(".gitignore");
    if !ignore.exists() {
        std::fs::write(&ignore, "# Muse-Desktop worktrees and state\n*\n")
            .map_err(|e| format!("could not write .muse/.gitignore: {e}"))?;
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

// ---------------------------------------------------------------------------
// M2-04 / M2-06: per-worktree environment setup, readiness and cleanup.
// ---------------------------------------------------------------------------

pub const WORKTREE_SETUP_MAX_CHARS: usize = 2000;
pub const WORKTREE_SETUP_TIMEOUT_SECS: u64 = 600;
pub const WORKTREE_OUTPUT_MAX_CHARS: usize = 8000;

/// The setup runner, readiness check and cleanup only ever touch checkouts
/// under `<repo>/.muse/worktrees`. The canonical-prefix compare is the single
/// gate every command goes through.
fn ensure_confined_worktree(root: &Path, path: &str) -> Result<PathBuf, String> {
    let canonical_root = root
        .canonicalize()
        .map_err(|e| format!("cannot resolve repository {}: {e}", root.display()))?;
    let worktrees_root = canonical_root.join(".muse").join("worktrees");
    let candidate = PathBuf::from(path);
    let canonical_candidate = candidate
        .canonicalize()
        .map_err(|e| format!("cannot resolve worktree path {path}: {e}"))?;
    if !canonical_candidate.starts_with(&worktrees_root) {
        return Err(
            "the command runs only inside a checkout under .muse/worktrees".to_string(),
        );
    }
    if !canonical_candidate.is_dir() {
        return Err(format!("worktree path is not a directory: {path}"));
    }
    Ok(canonical_candidate)
}

#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeSetupOutcome {
    /// `ready` (exit 0), `failed` (non-zero exit), `timedOut` (past the
    /// ten-minute bound) or `cancelled` (user cancellation).
    pub status: String,
    pub output: String,
    pub exit_code: Option<i32>,
    pub duration_ms: u64,
    /// Sorted keys of the environment the command actually received, so the
    /// user can see what leaked in without printing values.
    pub environment_keys: Vec<String>,
    /// Opaque handle the renderer passes to `git_worktree_setup_cancel`.
    pub token: String,
}

/// Run one user setup command inside a confined worktree.
///
/// The command is executed through the platform shell and polled so a
/// cancellation flag or the ten-minute bound both end it with a kill; output
/// is bounded to its tail. `cancelled_flag` is owned by the caller (the Tauri
/// state) so a second command can cancel a running one by token.
pub fn run_worktree_setup(
    root: &Path,
    path: &str,
    command: &str,
    token: &str,
    timeout_secs: u64,
    cancelled_flag: std::sync::Arc<std::sync::atomic::AtomicBool>,
    pid_slot: std::sync::Arc<std::sync::Mutex<Option<u32>>>,
) -> Result<WorktreeSetupOutcome, String> {
    let trimmed = command.trim();
    if trimmed.is_empty() {
        return Err("setup command is empty".to_string());
    }
    if trimmed.chars().count() > WORKTREE_SETUP_MAX_CHARS {
        return Err(format!(
            "setup command exceeds the {} character limit",
            WORKTREE_SETUP_MAX_CHARS
        ));
    }
    let dir = ensure_confined_worktree(root, path)?;
    let started = std::time::Instant::now();
    #[cfg(target_os = "windows")]
    let mut child = {
        use std::os::windows::process::CommandExt;
        Command::new("cmd")
            .args(["/C", trimmed])
            .current_dir(&dir)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
            .spawn()
            .map_err(|e| format!("setup command could not start: {e}"))?
    };
    #[cfg(not(target_os = "windows"))]
    let mut child = {
        Command::new("sh")
            .args(["-c", trimmed])
            .current_dir(&dir)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("setup command could not start: {e}"))?
    };
    *pid_slot.lock().expect("setup pid slot poisoned") = Some(child.id());
    // Drain both pipes on threads: a full pipe would stall the child.
    let stdout_pipe = child.stdout.take();
    let stderr_pipe = child.stderr.take();
    let mut readers: Vec<std::thread::JoinHandle<Vec<u8>>> = Vec::new();
    if let Some(mut pipe) = stdout_pipe {
        readers.push(std::thread::spawn(move || {
            let mut buffer = Vec::new();
            let _ = std::io::Read::read_to_end(&mut pipe, &mut buffer);
            buffer
        }));
    }
    if let Some(mut pipe) = stderr_pipe {
        readers.push(std::thread::spawn(move || {
            let mut buffer = Vec::new();
            let _ = std::io::Read::read_to_end(&mut pipe, &mut buffer);
            buffer
        }));
    }
    let environment_keys: Vec<String> = {
        let mut keys: Vec<String> = std::env::vars().map(|(key, _)| key).collect();
        keys.sort();
        keys.dedup();
        keys
    };
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(timeout_secs);
    let mut status;
    let mut exit_code: Option<i32> = None;
    loop {
        if cancelled_flag.load(std::sync::atomic::Ordering::Relaxed) {
            let _ = child.kill();
            let _ = child.wait();
            status = "cancelled";
            break;
        }
        match child.try_wait() {
            Ok(Some(exit)) => {
                exit_code = exit.code();
                status = if exit.success() { "ready" } else { "failed" };
                break;
            }
            Ok(None) => {}
            Err(e) => return Err(format!("setup wait failed: {e}")),
        }
        if std::time::Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            status = "timedOut";
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(250));
    }
    let mut output = String::new();
    for reader in readers {
        if let Ok(bytes) = reader.join() {
            output.push_str(&decode(&bytes));
        }
    }
    if output.chars().count() > WORKTREE_OUTPUT_MAX_CHARS {
        let tail: String = output.chars().skip(output.chars().count() - WORKTREE_OUTPUT_MAX_CHARS).collect();
        output = format!("…{tail}");
    }
    Ok(WorktreeSetupOutcome {
        status: status.to_string(),
        output,
        exit_code,
        duration_ms: started.elapsed().as_millis() as u64,
        environment_keys,
        token: token.to_string(),
    })
}

#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeReadiness {
    pub path: String,
    pub status: String,
    pub project_files: Vec<String>,
    pub tools: Vec<WorktreeToolAvailability>,
    pub checked_at: u64,
}

#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeToolAvailability {
    pub name: String,
    pub required: bool,
    pub available: bool,
}

fn tool_available(name: &str) -> bool {
    #[cfg(target_os = "windows")]
    let probe = Command::new("where").arg(name).output();
    #[cfg(not(target_os = "windows"))]
    let probe = Command::new("which").arg(name).output();
    matches!(probe, Ok(output) if output.status.success())
}

/// Detect the project files the worktree carries and whether the matching
/// toolchain is on PATH. `git` is always required; the others are required
/// only when their project file exists.
pub fn check_worktree_readiness(root: &Path, path: &str) -> Result<WorktreeReadiness, String> {
    let dir = ensure_confined_worktree(root, path)?;
    let candidates = [
        ("package.json", "node"),
        ("Cargo.toml", "cargo"),
        ("pyproject.toml", "python"),
        ("go.mod", "go"),
    ];
    let mut project_files = Vec::new();
    let mut tools = vec![WorktreeToolAvailability {
        name: "git".to_string(),
        required: true,
        available: tool_available("git"),
    }];
    for (file, tool) in candidates {
        if dir.join(file).is_file() {
            project_files.push(file.to_string());
            tools.push(WorktreeToolAvailability {
                name: tool.to_string(),
                required: true,
                available: tool_available(tool),
            });
        }
    }
    let status = if tools.iter().all(|tool| tool.available) {
        "ready"
    } else {
        "blocked"
    };
    let checked_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    Ok(WorktreeReadiness {
        path: dir.display().to_string(),
        status: status.to_string(),
        project_files,
        tools,
        checked_at,
    })
}

#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeInspection {
    pub path: String,
    pub branch: Option<String>,
    pub head: Option<String>,
    pub is_main: bool,
    pub clean: bool,
    pub conflicted: bool,
    pub modified_at_ms: u64,
}

/// Inspect every worktree of the repository: real branch, HEAD, cleanliness
/// and last-modified time, straight from Git and the filesystem.
pub fn inspect_worktrees(root: &Path) -> Result<Vec<WorktreeInspection>, String> {
    let canonical_root = root
        .canonicalize()
        .map_err(|e| format!("cannot resolve repository {}: {e}", root.display()))?;
    let listing = decode(&git_command(
        &canonical_root,
        &["worktree", "list", "--porcelain"],
    )?);
    let mut inspections = Vec::new();
    let mut current: Option<(PathBuf, Option<String>, Option<String>)> = None;
    for line in listing.lines() {
        if let Some(path) = line.strip_prefix("worktree ") {
            if let Some((path, branch, head)) = current.take() {
                inspections.push(finalize_inspection(&canonical_root, path, branch, head)?);
            }
            current = Some((PathBuf::from(path), None, None));
        } else if let Some(head) = line.strip_prefix("HEAD ") {
            if let Some(entry) = current.as_mut() {
                entry.2 = Some(head.trim().to_string());
            }
        } else if let Some(branch) = line.strip_prefix("branch ") {
            if let Some(entry) = current.as_mut() {
                entry.1 = Some(branch.trim().trim_start_matches("refs/heads/").to_string());
            }
        }
    }
    if let Some((path, branch, head)) = current.take() {
        inspections.push(finalize_inspection(&canonical_root, path, branch, head)?);
    }
    Ok(inspections)
}

fn finalize_inspection(
    canonical_root: &Path,
    path: PathBuf,
    branch: Option<String>,
    head: Option<String>,
) -> Result<WorktreeInspection, String> {
    // git prints the main worktree path with its own separators; canonicalise
    // both sides before comparing.
    let is_main = path
        .canonicalize()
        .map(|candidate| candidate == canonical_root)
        .unwrap_or(false);
    let status = decode(&git_command(&path, &["status", "--porcelain"])?);
    let clean = status.trim().is_empty();
    let conflicted = status
        .lines()
        .any(|line| line.starts_with("UU") || line.starts_with("AA") || line.starts_with("DD"));
    let modified_at_ms = fs_modified_ms(&path);
    Ok(WorktreeInspection {
        path: path.display().to_string(),
        branch,
        head,
        is_main,
        clean,
        conflicted,
        modified_at_ms,
    })
}

fn fs_modified_ms(path: &Path) -> u64 {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Remove one worktree. A dirty or conflicted checkout is refused unless the
/// caller explicitly acknowledges it; Git keeps the final word when a
/// checkout is locked.
pub fn remove_worktree(root: &Path, path: &str, force: bool) -> Result<(), String> {
    let dir = ensure_confined_worktree(root, path)?;
    let status = decode(&git_command(&dir, &["status", "--porcelain"])?);
    if !force && !status.trim().is_empty() {
        return Err("worktree has uncommitted changes; inspect it and confirm the forced removal".to_string());
    }
    let mut args = vec!["worktree", "remove"];
    if force {
        args.push("--force");
    }
    let dir_display = dir.display().to_string();
    args.push(&dir_display);
    git_command(
        &root.canonicalize().map_err(|e| format!("cannot resolve repository: {e}"))?,
        &args,
    )?;
    Ok(())
}

// --- M2-05: move uncommitted work between Local and a worktree

/// The app's own checkouts live under `.muse/` in the main checkout.
const EXCLUDE_MUSE: &str = ":(exclude).muse";

/// What a handoff moves, and what it leaves where it is.
#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HandoffPreview {
    pub source: String,
    pub target: Option<String>,
    /// Tracked paths with uncommitted changes, staged or not.
    pub tracked: usize,
    /// Untracked files that are not ignored.
    pub untracked: usize,
    /// Ignored entries, never moved (an ignored folder counts once).
    pub ignored: usize,
    /// Paths whose staged version differs from the file: only the file's
    /// version moves; the staged one stays in the snapshot.
    pub partly_staged: Vec<String>,
    /// Paths that would not merge into the target; any of them blocks the move.
    pub conflicts: Vec<String>,
    /// After a move: `refs/muse/handoff/<id>`, whose `source` and `target`
    /// commits hold both sides exactly as they were before it (files, and
    /// the index as second parent).
    pub snapshot: Option<String>,
}

/// One checkout frozen as Git objects without touching its files or its
/// index: HEAD, the index tree, and a tree (and commit) of every non-ignored
/// file on disk. `scratch` is a private index matching `tree`.
struct Side {
    dir: PathBuf,
    head: String,
    index: String,
    tree: String,
    commit: String,
    scratch: PathBuf,
}

/// Holds the private indexes; removed on every exit path.
struct Scratch(PathBuf);

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn oid(bytes: Vec<u8>) -> String {
    decode(&bytes).trim().to_string()
}

fn nul_fields(bytes: &[u8]) -> Vec<String> {
    bytes
        .split(|byte| *byte == 0)
        .filter(|field| !field.is_empty())
        .map(decode)
        .collect()
}

/// `dir` as the main checkout or one of its `.muse/worktrees` children,
/// attached to the repository of `repo`: they share the object store the
/// snapshots and the merge rely on.
pub fn attached_checkout(repo: &Path, dir: &Path) -> Result<PathBuf, String> {
    let listing = decode(&git_command(repo, &["worktree", "list", "--porcelain"])?);
    let attached: Vec<PathBuf> = listing
        .lines()
        .filter_map(|line| line.strip_prefix("worktree "))
        .filter_map(|path| Path::new(path).canonicalize().ok())
        .collect();
    let main = attached
        .first()
        .ok_or_else(|| "cannot resolve the main checkout".to_string())?;
    let canonical = dir
        .canonicalize()
        .map_err(|e| format!("cannot resolve {}: {e}", dir.display()))?;
    let checkout = if &canonical == main {
        canonical
    } else {
        ensure_confined_worktree(main, &canonical.display().to_string())?
    };
    if !attached.contains(&checkout) {
        return Err(format!("{} is not a checkout of this repository", checkout.display()));
    }
    Ok(checkout)
}

/// Both ends of a handoff, resolved and guarded.
pub fn handoff_pair(source: &Path, target: &Path) -> Result<(PathBuf, PathBuf), String> {
    let source = attached_checkout(source, source)?;
    let target = attached_checkout(&source, target)?;
    if source == target {
        return Err("the conversation is already in that folder".to_string());
    }
    Ok((source, target))
}

fn scratch_dir() -> Result<Scratch, String> {
    let dir = std::env::temp_dir().join(format!("muse-handoff-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).map_err(|e| format!("could not prepare the handoff: {e}"))?;
    Ok(Scratch(dir))
}

fn snapshot(dir: &Path, scratch: &Path, label: &str) -> Result<Side, String> {
    let head = oid(git_command(dir, &["rev-parse", "--verify", "HEAD"])?);
    // Work moved out of a merge, cherry-pick, revert or rebase in progress
    // would be missing from what concludes it; moved in, swept into it.
    let operations = [
        ("MERGE_HEAD", "merge"),
        ("CHERRY_PICK_HEAD", "cherry-pick"),
        ("REVERT_HEAD", "revert"),
        ("rebase-merge", "rebase"),
        ("rebase-apply", "rebase"),
    ];
    let args: Vec<&str> = ["rev-parse"]
        .into_iter()
        .chain(operations.iter().flat_map(|(state, _)| ["--git-path", *state]))
        .collect();
    let states = decode(&git_command(dir, &args)?);
    for ((_, operation), state) in operations.iter().zip(states.lines()) {
        if dir.join(state).exists() {
            return Err(format!("the {label} is in the middle of a {operation}; finish or abort it first"));
        }
    }
    let index = oid(git_command(dir, &["write-tree"])
        .map_err(|e| format!("the {label} has unresolved conflicts: {e}"))?);
    // Start from a copy of the real index so only what changed is hashed.
    let private = scratch.join(format!("{label}.index"));
    let real = dir.join(oid(git_command(dir, &["rev-parse", "--git-path", "index"])?));
    if real.is_file() {
        std::fs::copy(&real, &private)
            .map_err(|e| format!("could not read the {label} index: {e}"))?;
    }
    // `add -A` with this pathspec fails when `.muse` is ignored; `ls-files`
    // lists the same changes without complaint.
    let changes = git_with_index(
        dir,
        &private,
        &[
            "ls-files", "-z", "--modified", "--deleted", "--others", "--exclude-standard",
            "--", ".", EXCLUDE_MUSE,
        ],
        None,
    )?;
    if !changes.is_empty() {
        git_with_index(
            dir,
            &private,
            &["update-index", "--add", "--remove", "-z", "--stdin"],
            Some(&decode(&changes)),
        )?;
    }
    // `read-tree -m -u` trusts only refreshed stat data; the exit status of a
    // refresh only says that some files differ from the index.
    git_output(dir, &["update-index", "-q", "--refresh"], None, Some(&private))?;
    let tree = oid(git_with_index(dir, &private, &["write-tree"], None)?);
    // The index rides along as a second parent: a staged version the file
    // no longer holds stays reachable from the handoff refs.
    let staged = commit_tree(dir, &index, &["-p", &head], &format!("muse handoff: {label} index"))?;
    let message = format!("muse handoff: {label} {} (index {index})", dir.display());
    let commit = commit_tree(dir, &tree, &["-p", &head, "-p", &staged], &message)?;
    Ok(Side { dir: dir.to_path_buf(), head, index, tree, commit, scratch: private })
}

fn commit_tree(dir: &Path, tree: &str, parents: &[&str], message: &str) -> Result<String, String> {
    let identity = ["-c", "user.name=Muse-Desktop", "-c", "user.email=muse-desktop@localhost"];
    let args: Vec<&str> = identity
        .into_iter()
        .chain(["commit-tree", "--no-gpg-sign", tree])
        .chain(parents.iter().copied())
        .chain(["-m", message])
        .collect();
    Ok(oid(git_command(dir, &args)?))
}

/// Paths that differ between two trees, narrowed by a `--diff-filter` (empty
/// keeps them all).
fn tree_diff(dir: &Path, from: &str, to: &str, filter: &str) -> Result<Vec<String>, String> {
    let filter = format!("--diff-filter={filter}");
    Ok(nul_fields(&git_command(
        dir,
        &["diff-tree", "-r", "-z", "--name-only", "--no-renames", &filter, from, to],
    )?))
}

fn handoff_counts(side: &Side) -> Result<HandoffPreview, String> {
    let dir = &side.dir;
    let changed = tree_diff(dir, &side.head, &side.tree, "")?.len();
    let untracked = nul_fields(&git_command(
        dir,
        &["ls-files", "-z", "--others", "--exclude-standard", "--", ".", EXCLUDE_MUSE],
    )?)
    .len();
    // A collapsed `.muse/` escapes the exclude pathspec, hence the filter.
    let ignored = nul_fields(&git_command(
        dir,
        &["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory"],
    )?)
    .into_iter()
    .filter(|entry| entry.trim_end_matches('/') != ".muse")
    .count();
    // Staged, then changed again on disk: the file's version is the one that moves.
    let unstaged: HashSet<String> = tree_diff(dir, &side.index, &side.tree, "")?.into_iter().collect();
    let partly_staged = tree_diff(dir, &side.head, &side.index, "")?
        .into_iter()
        .filter(|path| unstaged.contains(path))
        .collect();
    Ok(HandoffPreview {
        source: dir.display().to_string(),
        target: None,
        tracked: changed.saturating_sub(untracked),
        untracked,
        ignored,
        partly_staged,
        conflicts: Vec::new(),
        snapshot: None,
    })
}

/// What already sits where writing `written` over the snapshot would create
/// a path: at the path itself, or a file where one of its folders goes. Only
/// an ignored entry can, and `read-tree -u` deletes those as expendable; a
/// handoff does not.
fn occupied(side: &Side, written: &str) -> Result<Vec<String>, String> {
    // A snapshot file in a new folder's way is one the move itself removes.
    let removed = tree_diff(&side.dir, &side.tree, written, "D")?;
    let mut blocked: Vec<String> = Vec::new();
    for path in tree_diff(&side.dir, &side.tree, written, "A")? {
        let occupant = path
            .match_indices('/')
            .map(|(end, _)| &path[..end])
            .find(|folder| {
                !removed.iter().any(|gone| gone == folder)
                    && side.dir.join(folder).symlink_metadata().is_ok_and(|meta| !meta.is_dir())
            })
            .or_else(|| side.dir.join(&path).symlink_metadata().is_ok().then_some(path.as_str()));
        if let Some(occupant) = occupant.filter(|occupant| !blocked.iter().any(|b| b == occupant)) {
            blocked.push(occupant.to_string());
        }
    }
    Ok(blocked)
}

/// The paths of `merged`, files a merge combines from two changes, that a
/// configured `merge.<name>.driver` merges, named by their `merge` attribute
/// or by `merge.default`. Both are read in `dir`, where `merge-tree` runs.
fn driven(dir: &Path, merged: &[String]) -> Result<Vec<String>, String> {
    if merged.is_empty() {
        return Ok(Vec::new());
    }
    let (mut default, mut drivers) = (None, HashSet::new());
    for entry in nul_fields(&git_command(dir, &["config", "-z", "--list"])?) {
        let (key, value) = entry.split_once('\n').unwrap_or((&entry, ""));
        if key == "merge.default" {
            default = Some(value.to_string());
        } else if let Some(name) = key.strip_prefix("merge.").and_then(|key| key.strip_suffix(".driver")) {
            drivers.insert(name.to_string());
        }
    }
    let paths: String = merged.iter().map(|path| format!("{path}\0")).collect();
    let attributes = git_command_with_input(dir, &["check-attr", "-z", "--stdin", "merge"], &paths)?;
    // `<path> NUL merge NUL <value> NUL`, and `merge=` gives an empty value.
    let fields: Vec<String> = attributes.split(|byte| *byte == 0).map(decode).collect();
    Ok(fields
        .chunks_exact(3)
        .filter(|entry| {
            let name = match entry[2].as_str() {
                "set" | "unset" => None,
                "unspecified" => default.as_deref(),
                name => Some(name),
            };
            name.is_some_and(|name| drivers.contains(name))
        })
        .map(|entry| entry[0].clone())
        .collect())
}

/// Replay the source's uncommitted work onto the target's files with the
/// source HEAD as base (a cherry-pick of the working tree), entirely in the
/// object store. `Ok(Err(paths))` lists what stands in the way: merge
/// conflicts, files a merge driver would settle, or ignored files either
/// write would land on.
fn merge_sides(from: &Side, to: &Side) -> Result<Result<String, Vec<String>>, String> {
    let base = format!("--merge-base={}", from.head);
    let args = [
        "merge-tree", "--write-tree", "-z", "--name-only", "--messages",
        &base, &to.commit, &from.commit,
    ];
    let output = git_output(&from.dir, &args, None, None)?;
    // The tree, the conflicted paths and an empty field, then the notes: a
    // count, that many paths, a type and a message each.
    let mut fields = output.stdout.split(|byte| *byte == 0).map(decode);
    let tree = fields.next().unwrap_or_default();
    let conflicts: Vec<String> = fields.by_ref().take_while(|path| !path.is_empty()).collect();
    match output.status.code() {
        Some(0) if !tree.is_empty() => {}
        Some(0) => return Err("git merge-tree returned no tree".to_string()),
        Some(1) => return Ok(Err(conflicts)),
        _ => {
            return Err(format!(
                "git merge-tree failed (Git 2.40 or later is required): {}",
                decode(&output.stderr).trim()
            ))
        }
    }
    // A file both sides changed, each its own way, is noted "Auto-merging"
    // under the name its attributes are read for (a renamed file's new one).
    // A merge driver there can keep one side and drop the other's change
    // without a conflict (`cp %B %A`, `git merge-file --ours`): refused too.
    let mut merged = Vec::new();
    while let Some(count) = fields.next().and_then(|count| count.parse().ok()) {
        let paths: Vec<String> = fields.by_ref().take(count).collect();
        if fields.next().is_some_and(|kind| kind == "Auto-merging") {
            merged.extend(paths);
        }
        fields.next();
    }
    let mut blocked = driven(&from.dir, &merged)?;
    blocked.extend(occupied(to, &tree)?);
    blocked.extend(occupied(from, &from.head)?);
    Ok(if blocked.is_empty() { Ok(tree) } else { Err(blocked) })
}

/// Paths of `tree` whose file is missing or holds something else, through a
/// fresh private index (`refresh` hashes the files, so only real differences
/// remain; its exit status only says that some exist).
fn differing_from(side: &Side, tree: &str, name: &str) -> Result<(PathBuf, Vec<u8>), String> {
    let private = side.scratch.with_extension(name);
    git_with_index(&side.dir, &private, &["read-tree", tree], None)?;
    git_output(&side.dir, &["update-index", "-q", "--refresh"], None, Some(&private))?;
    let paths = git_with_index(&side.dir, &private, &["diff-files", "-z", "--name-only"], None)?;
    Ok((private, paths))
}

/// Raw copies of the regular files writing `written` overwrites or deletes,
/// next to the side's private index. Git writes through its line-ending
/// conversion; these keep the exact bytes, for the target and for an undo.
fn back_up(side: &Side, written: &str) -> Result<PathBuf, String> {
    let backup = side.scratch.with_extension("files");
    for path in tree_diff(&side.dir, &side.tree, written, "a")? {
        let file = side.dir.join(&path);
        if !file.symlink_metadata().is_ok_and(|meta| meta.is_file()) {
            continue;
        }
        let copy = backup.join(&path);
        std::fs::create_dir_all(copy.parent().unwrap_or(&backup))
            .and_then(|_| std::fs::copy(&file, &copy))
            .map_err(|e| format!("could not back up {path}: {e}"))?;
    }
    Ok(backup)
}

/// Write the merged tree into the target, then give the files that come
/// unchanged from the source their exact bytes back from its backup.
fn receive(from: &Side, to: &Side, merged: &str) -> Result<(), String> {
    git_with_index(&to.dir, &to.scratch, &["read-tree", "-m", "-u", &to.tree, merged], None)?;
    let combined: HashSet<String> = tree_diff(&from.dir, &from.tree, merged, "")?.into_iter().collect();
    let source = from.scratch.with_extension("files");
    for path in tree_diff(&to.dir, &to.tree, merged, "d")? {
        let copy = source.join(&path);
        if !combined.contains(&path) && copy.is_file() {
            std::fs::copy(&copy, to.dir.join(&path)).map_err(|e| format!("could not copy {path}: {e}"))?;
        }
    }
    Ok(())
}

/// Undo a failed step on one side, only for the paths writing `written`
/// changes and only where the file still holds what the step wrote (or is
/// gone): an added file is removed, any other gets its bytes back from
/// `backup` (from the snapshot for a symlink). A path changed since the
/// snapshot is left as it is and returned, so no later edit is lost. `index`
/// also resets the real index.
fn restore_side(side: &Side, written: &str, backup: &Path, index: bool) -> Result<Vec<String>, String> {
    let dir = &side.dir;
    let changed = tree_diff(dir, &side.tree, written, "")?;
    let mut left = Vec::new();
    if !changed.is_empty() {
        let set = |paths: Vec<String>| paths.into_iter().collect::<HashSet<_>>();
        let added = set(tree_diff(dir, &side.tree, written, "A")?);
        let deleted = set(tree_diff(dir, &side.tree, written, "D")?);
        let not_written = set(nul_fields(&differing_from(side, written, "written")?.1));
        let wrote = |path: &String| !deleted.contains(path) && !not_written.contains(path);
        let exists = |path: &String| dir.join(path).symlink_metadata().is_ok();
        for path in &added {
            if !wrote(path) {
                if exists(path) {
                    left.push(dir.join(path).display().to_string());
                }
                continue;
            }
            let file = dir.join(path);
            if let Err(error) = std::fs::remove_file(&file) {
                if error.kind() != std::io::ErrorKind::NotFound {
                    return Err(format!("could not remove {path}: {error}"));
                }
            }
            // Drop the folders the move created, never the checkout itself.
            let mut parent = file.parent();
            while let Some(folder) = parent.filter(|folder| *folder != dir.as_path()) {
                if std::fs::remove_dir(folder).is_err() {
                    break;
                }
                parent = folder.parent();
            }
        }
        let (private, stale) = differing_from(side, &side.tree, "restore")?;
        let stale = set(nul_fields(&stale));
        let mut from_snapshot = String::new();
        for path in changed.iter().filter(|path| !added.contains(*path) && stale.contains(*path)) {
            let file = dir.join(path);
            if !wrote(path) && exists(path) {
                left.push(file.display().to_string());
                continue;
            }
            let copy = backup.join(path);
            if copy.is_file() {
                // A symlink the step wrote goes first: copying onto it would
                // write through to whatever it points at.
                let symlink = file.symlink_metadata().is_ok_and(|meta| meta.file_type().is_symlink());
                (if symlink { std::fs::remove_file(&file) } else { Ok(()) })
                    .and_then(|_| std::fs::create_dir_all(file.parent().unwrap_or(dir)))
                    .and_then(|_| std::fs::copy(&copy, &file))
                    .map_err(|e| format!("could not restore {path}: {e}"))?;
            } else {
                from_snapshot.push_str(path);
                from_snapshot.push('\0');
            }
        }
        if !from_snapshot.is_empty() {
            git_with_index(dir, &private, &["checkout-index", "-f", "-z", "--stdin"], Some(&from_snapshot))?;
        }
    }
    if index {
        git_command(dir, &["read-tree", &side.index])?;
    }
    Ok(left)
}

/// Count what a handoff would move and, for an existing target, which paths
/// would conflict. Files, indexes and refs stay as they are.
pub fn handoff_preview(source: &Path, target: Option<&Path>) -> Result<HandoffPreview, String> {
    let (source, target) = match target {
        Some(target) => handoff_pair(source, target).map(|(s, t)| (s, Some(t)))?,
        None => (attached_checkout(source, source)?, None),
    };
    let scratch = scratch_dir()?;
    let from = snapshot(&source, &scratch.0, "source")?;
    let mut preview = handoff_counts(&from)?;
    if let Some(target) = target {
        let to = snapshot(&target, &scratch.0, "target")?;
        if let Err(conflicts) = merge_sides(&from, &to)? {
            preview.conflicts = conflicts;
        }
        preview.target = Some(target.display().to_string());
    }
    Ok(preview)
}

/// Move the source's uncommitted work (tracked changes, staged or not, and
/// untracked files; ignored files stay) into the target, then clean the
/// source. Conflicts are found before anything is written; the source is
/// cleaned only once the target holds the work; any failure restores both,
/// byte for byte, except a file edited meanwhile, which is kept and named.
pub fn handoff_move(source: &Path, target: &Path) -> Result<HandoffPreview, String> {
    handoff_move_with(source, target, || Ok(()))
}

fn handoff_move_with(
    source: &Path,
    target: &Path,
    before_cleanup: impl FnOnce() -> Result<(), String>,
) -> Result<HandoffPreview, String> {
    let (source, target) = handoff_pair(source, target)?;
    let scratch = scratch_dir()?;
    let from = snapshot(&source, &scratch.0, "source")?;
    let to = snapshot(&target, &scratch.0, "target")?;
    let mut preview = handoff_counts(&from)?;
    preview.target = Some(target.display().to_string());
    let merged = match merge_sides(&from, &to)? {
        Ok(tree) => tree,
        Err(conflicts) => {
            return Err(format!(
                "nothing was moved: {} file(s) would conflict in the target: {}",
                conflicts.len(),
                conflicts.join(", ")
            ))
        }
    };
    let (from_files, to_files) = back_up(&from, &from.head)
        .and_then(|source| Ok((source, back_up(&to, &merged)?)))
        .map_err(|e| format!("nothing was moved: {e}"))?;
    // From here on both sides stay recoverable by hand, whatever happens.
    // ponytail: the refs are kept after a success too; prune them with
    // `git for-each-ref refs/muse/handoff` if they ever weigh.
    let snapshot_ref = format!("refs/muse/handoff/{}", now_ms());
    git_command(&source, &["update-ref", &format!("{snapshot_ref}/source"), &from.commit])?;
    git_command(&source, &["update-ref", &format!("{snapshot_ref}/target"), &to.commit])?;
    let undo = |sides: &[(&Side, &str, &Path, bool)], step: &str, error: String| {
        let (mut left, mut failures) = (Vec::new(), Vec::new());
        for (side, written, backup, index) in sides {
            match restore_side(side, written, backup, *index) {
                Ok(paths) => left.extend(paths),
                Err(failure) => failures.push(failure),
            }
        }
        if !failures.is_empty() {
            format!(
                "{step} ({error}) and restoring failed too ({}); both sides are kept in {snapshot_ref}",
                failures.join("; ")
            )
        } else if !left.is_empty() {
            format!(
                "{step} ({error}); both sides were restored except {} file(s) changed meanwhile, left as they are: {}; the state before the move is kept in {snapshot_ref}",
                left.len(),
                left.join(", ")
            )
        } else {
            format!("{step}; both sides were restored as they were: {error}")
        }
    };
    // The target receives the work first. Its real index is never touched,
    // so the moved changes arrive unstaged.
    if let Err(error) = receive(&from, &to, &merged) {
        return Err(undo(
            &[(&to, merged.as_str(), &to_files, false)],
            "the target could not receive the changes",
            error,
        ));
    }
    // Only now is the source cleaned: files and index back to HEAD, the moved
    // untracked files removed. The private index refuses to overwrite a file
    // changed since the snapshot.
    let cleaned = before_cleanup()
        .and_then(|_| {
            git_with_index(
                &from.dir,
                &from.scratch,
                &["read-tree", "-m", "-u", &from.tree, &from.head],
                None,
            )
        })
        .and_then(|_| git_command(&from.dir, &["reset", "-q", &from.head, "--", "."]))
        .and_then(|_| {
            // Re-stat the rewritten files: a line-ending conversion changes
            // their size, and a stale size reads as "modified" to Git.
            let rewritten = tree_diff(&from.dir, &from.tree, &from.head, "d")?;
            if rewritten.is_empty() {
                return Ok(Vec::new());
            }
            let paths: String = rewritten.iter().map(|path| format!("{path}\0")).collect();
            git_command_with_input(&from.dir, &["update-index", "-z", "--stdin"], &paths)
        });
    if let Err(error) = cleaned {
        return Err(undo(
            &[(&from, from.head.as_str(), &from_files, true), (&to, merged.as_str(), &to_files, false)],
            "the source could not be cleaned",
            error,
        ));
    }
    preview.snapshot = Some(snapshot_ref);
    Ok(preview)
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
        // The app's checkouts must not appear as repository changes.
        let untracked = status(&root).unwrap().files.iter().any(|f| f.path.starts_with(".muse"));
        assert!(!untracked, ".muse/ is listed as a change");
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

    fn temp_dir(prefix: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "{}-{}-{}",
            prefix,
            std::process::id(),
            NEXT_FIXTURE.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        root
    }

    fn run_git(dir: &Path, args: &[&str]) {
        let output = Command::new("git")
            .args(args)
            .current_dir(dir)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "git {:?}: {}",
            args,
            decode(&output.stderr)
        );
    }

    #[test]
    fn commit_refuses_an_empty_index() {
        let root = fixture_repo();
        let snapshot = status(&root).unwrap();
        assert!(snapshot.files.is_empty());
        let error = commit(&root, "Nothing staged", snapshot.head, None, None).unwrap_err();
        assert_eq!(error, "nothing staged to commit");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn commit_surfaces_a_failing_pre_commit_hook() {
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
        let hook = root.join(".git").join("hooks").join("pre-commit");
        fs::write(&hook, "#!/bin/sh\necho forge hook says no >&2\nexit 1\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut permissions = fs::metadata(&hook).unwrap().permissions();
            permissions.set_mode(0o755);
            fs::set_permissions(&hook, permissions).unwrap();
        }
        let error = commit(
            &root,
            "Hooked change",
            staged.head.clone(),
            Some(staged.fingerprint),
            Some(staged_diff.patch),
        )
        .unwrap_err();
        assert!(
            error.contains("forge hook says no"),
            "unexpected hook error: {error}"
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn push_to_a_branch_without_upstream_succeeds_with_an_explicit_refspec() {
        let root = fixture_repo();
        let bare = temp_dir("muse-git-bare");
        run_git(&bare, &["init", "--bare", "--quiet"]);
        let bare_arg = bare.to_string_lossy().into_owned();
        run_git(&root, &["remote", "add", "origin", &bare_arg]);
        let head = status(&root).unwrap().head;
        let result = push(&root, "origin", "forge-smoke", head).unwrap();
        assert_eq!(result.branch, "forge-smoke");
        // No upstream was ever configured; the explicit refspec is enough and
        // the branch still lands on the remote.
        let upstream = Command::new("git")
            .args(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"])
            .current_dir(&root)
            .output()
            .unwrap();
        assert!(!upstream.status.success());
        let advertised = Command::new("git")
            .args(["ls-remote", "origin", "refs/heads/forge-smoke"])
            .current_dir(&root)
            .output()
            .unwrap();
        assert!(advertised.status.success());
        assert!(!decode(&advertised.stdout).trim().is_empty());
        let _ = fs::remove_dir_all(root);
        let _ = fs::remove_dir_all(bare);
    }

    #[test]
    fn push_reports_a_rejected_non_fast_forward() {
        let repo_a = fixture_repo();
        let bare = temp_dir("muse-git-bare");
        run_git(&bare, &["init", "--bare", "--quiet"]);
        let bare_arg = bare.to_string_lossy().into_owned();
        run_git(&repo_a, &["remote", "add", "origin", &bare_arg]);
        let head_a = status(&repo_a).unwrap().head;
        push(&repo_a, "origin", "forge-smoke", head_a).unwrap();
        run_git(&bare, &["symbolic-ref", "HEAD", "refs/heads/forge-smoke"]);
        // A second clone moves the remote branch forward, so repo_a is now
        // behind and its next push must be rejected, not silently applied.
        let parent = temp_dir("muse-git-clone-parent");
        run_git(&parent, &["clone", "--quiet", &bare_arg, "clone"]);
        let repo_c = parent.join("clone");
        run_git(&repo_c, &["config", "user.email", "test@example.com"]);
        run_git(&repo_c, &["config", "user.name", "Muse test"]);
        fs::write(repo_c.join("other.txt"), "two\n").unwrap();
        run_git(&repo_c, &["add", "--", "other.txt"]);
        run_git(&repo_c, &["commit", "--quiet", "-m", "second"]);
        run_git(
            &repo_c,
            &["push", "--quiet", "origin", "HEAD:refs/heads/forge-smoke"],
        );
        fs::write(repo_a.join("diverged.txt"), "three\n").unwrap();
        run_git(&repo_a, &["add", "--", "diverged.txt"]);
        run_git(&repo_a, &["commit", "--quiet", "-m", "diverged"]);
        let diverged_head = status(&repo_a).unwrap().head;
        let error = push(&repo_a, "origin", "forge-smoke", diverged_head).unwrap_err();
        assert!(
            error.contains("failed to push some refs"),
            "unexpected rejection: {error}"
        );
        let _ = fs::remove_dir_all(repo_a);
        let _ = fs::remove_dir_all(parent);
        let _ = fs::remove_dir_all(bare);
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

    // --- M2-04 / M2-06: worktree setup runner, readiness, inspect, removal

    fn worktree_fixture() -> (PathBuf, PathBuf) {
        let root = fixture_repo();
        fs::write(root.join("package.json"), "{}").unwrap();
        // real repos ignore the worktree root: without it the main checkout
        // would always read dirty (`?? .muse/`)
        fs::write(root.join(".gitignore"), ".muse/\n").unwrap();
        let run = |args: &[&str]| {
            let output = Command::new("git").args(args).current_dir(&root).output().unwrap();
            assert!(output.status.success(), "git {:?}: {}", args, decode(&output.stderr));
        };
        run(&["add", "-A"]);
        run(&["commit", "--quiet", "-m", "initial"]);
        run(&[
            "worktree",
            "add",
            "--quiet",
            "-b",
            "muse/qualif-wt",
            ".muse/worktrees/wt-a",
        ]);
        (root.clone(), root.join(".muse/worktrees/wt-a"))
    }

    #[test]
    fn setup_refuses_paths_outside_worktrees() {
        let (root, _) = worktree_fixture();
        let flag = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let error = run_worktree_setup(&root, &root.display().to_string(), "echo hi", "t1", 10, flag, std::sync::Arc::new(std::sync::Mutex::new(None)))
            .unwrap_err();
        assert!(error.contains(".muse/worktrees"), "{error}");
    }

    #[test]
    fn setup_refuses_overlong_commands() {
        let (root, wt) = worktree_fixture();
        let flag = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let long = "x".repeat(WORKTREE_SETUP_MAX_CHARS + 1);
        let error =
            run_worktree_setup(&root, &wt.display().to_string(), &long, "t2", 10, flag, std::sync::Arc::new(std::sync::Mutex::new(None))).unwrap_err();
        assert!(error.contains("character limit"), "{error}");
    }

    #[test]
    fn setup_reports_ready_and_runs_in_the_worktree() {
        let (root, wt) = worktree_fixture();
        let flag = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let outcome = run_worktree_setup(
            &root,
            &wt.display().to_string(),
            "echo setup-proof > setup-proof.txt",
            "t3",
            30,
            flag,
            std::sync::Arc::new(std::sync::Mutex::new(None)),
        )
        .unwrap();
        assert_eq!(outcome.status, "ready");
        assert!(!outcome.environment_keys.is_empty());
        assert!(wt.join("setup-proof.txt").is_file(), "command must run in the worktree");
    }

    #[test]
    fn setup_reports_failed_on_nonzero_exit() {
        let (root, wt) = worktree_fixture();
        let flag = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let outcome = run_worktree_setup(
            &root,
            &wt.display().to_string(),
            // Portable: `cmd /C exit 3` and `sh -c 'exit 3'` both exit 3.
            "exit 3",
            "t4",
            30,
            flag,
            std::sync::Arc::new(std::sync::Mutex::new(None)),
        )
        .unwrap();
        assert_eq!(outcome.status, "failed");
        assert_eq!(outcome.exit_code, Some(3));
    }

    #[test]
    fn setup_reports_cancelled_through_the_flag() {
        let (root, wt) = worktree_fixture();
        let flag = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(true));
        let outcome = run_worktree_setup(
            &root,
            &wt.display().to_string(),
            "ping -n 30 127.0.0.1",
            "t5",
            120,
            flag,
            std::sync::Arc::new(std::sync::Mutex::new(None)),
        )
        .unwrap();
        assert_eq!(outcome.status, "cancelled");
    }

    #[test]
    fn readiness_detects_project_files_and_missing_tools() {
        let (root, wt) = worktree_fixture();
        let readiness = check_worktree_readiness(&root, &wt.display().to_string()).unwrap();
        assert!(readiness.project_files.contains(&"package.json".to_string()));
        let node = readiness.tools.iter().find(|t| t.name == "node").unwrap();
        assert!(node.required);
        let git_tool = readiness.tools.iter().find(|t| t.name == "git").unwrap();
        assert!(git_tool.available, "git is on PATH in the test environment");
    }

    #[test]
    fn readiness_refuses_paths_outside_worktrees() {
        let (root, _) = worktree_fixture();
        assert!(check_worktree_readiness(&root, &root.display().to_string()).is_err());
    }

    #[test]
    fn inspect_reports_dirty_and_clean_worktrees() {
        let (root, wt) = worktree_fixture();
        fs::write(wt.join("dirty.txt"), "change").unwrap();
        let inspections = inspect_worktrees(&root).unwrap();
        let main = inspections.iter().find(|i| i.is_main).unwrap();
        let agent = inspections.iter().find(|i| !i.is_main).unwrap();
        assert!(main.clean);
        assert!(!agent.clean);
        assert!(!agent.conflicted);
        assert_eq!(agent.branch.as_deref(), Some("muse/qualif-wt"));
        assert!(agent.modified_at_ms > 0);
    }

    #[test]
    fn remove_refuses_dirty_then_removes_clean() {
        let (root, wt) = worktree_fixture();
        fs::write(wt.join("dirty.txt"), "change").unwrap();
        let error = remove_worktree(&root, &wt.display().to_string(), false).unwrap_err();
        assert!(error.contains("uncommitted changes"), "{error}");
        let force = remove_worktree(&root, &wt.display().to_string(), true);
        assert!(force.is_ok(), "{:?}", force.err());
        assert!(!wt.exists());
        // a second clean worktree goes out without force
        let run = |args: &[&str]| {
            Command::new("git").args(args).current_dir(&root).output().unwrap();
        };
        run(&["worktree", "add", "--quiet", "-b", "muse/qualif-wt2", ".muse/worktrees/wt-b"]);
        remove_worktree(&root, &root.join(".muse/worktrees/wt-b").display().to_string(), false)
            .unwrap();
        assert!(!root.join(".muse/worktrees/wt-b").exists());
    }

    // --- M2-05: handoff between Local and a worktree

    #[test]
    fn handoff_round_trip_moves_tracked_and_untracked_files_and_back() {
        let (root, wt) = worktree_fixture();
        // Git for Windows' default: a checkout would turn these LF files CRLF.
        run_git(&root, &["config", "core.autocrlf", "true"]);
        fs::write(root.join(".git/info/exclude"), "*.log\n").unwrap();
        fs::write(root.join("main.txt"), "one\nlocal edit\n").unwrap();
        fs::write(root.join("package.json"), "{\"staged\":true}").unwrap();
        run_git(&root, &["add", "--", "package.json"]);
        fs::create_dir_all(root.join("notes")).unwrap();
        fs::write(root.join("notes/new.txt"), "draft\n").unwrap();
        let binary = [0u8, 159, 146, 150, b'\r', b'\n', 0];
        fs::write(root.join("blob.bin"), binary).unwrap();
        fs::write(root.join("build.log"), "ignored\n").unwrap();

        let preview = handoff_preview(&root, Some(&wt)).unwrap();
        assert_eq!((preview.tracked, preview.untracked, preview.ignored), (2, 2, 1));
        assert!(preview.conflicts.is_empty());
        assert!(handoff_move(&root, &root).is_err());
        assert!(handoff_move(&root, &std::env::temp_dir()).is_err());

        let moved = handoff_move(&root, &wt).unwrap();
        assert!(moved.snapshot.unwrap().starts_with("refs/muse/handoff/"));
        assert_eq!(fs::read_to_string(wt.join("main.txt")).unwrap(), "one\nlocal edit\n");
        assert_eq!(fs::read_to_string(wt.join("package.json")).unwrap(), "{\"staged\":true}");
        assert_eq!(fs::read_to_string(wt.join("notes/new.txt")).unwrap(), "draft\n");
        assert_eq!(fs::read(wt.join("blob.bin")).unwrap(), binary);
        assert!(!wt.join("build.log").exists());
        let left = status(&root).unwrap().files;
        assert!(left.is_empty(), "{left:?}");
        assert!(!root.join("notes").exists() && !root.join("blob.bin").exists());
        assert!(root.join("build.log").is_file());

        handoff_move(&wt, &root).unwrap();
        assert!(status(&wt).unwrap().files.is_empty());
        assert_eq!(fs::read_to_string(root.join("main.txt")).unwrap(), "one\nlocal edit\n");
        assert_eq!(fs::read_to_string(root.join("notes/new.txt")).unwrap(), "draft\n");
        assert_eq!(fs::read(root.join("blob.bin")).unwrap(), binary);
    }

    #[test]
    fn handoff_conflict_is_found_before_either_side_changes() {
        let (root, wt) = worktree_fixture();
        fs::write(root.join("main.txt"), "one\nlocal\n").unwrap();
        fs::write(wt.join("main.txt"), "one\nworktree\n").unwrap();
        assert_eq!(handoff_preview(&root, Some(&wt)).unwrap().conflicts, vec!["main.txt"]);
        let error = handoff_move(&root, &wt).unwrap_err();
        assert!(error.contains("conflict"), "{error}");
        assert_eq!(fs::read_to_string(root.join("main.txt")).unwrap(), "one\nlocal\n");
        assert_eq!(fs::read_to_string(wt.join("main.txt")).unwrap(), "one\nworktree\n");
        let refs = Command::new("git")
            .args(["for-each-ref", "refs/muse"])
            .current_dir(&root)
            .output()
            .unwrap();
        assert!(refs.stdout.is_empty());
    }

    #[test]
    fn handoff_failure_before_cleanup_restores_both_sides() {
        let (root, wt) = worktree_fixture();
        run_git(&root, &["config", "core.autocrlf", "true"]);
        fs::write(root.join("main.txt"), "one\nstaged\n").unwrap();
        run_git(&root, &["add", "--", "main.txt"]);
        fs::write(root.join("main.txt"), "one\nstaged\nunstaged\n").unwrap();
        fs::remove_file(root.join("package.json")).unwrap();
        fs::write(root.join("new.txt"), "untracked\n").unwrap();
        fs::write(wt.join("own.txt"), "worktree work\n").unwrap();
        let fingerprints = || (status(&root).unwrap().fingerprint, status(&wt).unwrap().fingerprint);
        let files = [root.join("main.txt"), root.join("new.txt"), wt.join("main.txt"), wt.join("own.txt")];
        let bytes = || files.iter().map(|file| fs::read(file).unwrap()).collect::<Vec<_>>();
        let (before, before_bytes) = (fingerprints(), bytes());

        let error = handoff_move_with(&root, &wt, || Err("injected failure".to_string()))
            .unwrap_err();
        assert!(error.contains("restored") && error.contains("injected failure"), "{error}");
        assert_eq!(fingerprints(), before);
        assert_eq!(bytes(), before_bytes);
        assert!(!wt.join("new.txt").exists());
        assert!(!root.join("package.json").exists());
    }

    #[test]
    fn handoff_undo_keeps_files_edited_during_the_move() {
        let (root, wt) = worktree_fixture();
        fs::write(root.join("main.txt"), "one\nlocal\n").unwrap();
        let target_main = fs::read(wt.join("main.txt")).unwrap();

        // Edits after the snapshot, then a failure: the undo reverts neither.
        let error = handoff_move_with(&root, &wt, || {
            fs::write(root.join("main.txt"), "later edit\n").unwrap();
            fs::write(root.join("package.json"), "{\"later\":true}").unwrap();
            Err("injected failure".to_string())
        })
        .unwrap_err();
        assert!(error.contains("changed meanwhile") && error.contains("main.txt"), "{error}");
        assert_eq!(fs::read_to_string(root.join("main.txt")).unwrap(), "later edit\n");
        assert_eq!(fs::read_to_string(root.join("package.json")).unwrap(), "{\"later\":true}");
        assert_eq!(fs::read(wt.join("main.txt")).unwrap(), target_main);
    }

    #[test]
    fn handoff_undo_never_writes_through_a_symlink_the_move_created() {
        #[cfg(unix)]
        use std::os::unix::fs::symlink as symlink_file;
        #[cfg(windows)]
        use std::os::windows::fs::symlink_file;
        let (root, wt) = worktree_fixture();
        run_git(&root, &["config", "core.symlinks", "true"]);
        let outside = temp_dir("muse-handoff-outside").join("precious.txt");
        fs::write(&outside, "precious outside\n").unwrap();
        fs::remove_file(root.join("main.txt")).unwrap();
        symlink_file(&outside, root.join("main.txt")).unwrap();
        let target_main = fs::read(wt.join("main.txt")).unwrap();

        // The target receives the symlink, then the undo puts its file back.
        let error = handoff_move_with(&root, &wt, || Err("injected failure".to_string())).unwrap_err();
        assert!(error.contains("restored as they were"), "{error}");
        assert_eq!(fs::read_to_string(&outside).unwrap(), "precious outside\n");
        assert!(wt.join("main.txt").symlink_metadata().unwrap().is_file());
        assert_eq!(fs::read(wt.join("main.txt")).unwrap(), target_main);
    }

    #[test]
    fn handoff_keeps_a_staged_version_the_file_no_longer_holds() {
        let (root, wt) = worktree_fixture();
        fs::write(root.join("main.txt"), "staged\n").unwrap();
        fs::write(root.join("gone.txt"), "staged only\n").unwrap();
        run_git(&root, &["add", "--", "main.txt", "gone.txt"]);
        fs::write(root.join("main.txt"), "edited after\n").unwrap();
        fs::remove_file(root.join("gone.txt")).unwrap();
        let preview = handoff_preview(&root, Some(&wt)).unwrap();
        assert_eq!(preview.partly_staged, vec!["gone.txt", "main.txt"]);

        let snapshot = handoff_move(&root, &wt).unwrap().snapshot.unwrap();
        assert_eq!(fs::read_to_string(wt.join("main.txt")).unwrap(), "edited after\n");
        let staged = |path: &str| {
            let spec = format!("{snapshot}/source^2:{path}");
            decode(&Command::new("git").args(["show", &spec]).current_dir(&root).output().unwrap().stdout)
        };
        assert_eq!(staged("main.txt"), "staged\n");
        assert_eq!(staged("gone.txt"), "staged only\n");
    }

    #[test]
    fn handoff_refuses_to_land_on_an_ignored_target_file() {
        let (root, wt) = worktree_fixture();
        fs::write(root.join("notes.txt"), "from local\n").unwrap();
        fs::create_dir_all(root.join("cache")).unwrap();
        fs::write(root.join("cache/new.txt"), "from local\n").unwrap();
        // Ignored in the worktree only: Git alone would overwrite them, the
        // `cache` file to make room for the folder.
        fs::write(wt.join(".gitignore"), ".muse/\nnotes.txt\ncache\n").unwrap();
        fs::write(wt.join("notes.txt"), "worktree only\n").unwrap();
        fs::write(wt.join("cache"), "precious\n").unwrap();
        assert_eq!(handoff_preview(&root, Some(&wt)).unwrap().conflicts, vec!["cache", "notes.txt"]);
        let error = handoff_move(&root, &wt).unwrap_err();
        assert!(error.contains("notes.txt"), "{error}");
        assert_eq!(fs::read_to_string(wt.join("notes.txt")).unwrap(), "worktree only\n");
        assert_eq!(fs::read_to_string(wt.join("cache")).unwrap(), "precious\n");
        assert_eq!(fs::read_to_string(root.join("notes.txt")).unwrap(), "from local\n");
    }

    #[test]
    fn handoff_refuses_a_merge_driver_that_drops_the_moved_change() {
        let (root, wt) = worktree_fixture();
        let commit = |message: &str| {
            run_git(&root, &["add", "-A"]);
            run_git(&root, &["commit", "--quiet", "-m", message]);
        };
        fs::write(root.join(".gitattributes"), "lock.json merge=ours\n").unwrap();
        fs::write(root.join("lock.json"), "1\n2\n3\n").unwrap();
        commit("lock");
        run_git(&wt, &["reset", "--quiet", "--hard", &oid(git_command(&root, &["rev-parse", "HEAD"]).unwrap())]);
        fs::write(root.join("lock.json"), "1 local\n2\n3\n").unwrap();
        commit("local lock");
        fs::write(wt.join("lock.json"), "1\n2\n3 worktree\n").unwrap();
        // Without a driver both edits merge (P16b).
        assert!(handoff_preview(&wt, Some(&root)).unwrap().conflicts.is_empty());
        // `merge=ours` keeps Local's version: the moved edit would vanish (P16c).
        run_git(&root, &["config", "merge.ours.driver", "true"]);
        assert_eq!(handoff_preview(&wt, Some(&root)).unwrap().conflicts, vec!["lock.json"]);
        let error = handoff_move(&wt, &root).unwrap_err();
        assert!(error.contains("lock.json"), "{error}");
        assert_eq!(fs::read_to_string(wt.join("lock.json")).unwrap(), "1\n2\n3 worktree\n");
        assert_eq!(fs::read_to_string(root.join("lock.json")).unwrap(), "1 local\n2\n3\n");
    }

    /// Local and the worktree on one commit whose ten-line `lock.json` is
    /// merged by `driver`.
    fn driven_lock(driver: &str) -> (PathBuf, PathBuf) {
        let (root, wt) = worktree_fixture();
        fs::write(root.join(".gitattributes"), "lock.json merge=drop\n").unwrap();
        fs::write(root.join("lock.json"), lines(&[])).unwrap();
        run_git(&root, &["add", "-A"]);
        run_git(&root, &["commit", "--quiet", "-m", "lock"]);
        run_git(&root, &["config", "merge.drop.driver", driver]);
        run_git(&wt, &["reset", "--quiet", "--hard", &oid(git_command(&root, &["rev-parse", "HEAD"]).unwrap())]);
        (root, wt)
    }

    /// That `lock.json` with some of its lines edited.
    fn lines(edited: &[(usize, &str)]) -> String {
        (1..=10)
            .map(|n| match edited.iter().find(|(line, _)| *line == n) {
                Some((_, who)) => format!("{n} {who}\n"),
                None => format!("{n}\n"),
            })
            .collect()
    }

    #[test]
    fn handoff_refuses_a_merge_driver_that_keeps_only_the_moved_file() {
        // P5a: `cp %B %A` keeps the worktree's file, so Local's own edit
        // would be gone from both checkouts.
        let (root, wt) = driven_lock("cp %B %A");
        let (local, worktree) = (lines(&[(10, "local")]), lines(&[(1, "worktree")]));
        fs::write(wt.join("lock.json"), &worktree).unwrap();
        // Changed on one side only, the file is never merged.
        assert!(handoff_preview(&wt, Some(&root)).unwrap().conflicts.is_empty());
        fs::write(root.join("lock.json"), &local).unwrap();
        assert_eq!(handoff_preview(&wt, Some(&root)).unwrap().conflicts, vec!["lock.json"]);
        let error = handoff_move(&wt, &root).unwrap_err();
        assert!(error.contains("lock.json"), "{error}");
        assert_eq!(fs::read_to_string(root.join("lock.json")).unwrap(), local);
        assert_eq!(fs::read_to_string(wt.join("lock.json")).unwrap(), worktree);
        // The same driver named by `merge.default` instead of an attribute.
        fs::write(wt.join(".gitattributes"), "").unwrap();
        assert!(handoff_preview(&wt, Some(&root)).unwrap().conflicts.is_empty());
        run_git(&root, &["config", "merge.default", "drop"]);
        assert_eq!(handoff_preview(&wt, Some(&root)).unwrap().conflicts, vec!["lock.json"]);
    }

    #[test]
    fn handoff_refuses_a_merge_driver_that_settles_a_conflict_for_the_target() {
        // P5b: line 1 merges, line 10 keeps Local's version: the worktree's
        // line-10 edit would be gone from both checkouts.
        let (root, wt) = driven_lock("git merge-file --ours %A %O %B");
        let (local, worktree) = (lines(&[(10, "local")]), lines(&[(1, "worktree"), (10, "worktree")]));
        fs::write(root.join("lock.json"), &local).unwrap();
        fs::write(wt.join("lock.json"), &worktree).unwrap();
        assert_eq!(handoff_preview(&wt, Some(&root)).unwrap().conflicts, vec!["lock.json"]);
        let error = handoff_move(&wt, &root).unwrap_err();
        assert!(error.contains("lock.json"), "{error}");
        assert_eq!(fs::read_to_string(root.join("lock.json")).unwrap(), local);
        assert_eq!(fs::read_to_string(wt.join("lock.json")).unwrap(), worktree);
    }

    #[test]
    fn handoff_preview_returns_when_git_warns_about_every_file() {
        let (root, wt) = worktree_fixture();
        // One "LF will be replaced by CRLF" warning per file fills stderr
        // long before Git has read the whole list on stdin.
        run_git(&root, &["config", "core.autocrlf", "true"]);
        for n in 0..3000 {
            fs::write(root.join(format!("untracked-file-number-{n:0>20}.txt")), "lf\n").unwrap();
        }
        let (send, receive) = std::sync::mpsc::channel();
        std::thread::spawn(move || send.send(handoff_preview(&root, Some(&wt))));
        let preview = receive
            .recv_timeout(std::time::Duration::from_secs(120))
            .expect("the preview hung")
            .unwrap();
        assert_eq!(preview.untracked, 3000);
    }

    #[test]
    fn handoff_refuses_a_side_in_the_middle_of_a_merge() {
        let (root, wt) = worktree_fixture();
        run_git(&root, &["checkout", "--quiet", "-b", "feature"]);
        fs::write(root.join("feature.txt"), "feature\n").unwrap();
        run_git(&root, &["add", "--", "feature.txt"]);
        run_git(&root, &["commit", "--quiet", "-m", "feature"]);
        run_git(&root, &["checkout", "--quiet", "-"]);
        // P8: moved out, the merge's changes would be gone from the merge
        // commit that `git commit` still records.
        run_git(&root, &["merge", "--quiet", "--no-ff", "--no-commit", "feature"]);
        fs::write(wt.join("own.txt"), "worktree work\n").unwrap();
        for (source, target) in [(&root, &wt), (&wt, &root)] {
            let error = handoff_move(source, target).unwrap_err();
            assert!(error.contains("merge") && error.contains("abort"), "{error}");
        }
        assert!(root.join("feature.txt").is_file() && !wt.join("feature.txt").exists());
        assert!(wt.join("own.txt").is_file() && !root.join("own.txt").exists());
        assert!(git_command(&root, &["for-each-ref", "refs/muse"]).unwrap().is_empty());
    }
}
