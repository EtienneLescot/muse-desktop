//! M4-07: remote execution over the **system `ssh` binary** (product decision
//! of 29/09/2026 — no crypto crate, the user's existing keys and agent).
//!
//! This module owns everything the renderer must not: the binary resolution
//! (PATH, then the canonical install locations), the argv construction, and
//! the output bounds. The renderer passes validated *fields* (host, port,
//! user, identity path, command); this module rebuilds the argv from them, so
//! a compromised renderer cannot inject an argument — every field is
//! charset-checked and the remote command travels after a literal `--`
//! separator, never through a shell. There is no password path at all:
//! authentication rides the user's existing key agent.
//!
//! Whether a given remote host accepts the connection is a property of that
//! host, not of this code: a refused connection still proves the binary was
//! driven with the right argv, which is the part this app owns.

use serde_json::{json, Value};
use std::io::Read;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::thread::{self, JoinHandle};
use std::time::Duration;

const HOST_CHARS: &str = "^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$";
const NAME_CHARS: &str = "^[A-Za-z0-9._-]+$";
const PATH_CHARS: &str = "^[A-Za-z0-9 ._\\\\/:()-]+$";
const CONNECT_TIMEOUT: u64 = 10;
const EXEC_TIMEOUT_MIN: u64 = 1;
const EXEC_TIMEOUT_MAX: u64 = 120;
const EXEC_TIMEOUT_DEFAULT: u64 = 30;
const OUTPUT_LIMIT: usize = 64 * 1024;

/// Where `ssh` lives: the PATH the app was started with, then the canonical
/// install locations (Windows' optional OpenSSH feature, then the Unix ones).
fn ssh_binary() -> Option<PathBuf> {
    let names: &[&str] = if cfg!(windows) { &["ssh.exe", "ssh"] } else { &["ssh"] };
    if let Some(path) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path) {
            for name in names {
                let candidate = dir.join(name);
                if candidate.is_file() {
                    return Some(candidate);
                }
            }
        }
    }
    #[cfg(windows)]
    {
        let candidate = PathBuf::from(r"C:\Windows\System32\OpenSSH\ssh.exe");
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    #[cfg(not(windows))]
    {
        for candidate in ["/usr/bin/ssh", "/bin/ssh"] {
            let candidate = PathBuf::from(candidate);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

fn matches(value: &str, pattern: &str, max: usize) -> bool {
    !value.is_empty()
        && value.len() <= max
        && !value.chars().any(|c| c.is_control())
        && regex_is_match(pattern, value)
}

/// A minimal anchored matcher for the three closed character classes above —
/// no regex crate, the classes are fixed and simple.
fn regex_is_match(pattern: &str, value: &str) -> bool {
    match pattern {
        HOST_CHARS => {
            // Bytes, not str slices: a 1-char or multibyte host must not panic.
            let bytes = value.as_bytes();
            matches!((bytes.first(), bytes.last()), (Some(f), Some(l)) if f.is_ascii_alphanumeric() && l.is_ascii_alphanumeric())
                && bytes.iter().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-'))
        }
        NAME_CHARS => value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-')),
        PATH_CHARS => value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b' ' | b'.' | b'_' | b'\\' | b'/' | b':' | b'(' | b')' | b'-')),
        _ => false,
    }
}

/// The pure gate the command runs before anything is spawned. `Err` carries
/// the field name: the renderer shows it, the log never carries values.
fn validate(host: &str, port: u16, user: &str, identity_file: &str, command: &str) -> Result<(), String> {
    if !matches(host, HOST_CHARS, 255) {
        return Err("invalid ssh host".to_string());
    }
    // A dash-leading user would make `user@host` an ssh option (`-E…` writes a log file).
    if !user.is_empty() && (!matches(user, NAME_CHARS, 64) || user.starts_with('-')) {
        return Err("invalid ssh user".to_string());
    }
    if !identity_file.is_empty() && !matches(identity_file, PATH_CHARS, 400) {
        return Err("invalid ssh identity path".to_string());
    }
    let command = command.trim();
    if command.is_empty() || command.len() > 8_000 || command.chars().any(|c| c == '\0') {
        return Err("invalid ssh command".to_string());
    }
    let _ = port;
    Ok(())
}

/// The canonical argv, rebuilt here from the validated fields. Mirrors
/// `buildSshArgv` in `src/lib/remoteSsh.ts`; both are tested so a drift is a
/// failing test, not a surprise.
fn ssh_argv(ssh: &PathBuf, host: &str, port: u16, user: &str, identity_file: &str, command: &str) -> Vec<String> {
    let mut argv = vec![ssh.display().to_string()];
    if port != 22 {
        argv.push("-p".to_string());
        argv.push(port.to_string());
    }
    if !identity_file.is_empty() {
        argv.push("-i".to_string());
        argv.push(identity_file.to_string());
    }
    argv.push("-o".to_string());
    argv.push("BatchMode=yes".to_string());
    argv.push("-o".to_string());
    argv.push(format!("ConnectTimeout={CONNECT_TIMEOUT}"));
    argv.push(if user.is_empty() { host.to_string() } else { format!("{user}@{host}") });
    argv.push("--".to_string());
    argv.push(command.trim().to_string());
    argv
}

/// Drain one pipe on its own thread so a chatty remote can never fill it and
/// stall ssh until the deadline. Keeps `OUTPUT_LIMIT` bytes plus one char's
/// worth (so the cut lands on a boundary), discards the rest.
fn drain_bounded<R: Read + Send + 'static>(mut reader: R) -> JoinHandle<String> {
    thread::spawn(move || {
        let mut kept = Vec::new();
        let _ = (&mut reader).take(OUTPUT_LIMIT as u64 + 4).read_to_end(&mut kept);
        let _ = std::io::copy(&mut reader, &mut std::io::sink());
        crate::truncate(&String::from_utf8_lossy(&kept), OUTPUT_LIMIT)
    })
}

/// Run one command on the remote host. Returns the bounded stdout/stderr and
/// the exit code; a spawn failure or a timeout is an `Err`, everything the
/// binary itself reports is a value.
pub fn remote_ssh_exec(host: &str, port: u16, user: &str, identity_file: &str, command: &str, timeout_secs: Option<u64>) -> Result<Value, String> {
    let timeout = timeout_secs.unwrap_or(EXEC_TIMEOUT_DEFAULT).clamp(EXEC_TIMEOUT_MIN, EXEC_TIMEOUT_MAX);
    validate(host, port, user, identity_file, command)?;
    let ssh = ssh_binary().ok_or_else(|| "no ssh binary found; install the system OpenSSH client".to_string())?;
    run_bounded(&ssh_argv(&ssh, host, port, user, identity_file, command), timeout)
}

/// The remote Muse binary when the target does not name one: where the
/// official installer puts it.
pub const DEFAULT_REMOTE_MUSE: &str = "~/.local/bin/muse";
/// Keepalive for the long-lived engine link: a dead network ends ssh, so the
/// pump reports the host as gone instead of a conversation hanging forever.
const SERVER_ALIVE_INTERVAL: u64 = 15;

/// M4-07 remote engine: `muse serve` started on another host through the
/// system ssh, its stdio carrying MSP exactly like the local sidecar's.
///
/// The whole target is the workspace key the conversation is stored under,
/// `ssh://[user@]host:port/abs/path[?muse=<binary>]`, so a reconnect needs
/// nothing but the conversation record and a remote host never collides with
/// a local folder. The key is parsed and rebuilt here, never trusted as-is;
/// `remoteWorkspaceUri` in `src/lib/remoteSsh.ts` builds the same string.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteEngine {
    pub user: String,
    pub host: String,
    pub port: u16,
    /// Remote binary: absolute, or `~/`-relative (the remote shell expands it).
    pub muse: String,
    /// Remote folder: the session's `workspaceRoot`, a path on that host.
    pub workspace: String,
}

/// The remote engine a host key names; `None` for a local folder.
pub fn remote_engine(root: &std::path::Path) -> Option<RemoteEngine> {
    root.to_str().and_then(RemoteEngine::parse).and_then(Result::ok)
}

/// A remote path reaches the remote login shell (ssh joins the command words
/// with spaces), so it must be one plain word: absolute, or `~/`-relative
/// where `home` allows it, with no space, quote, `$` or other metacharacter.
/// The same class keeps the `?` of the key unambiguous.
fn remote_path(value: &str, home: bool) -> bool {
    let rest = match (value.strip_prefix('/'), value.strip_prefix("~/")) {
        (Some(rest), _) => rest,
        (None, Some(rest)) if home => rest,
        _ => return false,
    };
    value.len() <= 400
        && rest
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'/' | b'-'))
}

impl RemoteEngine {
    /// `None` when `raw` is not an `ssh://` key, `Some(Err)` when it is one
    /// that does not validate: a remote key is never taken for a local path.
    pub fn parse(raw: &str) -> Option<Result<Self, String>> {
        let rest = raw.strip_prefix("ssh://")?;
        Some(Self::parse_target(rest))
    }

    fn parse_target(rest: &str) -> Result<Self, String> {
        let slash = rest.find('/').ok_or("the remote folder must be an absolute path")?;
        let (authority, path) = rest.split_at(slash);
        let (workspace, muse) = match path.split_once('?') {
            None => (path, DEFAULT_REMOTE_MUSE),
            Some((path, query)) => (path, query.strip_prefix("muse=").ok_or("unsupported remote option")?),
        };
        let (who, port) = match authority.rsplit_once(':') {
            Some((who, port)) => (who, port.parse::<u16>().ok().filter(|p| *p != 0).ok_or("invalid ssh port")?),
            None => (authority, 22),
        };
        let (user, host) = who.split_once('@').unwrap_or(("", who));
        validate(host, port, user, "", muse)?;
        if !remote_path(workspace, false) {
            return Err("invalid remote folder".to_string());
        }
        if !remote_path(muse, true) {
            return Err("invalid remote Muse path".to_string());
        }
        Ok(Self {
            user: user.to_string(),
            host: host.to_string(),
            port,
            muse: muse.to_string(),
            workspace: workspace.to_string(),
        })
    }

    fn destination(&self) -> String {
        if self.user.is_empty() { self.host.clone() } else { format!("{}@{}", self.user, self.host) }
    }

    /// Whether a host-reported `workspaceRoot` is this folder. It does not
    /// exist here, so it is compared as that host spells it.
    pub fn names_workspace(&self, raw: &str) -> bool {
        raw.trim_end_matches('/') == self.workspace.trim_end_matches('/')
    }

    /// The canonical key: the default binary is left implicit.
    pub fn key(&self) -> String {
        let mut key = format!("ssh://{}:{}{}", self.destination(), self.port, self.workspace);
        if self.muse != DEFAULT_REMOTE_MUSE {
            key.push_str("?muse=");
            key.push_str(&self.muse);
        }
        key
    }

    /// `ssh -T … [user@]host -- <muse> serve <posture>`: no pty (MSP is a
    /// byte stream), never a prompt, the posture the local spawn would use.
    fn serve_argv(&self, ssh: &PathBuf, posture: &[&str]) -> Vec<String> {
        let command = std::iter::once(self.muse.as_str()).chain(posture.iter().copied()).collect::<Vec<_>>().join(" ");
        let mut argv = ssh_argv(ssh, &self.host, self.port, &self.user, "", &command);
        argv.splice(1..1, ["-T".to_string(), "-o".to_string(), format!("ServerAliveInterval={SERVER_ALIVE_INTERVAL}")]);
        argv
    }

    pub fn serve_command(&self, posture: &[&str]) -> Result<Vec<String>, String> {
        let ssh = ssh_binary().ok_or_else(|| "no ssh binary found; install the system OpenSSH client".to_string())?;
        Ok(self.serve_argv(&ssh, posture))
    }

    /// One actionable sentence for what ssh (or the remote shell) said on
    /// stderr; `None` when nothing is recognizable and the raw tail must do.
    pub fn explain_failure(&self, stderr: &str) -> Option<String> {
        let at = format!("{}:{}", self.host, self.port);
        let said = stderr.to_ascii_lowercase();
        if said.contains("host key verification failed") {
            let port = if self.port == 22 { String::new() } else { format!("-p {} ", self.port) };
            return Some(format!(
                "The host key of {at} is not trusted yet, or it changed. Check it once from a terminal: ssh {port}{}",
                self.destination()
            ));
        }
        if said.contains("permission denied (") {
            return Some(format!(
                "{} refused the ssh authentication. Load a key into your ssh agent: the desktop never asks for a password.",
                self.destination()
            ));
        }
        if said.contains("connection refused") {
            return Some(format!("{at} refused the connection. Check that an ssh server listens on that port."));
        }
        if said.contains("could not resolve hostname") {
            return Some(format!("{} could not be resolved.", self.host));
        }
        if said.contains("timed out") {
            return Some(format!("{at} did not answer within {CONNECT_TIMEOUT} s."));
        }
        if said.contains("not found") || said.contains("no such file") {
            return Some(format!(
                "Muse was not found at {} on {}. Install it there, or change the remote Muse path in Settings.",
                self.muse, self.host
            ));
        }
        None
    }
}

/// Spawn `argv` and wait at most `timeout` seconds while both pipes drain.
fn run_bounded(argv: &[String], timeout: u64) -> Result<Value, String> {
    let mut child = Command::new(&argv[0])
        .args(&argv[1..])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("cannot start ssh: {error}"))?;
    let stdout = child.stdout.take().map(drain_bounded);
    let stderr = child.stderr.take().map(drain_bounded);
    let collect = |reader: Option<JoinHandle<String>>| reader.and_then(|r| r.join().ok()).unwrap_or_default();
    let started = std::time::Instant::now();
    let deadline = Duration::from_secs(timeout);
    let mut timed_out = false;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                return Ok(json!({
                    "exitCode": status.code(),
                    "timedOut": false,
                    "stdout": collect(stdout),
                    "stderr": collect(stderr),
                    "elapsedMs": started.elapsed().as_millis() as u64,
                }));
            }
            Ok(None) if started.elapsed() >= deadline => {
                timed_out = true;
                // The drain threads end on their own once the pipes close.
                let _ = child.kill();
                let _ = child.wait();
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(50)),
            Err(error) => return Err(format!("ssh wait failed: {error}")),
        }
        if timed_out {
            return Ok(json!({
                "exitCode": null,
                "timedOut": true,
                "stdout": "",
                "stderr": "",
                "elapsedMs": started.elapsed().as_millis() as u64,
            }));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_gate_refuses_what_argv_cannot_carry() {
        assert!(validate("example.com", 22, "", "", "uptime").is_ok());
        assert!(validate("bad host", 22, "", "", "uptime").is_err(), "space is not a host character");
        assert!(validate("-leading-dash", 22, "", "", "uptime").is_err(), "an option-shaped host is refused");
        assert!(validate("example.com", 22, "bad user", "", "uptime").is_err());
        assert!(validate("example.com", 22, "", "C:\\keys\\id_ed25519", "uptime").is_ok());
        assert!(validate("example.com", 22, "", "bad\npath", "uptime").is_err());
        assert!(validate("example.com", 22, "", "", "").is_err(), "an empty command is refused");
        assert!(validate("example.com", 22, "", "", &"x".repeat(8_001)).is_err());
    }

    #[test]
    fn the_argv_carries_the_command_after_a_literal_separator() {
        let ssh = PathBuf::from("C:\\Windows\\System32\\OpenSSH\\ssh.exe");
        let argv = ssh_argv(&ssh, "example.com", 22, "", "", "uptime");
        assert_eq!(
            argv,
            vec![
                "C:\\Windows\\System32\\OpenSSH\\ssh.exe".to_string(),
                "-o".to_string(),
                "BatchMode=yes".to_string(),
                "-o".to_string(),
                "ConnectTimeout=10".to_string(),
                "example.com".to_string(),
                "--".to_string(),
                "uptime".to_string(),
            ]
        );
        // A dash-leading remote command still lands after `--`: it is a
        // positional, not an option of ssh.
        let sneaky = ssh_argv(&ssh, "example.com", 2222, "ops", "C:\\keys\\id", "-oProxyCommand=evil");
        assert_eq!(&sneaky[sneaky.len() - 2], "--");
        assert_eq!(&sneaky[sneaky.len() - 1], "-oProxyCommand=evil");
        assert!(sneaky.contains(&"2222".to_string()));
    }

    #[test]
    fn one_char_and_multibyte_hosts_do_not_panic() {
        assert!(validate("a", 22, "", "", "uptime").is_ok());
        assert!(validate("-", 22, "", "", "uptime").is_err());
        assert!(validate("é", 22, "", "", "uptime").is_err());
    }

    #[test]
    fn truncation_lands_on_a_char_boundary() {
        // Odd offset: byte OUTPUT_LIMIT falls inside an `é`.
        let text = format!("x{}", "é".repeat(OUTPUT_LIMIT));
        let out = drain_bounded(std::io::Cursor::new(text)).join().unwrap();
        assert!(out.ends_with('…'));
        assert!(out.len() <= OUTPUT_LIMIT + '…'.len_utf8());
        assert!(!out.contains('\u{fffd}'));
    }

    #[test]
    fn output_beyond_the_pipe_buffer_is_drained_and_bounded() {
        // ~200 KB on stdout: more than any pipe buffer, so waiting before
        // reading would stall the child until the deadline.
        let argv: Vec<String> = if cfg!(windows) {
            ["cmd", "/C", "for /L %i in (1,1,4000) do @echo 01234567890123456789012345678901234567890123456789"]
                .map(String::from)
                .to_vec()
        } else {
            ["sh", "-c", "yes 01234567890123456789012345678901234567890123456789 | head -c 200000"]
                .map(String::from)
                .to_vec()
        };
        let out = run_bounded(&argv, 60).unwrap();
        assert_eq!(out["timedOut"], false, "{out}");
        assert_eq!(out["exitCode"], 0);
        let stdout = out["stdout"].as_str().unwrap();
        assert!(stdout.ends_with('…'));
        assert!(stdout.len() <= OUTPUT_LIMIT + '…'.len_utf8());
    }

    #[test]
    fn a_remote_key_round_trips_and_never_names_a_local_folder() {
        assert!(RemoteEngine::parse("C:\\work\\proj").is_none());
        assert!(RemoteEngine::parse("/home/ops/proj").is_none());
        let remote = RemoteEngine::parse("ssh://ops@127.0.0.1:2222/home/ops/proj").unwrap().unwrap();
        assert_eq!(
            (remote.user.as_str(), remote.host.as_str(), remote.port, remote.muse.as_str(), remote.workspace.as_str()),
            ("ops", "127.0.0.1", 2222, DEFAULT_REMOTE_MUSE, "/home/ops/proj")
        );
        // The same strings as `remoteWorkspaceUri` in test/remoteSsh.test.ts.
        assert_eq!(remote.key(), "ssh://ops@127.0.0.1:2222/home/ops/proj");
        let custom = RemoteEngine::parse("ssh://box/srv/app?muse=/opt/muse/bin/muse").unwrap().unwrap();
        assert_eq!(custom.key(), "ssh://box:22/srv/app?muse=/opt/muse/bin/muse");
        assert_eq!(remote_engine(std::path::Path::new(&remote.key())), Some(remote));
    }

    #[test]
    fn hostile_remote_keys_are_refused() {
        for raw in [
            "ssh://-oProxyCommand=evil:22/srv",
            "ssh://-Elog@box:22/srv",
            "ssh://ops@box:0/srv",
            "ssh://ops@box:99999/srv",
            "ssh://ops@box:22",
            "ssh://ops@box:22/srv/a b",
            "ssh://ops@box:22/srv;reboot",
            "ssh://ops@box:22/srv?muse=$(reboot)",
            "ssh://ops@box:22/srv?muse=muse;reboot",
            "ssh://ops@box:22/srv?muse=relative/muse",
            "ssh://ops@box:22/srv?proxy=evil",
        ] {
            assert!(matches!(RemoteEngine::parse(raw), Some(Err(_))), "{raw}");
        }
    }

    #[test]
    fn the_serve_argv_is_the_local_posture_after_the_separator() {
        let remote = RemoteEngine::parse("ssh://ops@127.0.0.1:2222/home/ops/proj").unwrap().unwrap();
        let argv = remote.serve_argv(&PathBuf::from("/usr/bin/ssh"), &["serve", "--sandbox-network", "restricted", "--trust-workspace"]);
        assert_eq!(
            argv,
            [
                "/usr/bin/ssh", "-T", "-o", "ServerAliveInterval=15", "-p", "2222", "-o", "BatchMode=yes",
                "-o", "ConnectTimeout=10", "ops@127.0.0.1", "--",
                "~/.local/bin/muse serve --sandbox-network restricted --trust-workspace",
            ]
            .map(String::from)
        );
    }

    #[test]
    fn ssh_failures_become_one_actionable_sentence() {
        let remote = RemoteEngine::parse("ssh://ops@127.0.0.1:2222/home/ops/proj").unwrap().unwrap();
        let host_key = remote
            .explain_failure("No ED25519 host key is known for [127.0.0.1]:2222 and you have requested strict checking.\nHost key verification failed.")
            .unwrap();
        assert!(host_key.ends_with("ssh -p 2222 ops@127.0.0.1"), "{host_key}");
        assert!(remote.explain_failure("ops@127.0.0.1: Permission denied (publickey).").unwrap().contains("ssh agent"));
        assert!(remote.explain_failure("ssh: connect to host 127.0.0.1 port 2222: Connection refused").unwrap().contains("refused the connection"));
        assert!(remote.explain_failure("sh: 1: /home/ops/.local/bin/muse: not found").unwrap().starts_with("Muse was not found"));
        assert_eq!(remote.explain_failure("thread 'main' panicked"), None);
    }

    #[cfg(windows)]
    #[test]
    fn the_windows_binary_is_the_optional_openssh_feature() {
        // Measured on this machine: the client exists at the canonical path.
        assert!(ssh_binary().is_some(), "ssh.exe should resolve on this machine");
    }
}
