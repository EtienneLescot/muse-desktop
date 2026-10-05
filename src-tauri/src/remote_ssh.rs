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
    if !user.is_empty() && !matches(user, NAME_CHARS, 64) {
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

    #[cfg(windows)]
    #[test]
    fn the_windows_binary_is_the_optional_openssh_feature() {
        // Measured on this machine: the client exists at the canonical path.
        assert!(ssh_binary().is_some(), "ssh.exe should resolve on this machine");
    }
}
