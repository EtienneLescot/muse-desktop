//! Read the rule files the Muse host loads for a workspace — and nothing else.
//!
//! Why this exists. The desktop used to keep its own per-project "instructions"
//! text in `localStorage` and prepend it to every outgoing turn. That store had
//! no backend equivalent: the CLI's rules live *in the folder* (`muse init`
//! writes `AGENTS.md`, whose own header reads "Muse Code reads this file as
//! project rules when it runs in this directory"), they are versioned with the
//! code, and the host injects them itself as a `rules-file` block with its own
//! precedence rule — "the deeper file wins over the shallower one". A second,
//! invisible instruction store could only ever disagree with it.
//!
//! MSP offers no alternative: the exported schema has no method, notification
//! or definition mentioning rules (`rulePreview` on approvals is unrelated), so
//! the desktop cannot ask the host what it loaded. Reading the same files the
//! host reads is the only honest option, and that is all this module does.
//!
//! Two hard rules, both structural:
//!   * this module never creates, edits or deletes a rule file — the user's
//!     `AGENTS.md` belongs to the user and to the CLI, and a test asserts the
//!     bytes and the modification time survive a scan;
//!   * every path is derived from a closed set of roles, so no caller can ask
//!     this module to read an arbitrary file.
//!
//! The vocabulary is the CLI's, taken from its own strings:
//!   * project rules are `<workspace>/AGENTS.md`, with `CLAUDE.md` probed only
//!     when `AGENTS.md` is absent ("directly probe the active workspace's
//!     `AGENTS.md`; only when it is absent, directly probe its `CLAUDE.md`
//!     fallback");
//!   * personal rules are `~/.claude/CLAUDE.md` and `$CODEX_HOME/AGENTS.md`
//!     (default `~/.codex/AGENTS.md`), which the CLI imports on request and
//!     applies as a compatibility fallback.

use serde::Serialize;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::muse_auth;

/// How much of a rule file is shown. Enough to recognise the file — a heading
/// and a few rules — while keeping a 23 KB `AGENTS.md` out of every payload.
const MAX_PREVIEW_BYTES: usize = 4096;

/// A rule file, identified by role rather than by path.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RuleKind {
    /// `<workspace>/AGENTS.md` — what `muse init` scaffolds.
    ProjectAgents,
    /// `<workspace>/CLAUDE.md` — the `AGENTS.md` fallback.
    ProjectClaude,
    /// `~/.claude/CLAUDE.md` — personal rules.
    UserClaude,
    /// `$CODEX_HOME/AGENTS.md`, default `~/.codex/AGENTS.md` — personal rules.
    UserCodex,
}

/// What a rule file does for a session started in this workspace.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RuleStatus {
    /// The host loads it: this is the file that governs the session.
    Governs,
    /// On disk, but loses the precedence rule to a file that wins.
    Superseded,
    /// Personal rules, applied when the personal-context policy allows them.
    Fallback,
    /// Not on disk.
    Absent,
}

impl RuleStatus {
    fn as_str(self) -> &'static str {
        match self {
            RuleStatus::Governs => "governs",
            RuleStatus::Superseded => "superseded",
            RuleStatus::Fallback => "fallback",
            RuleStatus::Absent => "absent",
        }
    }
}

impl RuleKind {
    /// Precedence order: personal rules first, then the project's, because the
    /// deeper file wins.
    pub const ALL: [RuleKind; 4] = [
        RuleKind::UserClaude,
        RuleKind::UserCodex,
        RuleKind::ProjectAgents,
        RuleKind::ProjectClaude,
    ];

    fn id(self) -> &'static str {
        match self {
            RuleKind::ProjectAgents => "project-agents",
            RuleKind::ProjectClaude => "project-claude",
            RuleKind::UserClaude => "user-claude",
            RuleKind::UserCodex => "user-codex",
        }
    }

    fn scope(self) -> &'static str {
        match self {
            RuleKind::ProjectAgents | RuleKind::ProjectClaude => "project",
            RuleKind::UserClaude | RuleKind::UserCodex => "user",
        }
    }

    fn file_name(self) -> &'static str {
        match self {
            RuleKind::ProjectAgents | RuleKind::UserCodex => "AGENTS.md",
            RuleKind::ProjectClaude | RuleKind::UserClaude => "CLAUDE.md",
        }
    }

    /// Where this role lives. Pure: the caller supplies the two home
    /// directories, so a test never depends on the machine it runs on.
    fn path(
        self,
        workspace: &Path,
        home: Option<&Path>,
        codex_home: Option<&Path>,
    ) -> Option<PathBuf> {
        match self {
            RuleKind::ProjectAgents => Some(workspace.join("AGENTS.md")),
            RuleKind::ProjectClaude => Some(workspace.join("CLAUDE.md")),
            RuleKind::UserClaude => home.map(|home| home.join(".claude").join("CLAUDE.md")),
            RuleKind::UserCodex => codex_home.map(|dir| dir.join("AGENTS.md")),
        }
    }

    /// The status of this role, given whether its file exists and whether the
    /// workspace has an `AGENTS.md`. Pure.
    fn status(self, present: bool, project_agents_present: bool) -> RuleStatus {
        match self {
            RuleKind::ProjectAgents => {
                if present {
                    RuleStatus::Governs
                } else {
                    RuleStatus::Absent
                }
            }
            RuleKind::ProjectClaude => {
                if !present {
                    RuleStatus::Absent
                } else if project_agents_present {
                    RuleStatus::Superseded
                } else {
                    RuleStatus::Governs
                }
            }
            RuleKind::UserClaude | RuleKind::UserCodex => {
                if present {
                    RuleStatus::Fallback
                } else {
                    RuleStatus::Absent
                }
            }
        }
    }

    fn detail(self, status: RuleStatus) -> String {
        match (self, status) {
            (RuleKind::ProjectAgents, RuleStatus::Governs) => "Governs sessions started here. The host reads it because this app always spawns it with --trust-workspace.".to_string(),
            (RuleKind::ProjectAgents, _) => "No AGENTS.md in this folder. The CLI's `muse init` scaffolds one; this app never writes it.".to_string(),
            (RuleKind::ProjectClaude, RuleStatus::Governs) => "Loaded as the AGENTS.md fallback, because this folder has no AGENTS.md.".to_string(),
            (RuleKind::ProjectClaude, RuleStatus::Superseded) => "Not loaded: AGENTS.md takes precedence when both files exist.".to_string(),
            (RuleKind::ProjectClaude, _) => "Not present.".to_string(),
            (RuleKind::UserClaude | RuleKind::UserCodex, RuleStatus::Fallback) => "Personal rules, applied as a compatibility fallback unless the personal-context policy disables it.".to_string(),
            (RuleKind::UserClaude | RuleKind::UserCodex, _) => "Not present.".to_string(),
        }
    }
}

/// One rule file as reported to the renderer.
#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RuleFile {
    pub id: String,
    /// "project" | "user"
    pub scope: String,
    pub name: String,
    pub path: String,
    pub present: bool,
    /// "governs" | "superseded" | "fallback" | "absent"
    pub status: String,
    pub bytes: u64,
    /// Bounded head of the file, empty when it is absent.
    pub preview: String,
    pub truncated: bool,
    pub detail: String,
}

/// The whole observation for one workspace.
#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RulesScan {
    pub workspace: String,
    pub files: Vec<RuleFile>,
    /// Id of the project rule file that governs, when one does.
    pub governing: Option<String>,
    pub observed_at: u64,
}

/// Read the rules that would apply to a session started in `workspace`.
pub fn scan(workspace: &Path) -> Result<RulesScan, String> {
    let root = workspace.canonicalize().map_err(|e| {
        format!(
            "cannot resolve rules workspace {}: {e}",
            workspace.display()
        )
    })?;
    if !root.is_dir() {
        return Err(format!(
            "rules workspace is not a directory: {}",
            root.display()
        ));
    }
    Ok(scan_with(
        &root,
        muse_auth::home_dir().as_deref(),
        codex_home_dir().as_deref(),
    ))
}

/// `$CODEX_HOME`, defaulting to `~/.codex`, exactly as the CLI documents it.
fn codex_home_dir() -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os("CODEX_HOME").filter(|value| !value.is_empty()) {
        return Some(PathBuf::from(dir));
    }
    muse_auth::home_dir().map(|home| home.join(".codex"))
}

/// The observation, with both home directories supplied by the caller.
pub fn scan_with(workspace: &Path, home: Option<&Path>, codex_home: Option<&Path>) -> RulesScan {
    let mut resolved: Vec<(RuleKind, Option<PathBuf>, Option<(u64, String, bool)>)> =
        Vec::with_capacity(RuleKind::ALL.len());
    for kind in RuleKind::ALL {
        let path = kind.path(workspace, home, codex_home);
        let read = path.as_deref().and_then(read_preview);
        resolved.push((kind, path, read));
    }
    let project_agents_present = resolved
        .iter()
        .any(|(kind, _, read)| *kind == RuleKind::ProjectAgents && read.is_some());

    let mut files = Vec::with_capacity(resolved.len());
    let mut governing = None;
    for (kind, path, read) in resolved {
        let present = read.is_some();
        let status = kind.status(present, project_agents_present);
        if status == RuleStatus::Governs {
            governing = Some(kind.id().to_string());
        }
        let (bytes, preview, truncated) = read.unwrap_or((0, String::new(), false));
        files.push(RuleFile {
            id: kind.id().to_string(),
            scope: kind.scope().to_string(),
            name: kind.file_name().to_string(),
            path: path
                .as_deref()
                .map(display_path)
                .unwrap_or_default(),
            present,
            status: status.as_str().to_string(),
            bytes,
            preview,
            truncated,
            detail: kind.detail(status),
        });
    }

    RulesScan {
        workspace: display_path(workspace),
        files,
        governing,
        observed_at: now_ms(),
    }
}

/// Read a bounded head of one rule file, plus its real size.
///
/// `fs::metadata` follows a symlink on purpose: the host resolves the path it
/// is given, so a symlinked `AGENTS.md` is a rule file the user really has. A
/// path that is a directory, or unreadable, is reported as absent rather than
/// as an error — "no rules here" is a normal state the UI must render. Invalid
/// UTF-8 is replaced instead of failing, so a Latin-1 `AGENTS.md` still shows.
fn read_preview(path: &Path) -> Option<(u64, String, bool)> {
    let metadata = fs::metadata(path).ok()?;
    if !metadata.is_file() {
        return None;
    }
    let file = fs::File::open(path).ok()?;
    let mut bytes = Vec::new();
    file.take((MAX_PREVIEW_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .ok()?;
    let truncated = bytes.len() > MAX_PREVIEW_BYTES;
    if truncated {
        bytes.truncate(MAX_PREVIEW_BYTES);
    }
    Some((
        metadata.len(),
        String::from_utf8_lossy(&bytes).to_string(),
        truncated,
    ))
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

/// A path as the user would recognise it.
///
/// Windows `canonicalize` returns a verbatim path (`\\?\C:\…`). It names the
/// same file, but it is neither what the user picked nor what a project stores,
/// so a rules panel that displayed it would look broken next to the folder
/// field right above it. Measured on the live bridge: the first version of this
/// module reported `\\?\C:\Users\…\AGENTS.md`.
fn display_path(path: &Path) -> String {
    let text = path.display().to_string();
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{rest}");
    }
    text.strip_prefix(r"\\?\").map(str::to_string).unwrap_or(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture {
        base: PathBuf,
        workspace: PathBuf,
        home: PathBuf,
        codex: PathBuf,
    }

    impl Fixture {
        fn new(name: &str) -> Fixture {
            let base = std::env::temp_dir().join(format!("muse-rules-{}-{name}", std::process::id()));
            let _ = fs::remove_dir_all(&base);
            let workspace = base.join("workspace");
            let home = base.join("home");
            let codex = base.join("codex");
            fs::create_dir_all(&workspace).unwrap();
            fs::create_dir_all(home.join(".claude")).unwrap();
            fs::create_dir_all(&codex).unwrap();
            Fixture { base, workspace, home, codex }
        }

        fn scan(&self) -> RulesScan {
            scan_with(&self.workspace, Some(&self.home), Some(&self.codex))
        }

        fn status(&self, id: &str) -> String {
            self.scan()
                .files
                .into_iter()
                .find(|file| file.id == id)
                .unwrap_or_else(|| panic!("no rule file with id {id}"))
                .status
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.base);
        }
    }

    #[test]
    fn agents_md_governs_and_claude_md_is_superseded() {
        let fixture = Fixture::new("both");
        fs::write(fixture.workspace.join("AGENTS.md"), "# Project rules\nBe terse.").unwrap();
        fs::write(fixture.workspace.join("CLAUDE.md"), "# Claude rules\nOld.").unwrap();
        let scan = fixture.scan();
        assert_eq!(fixture.status("project-agents"), "governs");
        assert_eq!(fixture.status("project-claude"), "superseded");
        assert_eq!(scan.governing.as_deref(), Some("project-agents"));
        let agents = scan.files.iter().find(|file| file.id == "project-agents").unwrap();
        assert!(agents.preview.contains("Be terse."));
        let claude = scan.files.iter().find(|file| file.id == "project-claude").unwrap();
        assert!(claude.present, "a superseded file is still on disk");
        assert!(claude.detail.contains("AGENTS.md takes precedence"));
    }

    #[test]
    fn claude_md_governs_only_when_agents_md_is_absent() {
        let fixture = Fixture::new("fallback");
        fs::write(fixture.workspace.join("CLAUDE.md"), "Fallback rules.").unwrap();
        assert_eq!(fixture.status("project-claude"), "governs");
        assert_eq!(fixture.status("project-agents"), "absent");
        assert_eq!(fixture.scan().governing.as_deref(), Some("project-claude"));
    }

    #[test]
    fn personal_rules_are_reported_as_a_policy_dependent_fallback() {
        let fixture = Fixture::new("personal");
        fs::write(fixture.home.join(".claude").join("CLAUDE.md"), "Personal.").unwrap();
        fs::write(fixture.codex.join("AGENTS.md"), "Codex personal.").unwrap();
        let scan = fixture.scan();
        assert_eq!(fixture.status("user-claude"), "fallback");
        assert_eq!(fixture.status("user-codex"), "fallback");
        // Personal rules never take the governing slot: the project's do.
        assert_eq!(scan.governing, None);
        assert!(
            scan.files.iter().all(|file| !file.detail.is_empty()),
            "every row must explain itself"
        );
    }

    #[test]
    fn a_workspace_without_rules_reports_absent_rows_rather_than_failing() {
        let fixture = Fixture::new("empty");
        let scan = fixture.scan();
        assert_eq!(scan.files.len(), 4);
        assert!(scan.files.iter().all(|file| file.status == "absent"));
        assert!(scan.files.iter().all(|file| file.preview.is_empty()));
        assert!(scan.files.iter().all(|file| file.bytes == 0));
        assert_eq!(scan.governing, None);
        // Paths are still reported, so the UI can say where a file would go.
        let agents = scan.files.iter().find(|file| file.id == "project-agents").unwrap();
        assert!(agents.path.ends_with("AGENTS.md"));
    }

    #[test]
    fn an_oversized_agents_md_is_truncated_but_reports_its_real_size() {
        let fixture = Fixture::new("large");
        let body = "x".repeat(MAX_PREVIEW_BYTES * 3);
        fs::write(fixture.workspace.join("AGENTS.md"), &body).unwrap();
        let scan = fixture.scan();
        let agents = scan.files.iter().find(|file| file.id == "project-agents").unwrap();
        assert!(agents.truncated);
        assert_eq!(agents.preview.len(), MAX_PREVIEW_BYTES);
        assert_eq!(agents.bytes, body.len() as u64);
    }

    /// The claim this module makes in its own doc comment, asserted rather than
    /// asserted-by-prose: a scan leaves the user's file exactly as it was.
    #[test]
    fn scanning_never_modifies_a_rule_file() {
        let fixture = Fixture::new("readonly");
        let path = fixture.workspace.join("AGENTS.md");
        let body = "# Project rules\nNever touched.";
        fs::write(&path, body).unwrap();
        let before = fs::metadata(&path).unwrap();
        let before_modified = before.modified().unwrap();
        let before_len = before.len();

        let _ = fixture.scan();
        let _ = fixture.scan();

        let after = fs::metadata(&path).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), body);
        assert_eq!(after.len(), before_len);
        assert_eq!(after.modified().unwrap(), before_modified);
        assert!(
            !fixture.workspace.join("CLAUDE.md").exists(),
            "a scan must not create the fallback file"
        );
    }

    /// The renderer switches on these strings, so they are a contract: an
    /// accidental rename would silently drop a row into the "unknown" branch.
    #[test]
    fn the_payload_uses_a_closed_vocabulary() {
        let fixture = Fixture::new("vocabulary");
        fs::write(fixture.workspace.join("AGENTS.md"), "rules").unwrap();
        let scan = fixture.scan();
        let mut ids: Vec<&str> = scan.files.iter().map(|file| file.id.as_str()).collect();
        ids.sort_unstable();
        assert_eq!(
            ids,
            ["project-agents", "project-claude", "user-claude", "user-codex"]
        );
        for file in &scan.files {
            assert!(
                ["project", "user"].contains(&file.scope.as_str()),
                "unexpected scope {}",
                file.scope
            );
            assert!(
                ["governs", "superseded", "fallback", "absent"].contains(&file.status.as_str()),
                "unexpected status {}",
                file.status
            );
            assert!(file.name.ends_with(".md"));
        }
        assert!(scan.observed_at > 0);
        // Precedence order is part of the contract: personal rules are listed
        // before the project's, and the deeper file wins.
        assert_eq!(scan.files[2].scope, "project");
        assert_eq!(scan.files[3].scope, "project");
    }

    /// The renderer parses these field names and nothing else, so the serde
    /// spelling is a contract between two languages. `camelCase` is easy to
    /// lose in a rename, and the symptom would be a silently empty panel.
    #[test]
    fn the_serialized_payload_matches_the_field_names_the_renderer_reads() {
        let fixture = Fixture::new("serde");
        fs::write(fixture.workspace.join("AGENTS.md"), "# rules").unwrap();
        let value = serde_json::to_value(fixture.scan()).expect("scan serializes");
        let object = value.as_object().expect("payload is an object");
        let mut keys: Vec<&str> = object.keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            ["files", "governing", "observedAt", "workspace"],
            "the scan payload changed shape; update src/lib/harnessRules.ts with it"
        );

        let files = object["files"].as_array().expect("files is an array");
        let mut row_keys: Vec<&str> = files[0]
            .as_object()
            .expect("a row is an object")
            .keys()
            .map(String::as_str)
            .collect();
        row_keys.sort_unstable();
        assert_eq!(
            row_keys,
            [
                "bytes", "detail", "id", "name", "path", "present", "preview", "scope", "status",
                "truncated"
            ],
            "the rule row changed shape; update src/lib/harnessRules.ts with it"
        );
    }

    /// A verbatim Windows path is the same file, but it is not what the user
    /// recognises. Pure, so it is checked on every platform.
    #[test]
    fn verbatim_windows_paths_are_reported_the_way_the_user_typed_them() {
        assert_eq!(
            display_path(Path::new(r"\\?\C:\work\AGENTS.md")),
            r"C:\work\AGENTS.md"
        );
        assert_eq!(
            display_path(Path::new(r"\\?\UNC\server\share\AGENTS.md")),
            r"\\server\share\AGENTS.md"
        );
        // Anything else is left exactly as it is, including POSIX paths.
        assert_eq!(display_path(Path::new("/home/u/AGENTS.md")), "/home/u/AGENTS.md");
        assert_eq!(display_path(Path::new(r"C:\work\AGENTS.md")), r"C:\work\AGENTS.md");
    }

    #[test]
    fn a_missing_workspace_is_an_explicit_error() {        let missing = std::env::temp_dir().join("muse-rules-does-not-exist-12345");
        let error = scan(&missing).unwrap_err();
        assert!(error.contains("cannot resolve rules workspace"), "got {error}");
    }

    #[test]
    fn a_file_in_place_of_the_workspace_is_an_explicit_error() {
        let fixture = Fixture::new("not-a-dir");
        let file = fixture.base.join("a-file");
        fs::write(&file, "x").unwrap();
        let error = scan(&file).unwrap_err();
        assert!(error.contains("not a directory"), "got {error}");
    }
}
