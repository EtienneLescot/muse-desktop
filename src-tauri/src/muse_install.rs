//! First-run installation of, and sign-in to, the Muse CLI, driven from the
//! desktop app.
//!
//! On macOS the engine is not bundled: Meta distributes it through
//! `install.sh`, which installs a self-updating launcher in `~/.local/bin/muse`
//! and then downloads the platform binary, possibly after a device-code
//! sign-in. That sign-in only runs when stderr is a TTY, so the installer runs
//! inside a PTY here, and its output is shown to the user verbatim.
//!
//! Two structural rules:
//!   * the command is a constant of this module: the renderer can start,
//!     observe, answer (Enter only) and cancel the installer, never choose
//!     what runs;
//!   * only one installer runs at a time, and nothing starts without an
//!     explicit user action in the UI.

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;

/// The official, documented install command.
pub const INSTALL_URL: &str = "https://dev.meta.ai/install.sh";
const INSTALL_SCRIPT: &str = "set -o pipefail; curl -fsSL https://dev.meta.ai/install.sh | bash";
/// cua-driver's official installers (MIT, https://github.com/trycua/cua).
#[cfg(not(windows))]
const CUA_INSTALL_SCRIPT: &str = "set -o pipefail; curl -fsSL https://cua.ai/driver/install.sh | bash";
#[cfg(windows)]
const CUA_INSTALL_SCRIPT: &str = "irm https://cua.ai/driver/install.ps1 | iex";
const MAX_LOG_CHARS: usize = 64_000;

#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct InstallStatus {
    /// `install` or `login`: the job this status describes.
    pub kind: String,
    /// `idle`, `running`, `succeeded`, `failed` or `cancelled`.
    pub state: String,
    pub log: String,
    pub exit_code: Option<u32>,
    /// The launcher is waiting for Enter to open the sign-in page.
    pub awaiting_enter: bool,
    /// Where the CLI is expected once installed.
    pub cli_path: String,
    pub installed: bool,
    /// Device-code sign-in, parsed from the CLI output so the UI can show the
    /// code the user must confirm in the browser.
    pub sign_in_code: Option<String>,
}

struct Running {
    child: Box<dyn Child + Send + Sync>,
    writer: Box<dyn Write + Send>,
    _master: Box<dyn MasterPty + Send>,
}

#[derive(Default)]
struct Inner {
    kind: String,
    running: Option<Running>,
    state: String,
    exit_code: Option<u32>,
    log: Arc<Mutex<String>>,
}

fn inner() -> &'static Mutex<Inner> {
    static INNER: OnceLock<Mutex<Inner>> = OnceLock::new();
    INNER.get_or_init(|| {
        Mutex::new(Inner {
            kind: "install".to_string(),
            state: "idle".to_string(),
            ..Inner::default()
        })
    })
}

/// `~/.local/bin/muse`, the installer's default target.
pub fn cli_path() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .filter(|home| !home.is_empty())
        .map(|home| PathBuf::from(home).join(".local").join("bin").join("muse"))
}

pub fn cli_installed() -> bool {
    cli_path().map(|path| path.is_file()).unwrap_or(false)
}

/// Remove ANSI escape sequences and carriage-return redraws so the log reads
/// as plain text in the renderer.
fn plain_text(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut chars = raw.chars().peekable();
    while let Some(ch) = chars.next() {
        match ch {
            '\u{1b}' => match chars.peek() {
                Some('[') => {
                    chars.next();
                    while let Some(&next) = chars.peek() {
                        chars.next();
                        if ('@'..='~').contains(&next) {
                            break;
                        }
                    }
                }
                Some(']') => {
                    chars.next();
                    while let Some(next) = chars.next() {
                        if next == '\u{7}' {
                            break;
                        }
                        if next == '\u{1b}' {
                            chars.next();
                            break;
                        }
                    }
                }
                _ => {
                    chars.next();
                }
            },
            '\r' => {
                if chars.peek() != Some(&'\n') {
                    // A bare CR redraws the current line (progress bars).
                    if let Some(start) = out.rfind('\n') {
                        out.truncate(start + 1);
                    } else {
                        out.clear();
                    }
                }
            }
            '\n' | '\t' => out.push(ch),
            c if c.is_control() => {}
            c => out.push(c),
        }
    }
    out
}

fn bounded(mut log: String) -> String {
    let count = log.chars().count();
    if count > MAX_LOG_CHARS {
        log = log.chars().skip(count - MAX_LOG_CHARS).collect();
    }
    log
}

/// Make the freshly installed CLI visible to this process (and so to the
/// terminal, the sign-in check and the sidecar resolver) without a relaunch.
fn adopt_install_dir() {
    let Some(dir) = cli_path().and_then(|path| path.parent().map(PathBuf::from)) else {
        return;
    };
    let current = std::env::var_os("PATH").unwrap_or_default();
    if std::env::split_paths(&current).any(|entry| entry == dir) {
        return;
    }
    let mut entries = vec![dir];
    entries.extend(std::env::split_paths(&current));
    if let Ok(joined) = std::env::join_paths(entries) {
        std::env::set_var("PATH", joined);
    }
}

fn refresh(inner: &mut Inner) {
    let Some(running) = inner.running.as_mut() else {
        return;
    };
    if let Ok(Some(status)) = running.child.try_wait() {
        inner.exit_code = Some(status.exit_code());
        let installed = match inner.kind.as_str() {
            "install" => cli_installed(),
            "cua" => crate::computer::binary().is_some(),
            _ => true,
        };
        inner.state = if status.success() && installed {
            adopt_install_dir();
            "succeeded".to_string()
        } else {
            "failed".to_string()
        };
        inner.running = None;
    }
}

fn snapshot(inner: &Inner) -> InstallStatus {
    let log = inner.log.lock().map(|log| log.clone()).unwrap_or_default();
    let awaiting_enter = inner.running.is_some()
        && log
            .trim_end()
            .ends_with("Press Enter to open it in your browser:");
    let sign_in_code = if inner.running.is_some() { device_code(&log) } else { None };
    InstallStatus {
        kind: inner.kind.clone(),
        sign_in_code,
        state: inner.state.clone(),
        log,
        exit_code: inner.exit_code,
        awaiting_enter,
        cli_path: cli_path().map(|p| p.display().to_string()).unwrap_or_default(),
        installed: cli_installed(),
    }
}

/// The code shown after "confirm this code matches:" / "Enter this code:".
fn device_code(log: &str) -> Option<String> {
    let mut lines = log.lines();
    while let Some(line) = lines.next() {
        let lower = line.trim().to_ascii_lowercase();
        if lower.starts_with("confirm this code matches") || lower.starts_with("enter this code") {
            let code = lines.next()?.trim();
            let valid = !code.is_empty()
                && code.len() <= 32
                && code.chars().all(|c| c.is_ascii_alphanumeric() || c == '-');
            return valid.then(|| code.to_string());
        }
    }
    None
}

pub fn status() -> InstallStatus {
    let mut inner = inner().lock().expect("installer lock");
    refresh(&mut inner);
    snapshot(&inner)
}

/// `install`: Meta's official installer. `login`: `muse login` (device-code
/// sign-in) with the installed CLI. The renderer picks one of the two; it never
/// supplies a command.
pub fn start(kind: &str) -> Result<InstallStatus, String> {
    let (program, args, banner): (PathBuf, Vec<&str>, String) = match kind {
        "install" => (
            PathBuf::from("/bin/bash"),
            vec!["-c", INSTALL_SCRIPT],
            format!("$ curl -fsSL {INSTALL_URL} | bash\n"),
        ),
        "cua" => {
            #[cfg(not(windows))]
            let task = (
                PathBuf::from("/bin/bash"),
                vec!["-c", CUA_INSTALL_SCRIPT],
                "$ curl -fsSL https://cua.ai/driver/install.sh | bash\n".to_string(),
            );
            #[cfg(windows)]
            let task = (
                PathBuf::from("powershell.exe"),
                vec!["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", CUA_INSTALL_SCRIPT],
                format!("PS> {CUA_INSTALL_SCRIPT}\n"),
            );
            task
        }
        "login" => {
            let cli = cli_path()
                .filter(|path| path.is_file())
                .ok_or("the Muse CLI is not installed")?;
            (cli, vec!["login"], "$ muse login\n".to_string())
        }
        _ => return Err("unknown Muse CLI task".to_string()),
    };
    let mut inner = inner().lock().map_err(|_| "installer state is unavailable")?;
    refresh(&mut inner);
    if inner.running.is_some() {
        return Ok(snapshot(&inner));
    }
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .ok_or("HOME is not set")?;
    let pair = native_pty_system()
        .openpty(PtySize {
            rows: 30,
            cols: 100,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| format!("could not open a terminal for the installer: {error}"))?;
    let mut command = CommandBuilder::new(program);
    command.args(args);
    command.cwd(home);
    command.env("TERM", "dumb");
    command.env("NO_COLOR", "1");
    let child = pair
        .slave
        .spawn_command(command)
        .map_err(|error| format!("could not start the Muse installer: {error}"))?;
    drop(pair.slave);
    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|error| format!("could not read the installer output: {error}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|error| format!("could not attach to the installer: {error}"))?;

    let log = Arc::new(Mutex::new(banner.clone()));
    let sink = Arc::clone(&log);
    thread::spawn(move || {
        let mut raw = String::new();
        let mut buffer = [0u8; 4096];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(read) => {
                    raw.push_str(&String::from_utf8_lossy(&buffer[..read]));
                    raw = bounded(raw);
                    if let Ok(mut log) = sink.lock() {
                        *log = bounded(format!("{banner}{}", plain_text(&raw)));
                    }
                }
            }
        }
    });

    inner.log = log;
    inner.kind = kind.to_string();
    inner.exit_code = None;
    inner.state = "running".to_string();
    inner.running = Some(Running {
        child,
        writer,
        _master: pair.master,
    });
    Ok(snapshot(&inner))
}

/// The only input the installer accepts from the renderer: Enter, which the
/// launcher uses to open the sign-in page in the default browser.
pub fn press_enter() -> Result<(), String> {
    let mut inner = inner().lock().map_err(|_| "installer state is unavailable")?;
    let running = inner.running.as_mut().ok_or("the installer is not running")?;
    running
        .writer
        .write_all(b"\r")
        .and_then(|_| running.writer.flush())
        .map_err(|error| format!("could not answer the installer: {error}"))
}

/// Store a Meta API key with `muse auth set --api-key-stdin`. The key goes
/// to the CLI's stdin only: never on a command line, in a log, or in an error.
pub fn set_api_key(key: &str) -> Result<(), String> {
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};
    let key = key.trim();
    if key.is_empty() {
        return Err("Enter an API key".to_string());
    }
    if key.len() > 1024 || key.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return Err("That does not look like an API key".to_string());
    }
    let cli = cli_path()
        .filter(|path| path.is_file())
        .ok_or("the Muse CLI is not installed")?;
    let mut child = Command::new(cli)
        .args(["auth", "set", "--api-key-stdin"])
        .env("MUSE_NO_AUTO_UPDATE", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("could not run the Muse CLI: {error}"))?;
    {
        let mut stdin = child.stdin.take().ok_or("could not reach the Muse CLI")?;
        stdin
            .write_all(format!("{key}\n").as_bytes())
            .map_err(|_| "could not pass the key to the Muse CLI".to_string())?;
    }
    let mut stderr = child.stderr.take();
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if started.elapsed() < Duration::from_secs(20) => {
                thread::sleep(Duration::from_millis(50))
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("the Muse CLI did not answer".to_string());
            }
        }
    };
    if status.success() {
        return Ok(());
    }
    let mut detail = String::new();
    if let Some(stderr) = stderr.as_mut() {
        let _ = stderr.read_to_string(&mut detail);
    }
    // Defensive: never echo the key back even if the CLI did.
    let detail = plain_text(&detail).replace(key, "***");
    let detail: String = detail.trim().chars().take(200).collect();
    Err(if detail.is_empty() {
        "the Muse CLI rejected the API key".to_string()
    } else {
        format!("the Muse CLI rejected the API key: {detail}")
    })
}

pub fn cancel() -> InstallStatus {
    let mut inner = inner().lock().expect("installer lock");
    if let Some(mut running) = inner.running.take() {
        let _ = running.child.kill();
        let _ = running.child.wait();
        inner.state = "cancelled".to_string();
    }
    snapshot(&inner)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn output_is_plain_text() {
        let raw = "\u{1b}[1mABCD-EFGH\u{1b}[0m\r\nDownloading 10%\rDownloading 100%\r\n\u{1b}]0;title\u{7}done\n";
        assert_eq!(plain_text(raw), "ABCD-EFGH\nDownloading 100%\ndone\n");
    }

    #[test]
    fn log_is_bounded_to_its_tail() {
        let long = "x".repeat(MAX_LOG_CHARS + 10) + "END";
        let kept = bounded(long);
        assert_eq!(kept.chars().count(), MAX_LOG_CHARS);
        assert!(kept.ends_with("END"));
    }

    #[test]
    fn the_device_code_is_extracted() {
        let log = "Open this page to sign in:\n  https://auth.meta.com/x\nconfirm this code matches:\n  AB12-CD34\n\nPress Enter";
        assert_eq!(device_code(log).as_deref(), Some("AB12-CD34"));
        assert_eq!(device_code("Enter this code:\n  rm -rf /\n"), None);
        assert_eq!(device_code("nothing"), None);
    }

    #[test]
    fn the_command_is_the_official_one() {
        assert!(INSTALL_SCRIPT.contains(INSTALL_URL));
        assert!(INSTALL_SCRIPT.starts_with("set -o pipefail;"));
    }
}
