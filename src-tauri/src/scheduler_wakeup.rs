//! Native one-shot wake-up for the renderer scheduler.
//!
//! Windows uses Task Scheduler to launch the already-installed executable at
//! the next occurrence. The launched application performs the normal SSOT
//! due check; this module never executes a schedule or a prompt itself.

use chrono::{SecondsFormat, Utc};
#[cfg(any(target_os = "macos", test))]
use chrono::{Datelike, TimeZone, Timelike};
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

pub const SCHEMA: &str = "muse-desktop.scheduler-wakeup.v1";
const TASK_NAME: &str = "Muse-Desktop\\AutomationWake";
#[cfg(any(target_os = "macos", test))]
const MAC_LABEL: &str = "com.muse.desktop.automation-wake";
#[cfg(target_os = "linux")]
const LINUX_SERVICE: &str = "muse-desktop-automation-wake.service";
#[cfg(target_os = "linux")]
const LINUX_TIMER: &str = "muse-desktop-automation-wake.timer";
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

#[cfg(target_os = "macos")]
fn launchd_uid() -> Result<String, String> {
    let output = Command::new("id")
        .arg("-u")
        .output()
        .map_err(|error| format!("macOS launchd user lookup failed: {error}"))?;
    if !output.status.success() {
        return Err("macOS launchd user lookup failed".to_string());
    }
    let uid = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if uid.is_empty() || !uid.chars().all(|ch| ch.is_ascii_digit()) {
        return Err("macOS launchd returned an invalid user id".to_string());
    }
    Ok(uid)
}

#[cfg(any(target_os = "macos", test))]
fn launchd_plist(executable: &Path, wake_at: u64) -> Result<String, String> {
    let command = executable
        .to_str()
        .ok_or_else(|| "scheduler executable path is not valid UTF-8".to_string())?;
    let local = Utc
        .timestamp_millis_opt(wake_at as i64)
        .single()
        .ok_or_else(|| "scheduler wake-up time cannot be represented".to_string())?
        .with_timezone(&chrono::Local);
    Ok(format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>{label}</string>
  <key>ProgramArguments</key><array><string>{command}</string><string>--automation-wakeup</string></array>
  <key>StartCalendarInterval</key><dict>
    <key>Month</key><integer>{month}</integer>
    <key>Day</key><integer>{day}</integer>
    <key>Hour</key><integer>{hour}</integer>
    <key>Minute</key><integer>{minute}</integer>
  </dict>
  <key>RunAtLoad</key><false/>
  <key>ProcessType</key><string>Background</string>
</dict></plist>
"#,
        label = xml_escape(MAC_LABEL),
        command = xml_escape(command),
        month = local.month(),
        day = local.day(),
        hour = local.hour(),
        minute = local.minute(),
    ))
}

#[cfg(target_os = "macos")]
fn run_launchctl(args: &[&str]) -> Result<(), String> {
    let output = Command::new("launchctl")
        .args(args)
        .output()
        .map_err(|error| format!("macOS launchd is unavailable: {error}"))?;
    if output.status.success() {
        return Ok(());
    }
    let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Err(if detail.is_empty() {
        "macOS launchd rejected the wake-up job".to_string()
    } else {
        format!(
            "macOS launchd rejected the wake-up job: {}",
            detail.chars().take(400).collect::<String>()
        )
    })
}

#[cfg(target_os = "linux")]
fn systemd_user_dir() -> Result<PathBuf, String> {
    if let Some(config) = std::env::var_os("XDG_CONFIG_HOME") {
        return Ok(PathBuf::from(config).join("systemd/user"));
    }
    let home = std::env::var_os("HOME")
        .ok_or_else(|| "HOME is unavailable for systemd user scheduling".to_string())?;
    Ok(PathBuf::from(home).join(".config/systemd/user"))
}

#[cfg(any(target_os = "linux", test))]
fn systemd_escape(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('%', "%%")
        .replace('\n', " ")
}

#[cfg(any(target_os = "linux", test))]
fn systemd_unit_files(executable: &Path, wake_at: u64) -> Result<(String, String), String> {
    let command = executable
        .to_str()
        .ok_or_else(|| "scheduler executable path is not valid UTF-8".to_string())?;
    let timestamp = chrono::DateTime::<Utc>::from_timestamp_millis(wake_at as i64)
        .ok_or_else(|| "scheduler wake-up time cannot be represented".to_string())?
        .format("%Y-%m-%d %H:%M:%S UTC")
        .to_string();
    let service = format!(
        "[Unit]\nDescription=Wake Muse-Desktop for a scheduled automation\n\n[Service]\nType=oneshot\nExecStart=\"{}\" --automation-wakeup\n",
        systemd_escape(command),
    );
    let timer = format!(
        "[Unit]\nDescription=One-shot Muse-Desktop automation wake-up\n\n[Timer]\nOnCalendar={}\nPersistent=true\nAccuracySec=1s\nUnit=muse-desktop-automation-wake.service\n\n[Install]\nWantedBy=timers.target\n",
        timestamp,
    );
    Ok((service, timer))
}

#[cfg(target_os = "linux")]
fn run_systemctl(args: &[&str]) -> Result<(), String> {
    let output = Command::new("systemctl")
        .args(["--user"])
        .args(args)
        .output()
        .map_err(|error| format!("systemd user scheduler is unavailable: {error}"))?;
    if output.status.success() {
        return Ok(());
    }
    let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Err(if detail.is_empty() {
        "systemd user scheduler rejected the wake-up timer".to_string()
    } else {
        format!(
            "systemd user scheduler rejected the wake-up timer: {}",
            detail.chars().take(400).collect::<String>()
        )
    })
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
    #[cfg(target_os = "macos")]
    {
        let uid = launchd_uid()?;
        let home = std::env::var_os("HOME")
            .ok_or_else(|| "HOME is unavailable for launchd scheduling".to_string())?;
        let plist_path = PathBuf::from(home)
            .join("Library/LaunchAgents")
            .join(format!("{MAC_LABEL}.plist"));
        let target = format!("gui/{uid}/{MAC_LABEL}");
        let _ = run_launchctl(&["bootout", &target]);
        if wake_at.is_none() {
            let _ = fs::remove_file(&plist_path);
            return Ok(response(
                true,
                false,
                None,
                "Native wake-up cleared; no enabled automation is scheduled.",
            ));
        }
        if let Some(parent) = plist_path.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("launchd wake-up directory unavailable: {error}"))?;
        }
        let plist = launchd_plist(executable, wake_at.unwrap())?;
        fs::write(&plist_path, plist)
            .map_err(|error| format!("launchd wake-up definition could not be written: {error}"))?;
        let path = plist_path
            .to_str()
            .ok_or_else(|| "launchd wake-up definition path is invalid".to_string())?;
        run_launchctl(&["bootstrap", &format!("gui/{uid}"), path])?;
        return Ok(response(
            true,
            true,
            wake_at,
            "Native wake-up scheduled for the next automation.",
        ));
    }
    #[cfg(target_os = "linux")]
    {
        let unit_dir = systemd_user_dir()?;
        let service_path = unit_dir.join(LINUX_SERVICE);
        let timer_path = unit_dir.join(LINUX_TIMER);
        let _ = run_systemctl(&["disable", "--now", LINUX_TIMER]);
        if wake_at.is_none() {
            let _ = fs::remove_file(service_path);
            let _ = fs::remove_file(timer_path);
            let _ = run_systemctl(&["daemon-reload"]);
            return Ok(response(
                true,
                false,
                None,
                "Native wake-up cleared; no enabled automation is scheduled.",
            ));
        }
        fs::create_dir_all(&unit_dir)
            .map_err(|error| format!("systemd user unit directory unavailable: {error}"))?;
        let (service, timer) = systemd_unit_files(executable, wake_at.unwrap())?;
        fs::write(&service_path, service)
            .map_err(|error| format!("systemd service definition could not be written: {error}"))?;
        fs::write(&timer_path, timer)
            .map_err(|error| format!("systemd timer definition could not be written: {error}"))?;
        run_systemctl(&["daemon-reload"])?;
        run_systemctl(&["enable", "--now", LINUX_TIMER])?;
        return Ok(response(
            true,
            true,
            wake_at,
            "Native wake-up scheduled for the next automation.",
        ));
    }
    #[cfg(not(target_os = "windows"))]
    {
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        unreachable!("platform-specific scheduler branch returned above");
        #[cfg(not(any(target_os = "macos", target_os = "linux")))]
        let _ = (data_dir, executable, wake_at);
        #[cfg(not(any(target_os = "macos", target_os = "linux")))]
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
        assert_eq!(checked_wake_at(Some(10_000), 10_000).unwrap(), Some(70_000));
        assert_eq!(checked_wake_at(Some(11_001), 10_000).unwrap(), Some(11_001));
        assert!(checked_wake_at(Some(10_000 + MAX_FUTURE_MS + 1), 10_000).is_err());
        assert!(checked_wake_at(None, 10_000).unwrap().is_none());
        assert!(checked_wake_at(Some(0), 10_000).is_err());
        assert!(checked_wake_at(Some(10_000), 0).is_err());
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
        assert!(xml.contains("<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>"));
        assert!(xml.contains("--automation-wakeup"));
    }

    #[test]
    fn launchd_plist_is_one_shot_and_escapes_command() {
        let plist = launchd_plist(
            Path::new("/Applications/Muse & Desktop.app/Contents/MacOS/Muse"),
            1_735_689_600_000,
        )
        .unwrap();
        assert!(plist.contains("StartCalendarInterval</key>"));
        assert!(plist.contains("<key>Month</key><integer>1</integer>"));
        assert!(plist.contains("Muse &amp; Desktop"));
        assert!(plist.contains("--automation-wakeup"));
    }

    #[test]
    fn systemd_units_are_user_scoped_and_percent_safe() {
        let (service, timer) =
            systemd_unit_files(Path::new("/opt/Muse Desktop/Muse"), 1_735_689_600_000).unwrap();
        assert!(service.contains("ExecStart=\"/opt/Muse Desktop/Muse\" --automation-wakeup"));
        assert!(timer.contains("OnCalendar=2025-01-01 00:00:00 UTC"));
        assert_eq!(systemd_escape("100% ready"), "100%% ready");
    }
}
