//! Explicit worktree environment setup.
//!
//! Setup commands are always entered and launched by the user. The service
//! only accepts an existing managed worktree, bounds the command/output and
//! kills a process that exceeds the timeout.

use serde::Serialize;
use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

const MAX_COMMAND_CHARS: usize = 2_000;
const MAX_OUTPUT_CHARS: usize = 200_000;
const MAX_RUNTIME: Duration = Duration::from_secs(10 * 60);

#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SetupResult {
    pub status: String,
    pub output: String,
    pub exit_code: Option<i32>,
    pub duration_ms: u64,
}

fn clip(mut output: String) -> String {
    if output.chars().count() <= MAX_OUTPUT_CHARS {
        return output;
    }
    let skip = output.chars().count().saturating_sub(MAX_OUTPUT_CHARS);
    output = output.chars().skip(skip).collect();
    format!("[setup output clipped]\n{output}")
}

fn managed_worktree(root: &Path, path: &str) -> Result<std::path::PathBuf, String> {
    let repo = root
        .canonicalize()
        .map_err(|e| format!("cannot resolve repository {}: {e}", root.display()))?;
    let managed = repo.join(".muse").join("worktrees");
    let managed = managed
        .canonicalize()
        .map_err(|e| format!("cannot resolve managed worktree root: {e}"))?;
    let raw_candidate = Path::new(path.trim());
    let candidate_path = if raw_candidate.is_absolute() {
        raw_candidate.to_path_buf()
    } else {
        repo.join(raw_candidate)
    };
    let candidate = candidate_path
        .canonicalize()
        .map_err(|e| format!("cannot resolve worktree path: {e}"))?;
    if candidate == managed || !candidate.starts_with(&managed) || !candidate.is_dir() {
        return Err("setup path must be an existing directory under .muse/worktrees".to_string());
    }
    Ok(candidate)
}

fn read_pipe<R: Read + Send + 'static>(mut reader: R) -> thread::JoinHandle<Vec<u8>> {
    thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = reader.read_to_end(&mut bytes);
        bytes
    })
}

/// Run one explicit setup command in a managed worktree.
pub fn run(root: &Path, path: &str, command: &str) -> Result<SetupResult, String> {
    run_with_cancel(root, path, command, None)
}

/// Run setup with an optional cancellation flag owned by the supervisor.
/// Cancellation is cooperative at the polling boundary and kills the child
/// process before returning a terminal result.
pub fn run_with_cancel(
    root: &Path,
    path: &str,
    command: &str,
    cancel: Option<Arc<AtomicBool>>,
) -> Result<SetupResult, String> {
    let command = command.trim();
    if command.is_empty() {
        return Err("setup command must not be empty".to_string());
    }
    if command.chars().count() > MAX_COMMAND_CHARS {
        return Err(format!("setup command is limited to {MAX_COMMAND_CHARS} characters"));
    }
    let cwd = managed_worktree(root, path)?;
    let mut child = if cfg!(windows) {
        let mut cmd = Command::new("cmd");
        cmd.args(["/D", "/S", "/C", command]);
        cmd
    } else {
        let mut cmd = Command::new("sh");
        cmd.args(["-lc", command]);
        cmd
    };
    let mut child = child
        .current_dir(&cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("could not start setup command: {e}"))?;
    let stdout = child.stdout.take().map(read_pipe);
    let stderr = child.stderr.take().map(read_pipe);
    let started = Instant::now();
    let mut timed_out = false;
    let mut cancelled = false;
    let status = loop {
        if let Some(status) = child.try_wait().map_err(|e| format!("setup wait failed: {e}"))? {
            break status;
        }
        if cancel.as_ref().is_some_and(|flag| flag.load(Ordering::Relaxed)) {
            cancelled = true;
            let _ = child.kill();
            break child.wait().map_err(|e| format!("setup cancellation wait failed: {e}"))?;
        }
        if started.elapsed() >= MAX_RUNTIME {
            timed_out = true;
            let _ = child.kill();
            break child.wait().map_err(|e| format!("setup timeout wait failed: {e}"))?;
        }
        thread::sleep(Duration::from_millis(50));
    };
    let mut output = String::new();
    if let Some(reader) = stdout {
        output.push_str(&String::from_utf8_lossy(&reader.join().unwrap_or_default()));
    }
    if let Some(reader) = stderr {
        let stderr_bytes = reader.join().unwrap_or_default();
        let stderr = String::from_utf8_lossy(&stderr_bytes);
        if !stderr.is_empty() {
            if !output.is_empty() && !output.ends_with('\n') {
                output.push('\n');
            }
            output.push_str(&stderr);
        }
    }
    Ok(SetupResult {
        status: if cancelled {
            "cancelled".to_string()
        } else if timed_out {
            "timedOut".to_string()
        } else if status.success() {
            "ready".to_string()
        } else {
            "failed".to_string()
        },
        output: clip(output),
        exit_code: status.code(),
        duration_ms: started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::Arc;

    static NEXT: AtomicU64 = AtomicU64::new(0);

    fn fixture() -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "muse-setup-test-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(root.join(".muse/worktrees/one")).unwrap();
        root
    }

    #[test]
    fn rejects_blank_and_outside_setup() {
        let root = fixture();
        assert!(run(&root, ".muse/worktrees/one", "   ").is_err());
        assert!(run(&root, &root.to_string_lossy(), "echo nope").is_err());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn reports_ready_and_failed_commands() {
        let root = fixture();
        let success = if cfg!(windows) { "echo ready" } else { "printf ready" };
        let result = run(&root, ".muse/worktrees/one", success).unwrap();
        assert_eq!(result.status, "ready");
        assert!(result.output.contains("ready"));
        let failure = if cfg!(windows) { "exit /b 3" } else { "exit 3" };
        assert_eq!(run(&root, ".muse/worktrees/one", failure).unwrap().status, "failed");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn honours_cancellation_before_process_completion() {
        let root = fixture();
        let flag = Arc::new(AtomicBool::new(true));
        let command = if cfg!(windows) {
            "ping 127.0.0.1 -n 4 > nul"
        } else {
            "sleep 4"
        };
        let result = run_with_cancel(&root, ".muse/worktrees/one", command, Some(flag)).unwrap();
        assert_eq!(result.status, "cancelled");
        let _ = fs::remove_dir_all(root);
    }
}
