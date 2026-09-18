//! Native one-shot wake-up for the renderer scheduler.
//!
//! Windows uses Task Scheduler to launch the already-installed executable at
//! the next occurrence. The launched application performs the normal SSOT
//! due check; this module never executes a schedule or a prompt itself.

use chrono::{SecondsFormat, Utc};
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

pub const SCHEMA: &str = "muse-desktop.scheduler-wakeup.v1";
const TASK_NAME: &str = "Muse-Desktop\\AutomationWake";
const MAX_FUTURE_MS: u64 = 366 * 24 * 60 * 60 * 1_000;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WakeupResponse {
    pub schema: String,
    pub supported: bool,
    pub installed: bool,
    pub wake_at: Option<u64>,
    pub message: String,
}

fn response(
    supported: bool,
    installed: bool,
    wake_at: Option<u64>,
    message: &str,
) -> WakeupResponse {
    WakeupResponse {
        schema: SCHEMA.to_string(),
        supported,
        installed,
        wake_at,
        message: message.to_string(),
    }
}

fn checked_wake_at(wake_at: Option<u64>, now: u64) -> Result<Option<u64>, String> {
    let Some(value) = wake_at else {
        return Ok(None);
    };
    if now == 0 || value == 0 {
        return Err("scheduler wake-up time is invalid".to_string());
    }
    let normalized = if value <= now.saturating_add(1_000) {
        now.saturating_add(60_000)
    } else {
        value
    };
    if normalized.saturating_sub(now) > MAX_FUTURE_MS {
        return Err("scheduler wake-up is too far in the future".to_string());
    }
    Ok(Some(normalized))
}

fn xml_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

/// Build the Task Scheduler XML without machine-specific state besides the
/// executable path and the requested UTC start boundary.
pub fn task_xml(executable: &Path, wake_at: u64) -> Result<String, String> {
    let path = executable
        .to_str()
        .ok_or_else(|| "scheduler executable path is not valid UTF-8".to_string())?;
    let timestamp = chrono::DateTime::<Utc>::from_timestamp_millis(wake_at as i64)
        .ok_or_else(|| "scheduler wake-up time cannot be represented".to_string())?
        .to_rfc3339_opts(SecondsFormat::Secs, true);
    Ok(format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>Wake Muse-Desktop for a scheduled automation.</Description></RegistrationInfo>
  <Triggers><TimeTrigger><StartBoundary>{timestamp}</StartBoundary><Enabled>true</Enabled></TimeTrigger></Triggers>
  <Principals><Principal id="Author"><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><StartWhenAvailable>true</StartWhenAvailable><ExecutionTimeLimit>PT10M</ExecutionTimeLimit><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries></Settings>
  <Actions Context="Author"><Exec><Command>{command}</Command><Arguments>--automation-wakeup</Arguments></Exec></Actions>
</Task>
"#,
        timestamp = timestamp,
        command = xml_escape(path),
    ))
}

#[cfg(target_os = "windows")]
fn run_schtasks(args: &[&str]) -> Result<(), String> {
    let output = Command::new("schtasks.exe")
        .args(args)
        .output()
        .map_err(|error| format!("Windows Task Scheduler is unavailable: {error}"))?;
    if output.status.success() {
        return Ok(());
    }
    let detail = String::from_utf8_lossy(&output.stderr);
    let detail = detail.trim();
    if detail.is_empty() {
        Err("Windows Task Scheduler rejected the wake-up task".to_string())
    } else {
        Err(format!(
            "Windows Task Scheduler rejected the wake-up task: {}",
            detail.chars().take(400).collect::<String>()
        ))
    }
}

/// Create, replace, or remove the one-shot OS wake-up. Non-Windows builds
/// return a clear unsupported status and keep the local scheduler contract.
pub fn sync(
    data_dir: &Path,
    executable: &Path,
    wake_at: Option<u64>,
    now: u64,
) -> Result<WakeupResponse, String> {
    let wake_at = checked_wake_at(wake_at, now)?;
    #[cfg(target_os = "windows")]
    {
        fs::create_dir_all(data_dir)
            .map_err(|error| format!("scheduler wake-up directory unavailable: {error}"))?;
        if wake_at.is_none() {
            let _ = run_schtasks(&["/Delete", "/TN", TASK_NAME, "/F"]);
            return Ok(response(
                true,
                false,
                None,
                "Native wake-up cleared; no enabled automation is scheduled.",
            ));
        }
        let xml_path: PathBuf = data_dir.join("scheduler-wakeup.xml");
        let xml = task_xml(executable, wake_at.unwrap())?;
        fs::write(&xml_path, xml).map_err(|error| {
            format!("scheduler wake-up definition could not be written: {error}")
        })?;
        let path_text = xml_path
            .to_str()
            .ok_or_else(|| "scheduler wake-up definition path is invalid".to_string())?;
        let result = run_schtasks(&["/Create", "/TN", TASK_NAME, "/XML", path_text, "/F"]);
        let _ = fs::remove_file(&xml_path);
        result?;
        return Ok(response(
            true,
            true,
            wake_at,
            "Native wake-up scheduled for the next automation.",
        ));
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (data_dir, executable, wake_at);
        Ok(response(
            false,
            false,
            None,
            "Native wake-up is not available on this platform; keep Muse open for automations.",
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wake_time_is_bounded_and_due_values_are_delayed() {
        assert_eq!(checked_wake_at(Some(9_000), 10_000).unwrap(), Some(70_000));
        assert!(checked_wake_at(Some(10_000 + MAX_FUTURE_MS + 1), 10_000).is_err());
        assert!(checked_wake_at(None, 10_000).unwrap().is_none());
    }

    #[test]
    fn task_xml_is_utc_and_escapes_the_executable_path() {
        let xml = task_xml(
            Path::new(r#"C:\Muse & Desktop\Muse-Desktop.exe"#),
            1_735_689_600_000,
        )
        .unwrap();
        assert!(xml.contains("StartBoundary>2025-01-01T00:00:00Z"));
        assert!(xml.contains("C:\\Muse &amp; Desktop"));
        assert!(xml.contains("--automation-wakeup"));
    }
}
