//! macOS: adopt the user's login-shell PATH at startup.
//!
//! An app started from Finder, the Dock or Spotlight inherits launchd's
//! minimal environment (`/usr/bin:/bin:/usr/sbin:/sbin`). The Muse CLI, Git
//! from Homebrew, Node, and whatever the agent's tools shell out to usually
//! live elsewhere (`~/.local/bin`, `/opt/homebrew/bin`, …), and the built-in
//! terminal, the sign-in check and MCP stdio servers all inherit this
//! process's PATH. Windows and Linux desktop sessions already carry the user
//! PATH, so this is a macOS-only concern.
//!
//! The shell is asked once, bounded in time, for `$PATH` only; nothing else
//! from its environment is imported. Failure keeps the inherited PATH plus
//! the well-known install directories that exist on disk.

use std::ffi::OsString;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

const MARKER: &str = "__MUSE_DESKTOP_PATH__";
const SHELL_TIMEOUT: Duration = Duration::from_secs(4);

/// Read `$PATH` from an interactive login shell. Interactive so that
/// `~/.zshrc`-only PATH edits (the common case for installers) are seen;
/// markers so that anything the rc files print is ignored.
fn login_shell_path(shell: &Path) -> Option<String> {
    let mut child = Command::new(shell)
        .args(["-ilc", &format!("printf '{MARKER}%s{MARKER}' \"$PATH\"")])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let mut stdout = child.stdout.take()?;
    let reader = thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = stdout.read_to_end(&mut bytes);
        bytes
    });
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if started.elapsed() < SHELL_TIMEOUT => {
                thread::sleep(Duration::from_millis(20))
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
    let output = String::from_utf8_lossy(&reader.join().ok()?).into_owned();
    extract_marked(&output)
}

fn extract_marked(output: &str) -> Option<String> {
    let start = output.find(MARKER)? + MARKER.len();
    let rest = &output[start..];
    let end = rest.find(MARKER)?;
    let path = rest[..end].trim();
    (!path.is_empty()).then(|| path.to_string())
}

/// Login-shell entries first (the user's intended precedence), then the
/// inherited ones, then well-known install dirs; duplicates and relative
/// entries are dropped.
fn merge(login: Option<&str>, inherited: Option<&OsString>, extra: &[PathBuf]) -> OsString {
    let mut seen = Vec::<PathBuf>::new();
    let mut push = |dir: PathBuf| {
        if dir.is_absolute() && !seen.contains(&dir) {
            seen.push(dir);
        }
    };
    if let Some(login) = login {
        std::env::split_paths(login).for_each(&mut push);
    }
    if let Some(inherited) = inherited {
        std::env::split_paths(inherited).for_each(&mut push);
    }
    extra.iter().cloned().for_each(&mut push);
    std::env::join_paths(seen).unwrap_or_default()
}

fn well_known_dirs(home: Option<&Path>) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(home) = home {
        dirs.push(home.join(".local").join("bin"));
        dirs.push(home.join(".cargo").join("bin"));
    }
    dirs.push(PathBuf::from("/opt/homebrew/bin"));
    dirs.push(PathBuf::from("/usr/local/bin"));
    dirs.into_iter().filter(|dir| dir.is_dir()).collect()
}

/// Called once at the top of `main`, before any thread or child starts.
pub fn adopt_login_shell_path() {
    let shell = std::env::var_os("SHELL")
        .map(PathBuf::from)
        .filter(|shell| shell.is_absolute() && shell.is_file())
        .unwrap_or_else(|| PathBuf::from("/bin/zsh"));
    let login = login_shell_path(&shell);
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let merged = merge(
        login.as_deref(),
        std::env::var_os("PATH").as_ref(),
        &well_known_dirs(home.as_deref()),
    );
    if !merged.is_empty() {
        std::env::set_var("PATH", merged);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn marked_path_ignores_shell_noise() {
        let noisy = format!("welcome!\n{MARKER}/a:/b{MARKER}\nbye");
        assert_eq!(extract_marked(&noisy).as_deref(), Some("/a:/b"));
        assert_eq!(extract_marked("no markers"), None);
        assert_eq!(extract_marked(&format!("{MARKER}{MARKER}")), None);
    }

    #[test]
    fn merge_keeps_login_precedence_and_drops_duplicates() {
        let inherited = OsString::from("/usr/bin:/bin:relative");
        let merged = merge(
            Some("/opt/homebrew/bin:/usr/bin"),
            Some(&inherited),
            &[PathBuf::from("/bin"), PathBuf::from("/extra")],
        );
        assert_eq!(merged, OsString::from("/opt/homebrew/bin:/usr/bin:/bin:/extra"));
    }

    #[test]
    fn a_real_login_shell_answers() {
        let path = login_shell_path(Path::new("/bin/sh")).expect("sh reports PATH");
        assert!(path.contains("/usr/bin"), "{path}");
    }
}
