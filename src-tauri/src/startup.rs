//! Bounded first-launch diagnostics.
//!
//! The desktop shell must explain a missing or unusable local runtime before
//! asking the user to send a turn. This module only probes local prerequisites;
//! it never installs software, reads credentials, or starts a Muse server.

use serde::Serialize;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const PROBE_TIMEOUT: Duration = Duration::from_secs(2);
const DETAIL_LIMIT: usize = 180;

#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StartupCheck {
    pub status: String,
    pub detail: String,
}

#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StartupProbe {
    pub platform: String,
    pub sidecar: StartupCheck,
    pub wsl: Option<StartupCheck>,
    pub muse_cli: Option<StartupCheck>,
    pub workspace: Option<StartupCheck>,
    pub checked_at: u64,
}

fn clip_detail(raw: &str) -> String {
    let one_line = raw
        .lines()
        .find(|line| !line.trim().is_empty())
        .unwrap_or("")
        .replace(['\r', '\n'], " ")
        .trim()
        .to_string();
    if one_line.chars().count() <= DETAIL_LIMIT {
        return one_line;
    }
    let clipped: String = one_line.chars().take(DETAIL_LIMIT).collect();
    format!("{clipped}…")
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis().min(u128::from(u64::MAX)) as u64)
        .unwrap_or(0)
}

fn platform_name() -> &'static str {
    if cfg!(windows) {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else {
        "unknown"
    }
}

fn missing(detail: impl Into<String>) -> StartupCheck {
    StartupCheck {
        status: "missing".to_string(),
        detail: detail.into(),
    }
}

fn ready(detail: impl Into<String>) -> StartupCheck {
    StartupCheck {
        status: "ready".to_string(),
        detail: detail.into(),
    }
}

fn blocked(detail: impl Into<String>) -> StartupCheck {
    StartupCheck {
        status: "blocked".to_string(),
        detail: detail.into(),
    }
}

fn unknown(detail: impl Into<String>) -> StartupCheck {
    StartupCheck {
        status: "unknown".to_string(),
        detail: detail.into(),
    }
}

fn hidden_window(command: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
}

fn spawn_probe(mut command: Command) -> Result<Child, String> {
    hidden_window(&mut command);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| error.to_string())
}

fn drain_pipe<R: Read + Send + 'static>(mut reader: R) -> thread::JoinHandle<Vec<u8>> {
    thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = reader.read_to_end(&mut bytes);
        bytes
    })
}

fn finish_probe(mut child: Child) -> StartupCheck {
    let started = Instant::now();
    let status: Result<ExitStatus, String> = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Ok(status),
            Ok(None) if started.elapsed() < PROBE_TIMEOUT => {
                thread::sleep(Duration::from_millis(25));
            }
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                break Err("probe timed out".to_string());
            }
            Err(error) => break Err(format!("probe wait failed: {error}")),
        }
    };
    let stdout = child.stdout.take().map(drain_pipe);
    let stderr = child.stderr.take().map(drain_pipe);
    let mut detail = String::new();
    if let Some(reader) = stdout {
        detail.push_str(&String::from_utf8_lossy(&reader.join().unwrap_or_default()));
    }
    if let Some(reader) = stderr {
        let stderr_bytes = reader.join().unwrap_or_default();
        let stderr = String::from_utf8_lossy(&stderr_bytes);
        if !stderr.trim().is_empty() {
            if !detail.is_empty() && !detail.ends_with('\n') {
                detail.push('\n');
            }
            detail.push_str(&stderr);
        }
    }
    match status {
        Err(error) => unknown(error),
        Ok(status) if status.success() => ready(clip_detail(&detail)),
        Ok(_) => blocked(clip_detail(&detail)),
    }
}

fn probe_command(program: &str, args: &[&str]) -> StartupCheck {
    let mut command = Command::new(program);
    command.args(args);
    match spawn_probe(command) {
        Ok(child) => finish_probe(child),
        Err(error) if error.contains("not found") || error.contains("cannot find") => {
            missing(format!("{program} is not available"))
        }
        Err(error) => unknown(format!("{program} probe failed: {}", clip_detail(&error))),
    }
}

fn probe_wsl() -> (StartupCheck, StartupCheck) {
    let wsl = probe_command("wsl.exe", &["--status"]);
    if wsl.status != "ready" {
        return (
            wsl,
            missing("WSL is available, but the Muse CLI was not checked"),
        );
    }
    let muse = probe_command(
        "wsl.exe",
        &["--exec", "sh", "-lc", "test -x \"$HOME/.local/bin/muse\""],
    );
    let muse = if muse.status == "ready" {
        ready("Muse CLI found in the default WSL distribution")
    } else if muse.status == "blocked" {
        missing("Install or make ~/.local/bin/muse executable in WSL")
    } else {
        muse
    };
    (wsl, muse)
}

fn probe_workspace(path: Option<&Path>) -> Option<StartupCheck> {
    let path = path?;
    if path.as_os_str().is_empty() {
        return Some(missing("Choose a workspace folder"));
    }
    match path.metadata() {
        Ok(metadata) if metadata.is_dir() => {
            if cfg!(windows) {
                let mut command = Command::new("wsl.exe");
                command.args(["--cd", &path.to_string_lossy(), "--exec", "pwd"]);
                return Some(match spawn_probe(command) {
                    Ok(child) => {
                        let check = finish_probe(child);
                        if check.status == "ready" {
                            ready("Workspace is reachable from WSL")
                        } else {
                            blocked("Workspace cannot be opened by the default WSL distribution")
                        }
                    }
                    Err(error) => {
                        unknown(format!("workspace probe failed: {}", clip_detail(&error)))
                    }
                });
            }
            Some(ready("Workspace folder is accessible"))
        }
        Ok(_) => Some(blocked("Selected workspace path is not a folder")),
        Err(_) => Some(blocked("Selected workspace folder cannot be accessed")),
    }
}

/// Probe local prerequisites without starting a sidecar or reading secrets.
/// `sidecar` is injected by the caller so tests can cover bundled/missing
/// layouts without touching the machine's real installation.
pub fn probe(sidecar: Result<PathBuf, String>, workspace: Option<&Path>) -> StartupProbe {
    let sidecar = match sidecar {
        Ok(path) => ready(format!(
            "Sidecar ready ({})",
            path.file_name().and_then(|x| x.to_str()).unwrap_or("Muse")
        )),
        Err(_) => missing("The sidecar binary for this platform is not installed"),
    };
    let (wsl, muse_cli) = if cfg!(windows) {
        let (wsl, muse) = probe_wsl();
        (Some(wsl), Some(muse))
    } else {
        (None, None)
    };
    StartupProbe {
        platform: platform_name().to_string(),
        sidecar,
        wsl,
        muse_cli,
        workspace: probe_workspace(workspace),
        checked_at: now_ms(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn clips_probe_details_without_newlines() {
        let detail = clip_detail(&format!("first line\n{}", "x".repeat(500)));
        assert!(!detail.contains('\n'));
        assert!(detail.chars().count() <= DETAIL_LIMIT + 1);
    }

    #[test]
    fn injected_sidecar_and_workspace_are_reported() {
        let root = std::env::temp_dir().join(format!("muse-startup-{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        let probe = probe(Ok(root.join("muse-test")), Some(&root));
        assert_eq!(probe.sidecar.status, "ready");
        assert!(probe.workspace.is_some());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn missing_sidecar_is_never_reported_ready() {
        let probe = probe(Err("missing".to_string()), None);
        assert_eq!(probe.sidecar.status, "missing");
    }
}
