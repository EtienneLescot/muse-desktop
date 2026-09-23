//! Computer use: Muse Desktop embeds the open-source CUA driver.
//!
//! What this module is, and is not. It is **not** a computer-use implementation.
//! `desktop_control.rs` tried that, and it could only observe windows and send
//! one explicit gesture; nothing in it could be handed to an agent. This module
//! instead embeds [`cua-driver`](https://github.com/trycua/cua) — MIT, a native
//! Windows/macOS/Linux driver exposing 57 MCP tools — and adds only the three
//! things the driver deliberately does not have:
//!
//!   * **one consent surface** (the driver "does not render its own authorization
//!     modal or banner", so a product that embeds it must);
//!   * **a capability manifest this app generates and approves**, so the grant is
//!     an explicit, reviewable, revocable list of tools rather than a mode;
//!   * **the agent wiring**, by handing the Muse host an MCP connection to it.
//!
//! The architecture is CUA's own "app-hosted service": the desktop app owns a
//! private service and passes the generated MCP connection to its agent, which
//! "must not start a second host". Measured on 0.28.2: a private
//! `serve --socket <pipe>` answers tool calls, and `--permission-mode bounded`
//! with a manifest really refuses what the manifest omits
//! (`Permission denied: tool 'list_windows' is outside the capability manifest`).
//!
//! Two hard rules, both structural:
//!   * the renderer never supplies a path, a binary or an argument — the
//!     endpoint, the binary and the argv are built here, so a compromised
//!     renderer cannot aim the driver at something else;
//!   * the tool vocabulary is the driver's, not ours: the manifest is built by
//!     intersecting our levels with the driver's own `list-tools`, so a tool it
//!     removed cannot be named, a tool it added is not silently granted, and
//!     anything we fail to classify is reported rather than granted.

use serde_json::{json, Value};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

/// This app's private endpoint. Never discovered, never ambient: the driver
/// documents that two bare runtimes share nothing and that callers must not
/// rely on ambient discovery.
pub const PIPE: &str = r"\\.\pipe\muse-desktop-computer";

/// A grant is bounded in time by the driver itself, and the bounds are shown in
/// the UI. They are constants rather than settings because a grant that silently
/// outlives the session is exactly the failure this feature must not have.
const EXPIRES_AFTER: &str = "12h";
const IDLE_TIMEOUT: &str = "30m";

const PROBE_TIMEOUT: Duration = Duration::from_secs(20);
const START_TIMEOUT: Duration = Duration::from_secs(15);
const MANIFEST_FILE: &str = "computer-manifest.json";

/// What the user is granting. Three levels, not fifty-seven checkboxes.
pub const LEVELS: [&str; 3] = ["observe", "control", "everything"];

/// Read-only observation: screenshots, windows, accessibility, sessions.
const OBSERVE: [&str; 19] = [
    "check_permissions",
    "debug_window_info",
    "get_accessibility_tree",
    "get_agent_cursor_state",
    "get_browser_state",
    "get_config",
    "get_cursor_position",
    "get_desktop_state",
    "get_recording_state",
    "get_screen_size",
    "get_session",
    "get_session_state",
    "get_window_state",
    "health_report",
    "list_apps",
    "list_sessions",
    "list_windows",
    "verify_state",
    "zoom",
];

/// Adds the pointer and the keyboard, and the windows they act on. `kill_app`
/// is deliberately absent: terminating a program can destroy unsaved work, so it
/// lives one level up with the other destructive tools.
const CONTROL: [&str; 19] = [
    "bring_to_front",
    "click",
    "double_click",
    "drag",
    "end_session",
    "hotkey",
    "invoke_menu",
    "launch_app",
    "move_cursor",
    "press_key",
    "right_click",
    "scroll",
    "set_agent_cursor_enabled",
    "set_agent_cursor_motion",
    "set_agent_cursor_theme",
    "set_value",
    "set_window_frame",
    "start_session",
    "type_text",
];

/// Everything else the driver offers: the clipboard, its CDP browser surface,
/// trajectory recording, configuration and updates.
const EVERYTHING: [&str; 19] = [
    "browser_click",
    "browser_dialog",
    "browser_download",
    "browser_navigate",
    "browser_pointer",
    "browser_prepare",
    "browser_set_input_files",
    "browser_type",
    "check_for_update",
    "clipboard_read",
    "clipboard_write",
    "escalate_session",
    "install_ffmpeg",
    "kill_app",
    "page",
    "replay_trajectory",
    "set_config",
    "start_recording",
    "stop_recording",
];

fn level_tools(level: &str) -> Option<Vec<&'static str>> {
    let mut tools: Vec<&'static str> = Vec::new();
    match level {
        "observe" => tools.extend(OBSERVE),
        "control" => {
            tools.extend(OBSERVE);
            tools.extend(CONTROL);
        }
        "everything" => {
            tools.extend(OBSERVE);
            tools.extend(CONTROL);
            tools.extend(EVERYTHING);
        }
        _ => return None,
    }
    Some(tools)
}

/// The tools a level grants, restricted to what the installed driver really
/// offers. Pure, so the policy has a test rather than a comment.
pub fn tools_for(level: &str, available: &[String]) -> Option<Vec<String>> {
    let wanted = level_tools(level)?;
    Some(
        wanted
            .into_iter()
            .filter(|tool| available.iter().any(|name| name == tool))
            .map(str::to_string)
            .collect(),
    )
}

/// Tools the installed driver offers that no level covers. Reported in the UI
/// rather than granted: an unknown tool is not an invitation.
pub fn unclassified(available: &[String]) -> Vec<String> {
    let classified = level_tools("everything").unwrap_or_default();
    available
        .iter()
        .filter(|tool| !classified.iter().any(|known| known == tool))
        .cloned()
        .collect()
}

/// The capability manifest handed to the driver. Bounded mode only: the driver
/// rejects a manifest whose mode is not `bounded`, and an unbounded manifest is
/// precisely what the consent surface exists to avoid.
pub fn manifest(level: &str, available: &[String]) -> Option<Value> {
    let tools = tools_for(level, available)?;
    Some(json!({
        "version": 1,
        "mode": "bounded",
        "expires_after": EXPIRES_AFTER,
        "idle_timeout": IDLE_TIMEOUT,
        "allow": { "tools": tools },
        // The driver gates resources separately from tools: without this,
        // even "observe" was refused (`list_windows` → "desktop display
        // observation is outside the capability manifest", measured on
        // cua-driver 0.28.2). Schema read from the driver's own validation.
        "resources": { "desktop": { "display": true } },
    }))
}

/// Where the driver lives: the PATH the app was started with, then the
/// canonical per-user install directory the official installer uses.
pub fn binary() -> Option<PathBuf> {
    let names: Vec<&str> = if cfg!(windows) {
        vec!["cua-driver.exe", "cua-driver"]
    } else {
        vec!["cua-driver"]
    };
    if let Some(path) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path) {
            if dir.as_os_str().is_empty() {
                continue;
            }
            for name in &names {
                let candidate = dir.join(name);
                if candidate.is_file() {
                    return Some(candidate);
                }
            }
        }
    }
    #[cfg(windows)]
    {
        if let Some(local) = std::env::var_os("LOCALAPPDATA").filter(|value| !value.is_empty()) {
            let candidate = PathBuf::from(local)
                .join("Programs")
                .join("Cua")
                .join("cua-driver")
                .join("bin")
                .join("cua-driver.exe");
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

/// The command line the app itself uses to reach its own service. Exposed so the
/// UI can show it and so the MCP configuration is built from one place.
pub fn mcp_args() -> Vec<String> {
    vec![
        "mcp".to_string(),
        "--socket".to_string(),
        PIPE.to_string(),
    ]
}

/// The MCP server entry handed to the Muse host. `None` unless this app's own
/// service holds a live grant, so a stale switch cannot send the host hunting a
/// socket, nor hand it a service whose authorization has already lapsed.
pub fn mcp_server_json(grant: &str) -> Option<Value> {
    mcp_server_for(&binary()?, grant)
}

/// The construction itself, with the binary supplied: pure enough to test on a
/// machine that has no driver installed, which is every CI runner.
fn mcp_server_for(binary: &Path, grant: &str) -> Option<Value> {
    if grant != "active" {
        return None;
    }
    Some(json!({
        "transport": "stdio",
        "command": binary.display().to_string(),
        "args": mcp_args(),
        "mode": "optional",
    }))
}

struct Probe {
    ok: bool,
    stdout: String,
}

fn hidden_window(command: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
}

/// Run the driver once and read its whole output, without ever letting it hang
/// the app. The reader threads mirror `startup.rs`: a child that fills a pipe
/// while the parent polls would otherwise deadlock.
fn run(program: &Path, args: &[&str], timeout: Duration) -> Result<Probe, String> {
    let mut command = Command::new(program);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    hidden_window(&mut command);
    let mut child = command
        .spawn()
        .map_err(|error| format!("cannot run {}: {error}", program.display()))?;
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if started.elapsed() < timeout => thread::sleep(Duration::from_millis(25)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
            Err(error) => return Err(format!("waiting for {} failed: {error}", program.display())),
        }
    };
    let stdout = child.stdout.take().map(drain);
    let stderr = child.stderr.take().map(drain);
    let mut text = String::new();
    if let Some(reader) = stdout {
        text.push_str(&String::from_utf8_lossy(&reader.join().unwrap_or_default()));
    }
    if let Some(reader) = stderr {
        let extra = String::from_utf8_lossy(&reader.join().unwrap_or_default()).to_string();
        if !extra.trim().is_empty() {
            if !text.is_empty() && !text.ends_with('\n') {
                text.push('\n');
            }
            text.push_str(&extra);
        }
    }
    match status {
        Some(status) => Ok(Probe {
            ok: status.success(),
            stdout: text,
        }),
        None => Err(format!(
            "{} did not answer within {}s",
            program.display(),
            timeout.as_secs()
        )),
    }
}

fn drain<R: Read + Send + 'static>(mut reader: R) -> thread::JoinHandle<Vec<u8>> {
    thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = reader.read_to_end(&mut bytes);
        bytes
    })
}

/// The driver's own tool list, one name per line.
pub fn available_tools(driver: &Path) -> Result<Vec<String>, String> {
    let probe = run(driver, &["list-tools"], PROBE_TIMEOUT)?;
    if !probe.ok {
        return Err("cua-driver list-tools failed".to_string());
    }
    Ok(probe
        .stdout
        .lines()
        .filter_map(|line| line.split(':').next())
        .map(str::trim)
        .filter(|name| {
            !name.is_empty()
                && name
                    .chars()
                    .all(|c| c.is_ascii_lowercase() || c == '_' || c.is_ascii_digit())
        })
        .map(str::to_string)
        .collect())
}

/// Whether this app's own service answers.
pub fn service_running(driver: &Path) -> bool {
    run(driver, &["status", "--socket", PIPE], PROBE_TIMEOUT)
        .map(|probe| probe.ok && probe.stdout.contains("daemon is running"))
        .unwrap_or(false)
}

/// The state of the grant, which is not the same as the state of the service.
///
/// Measured on 0.28.2 with `idle_timeout: "1m"`: after 75 seconds idle the
/// daemon still reports itself running, and a tool call answers
/// `Policy loading error: capability manifest idle timeout exceeded`. So a
/// service that is up can hold a grant that is over, and the UI must be able to
/// tell those apart — "enabled" that silently does nothing is the failure mode
/// this whole feature exists to avoid.
pub const GRANT_STATES: [&str; 3] = ["stopped", "active", "expired"];

pub fn grant_state(driver: &Path) -> &'static str {
    if !service_running(driver) {
        return "stopped";
    }
    // A read-only tool call is the only honest probe: the daemon's own `status`
    // reports the manifest as valid even when the grant has expired.
    match run(driver, &["call", "get_screen_size", "{}", "--socket", PIPE], PROBE_TIMEOUT) {
        Ok(probe) if probe.ok => "active",
        Ok(probe) => {
            let text = probe.stdout.to_ascii_lowercase();
            if text.contains("idle timeout") || text.contains("expired") {
                "expired"
            } else {
                // Unreadable for another reason: do not claim it is usable.
                "expired"
            }
        }
        Err(_) => "expired",
    }
}

/// Write the manifest next to the app's data and return its path.
fn write_manifest(dir: &Path, manifest: &Value) -> Result<PathBuf, String> {
    std::fs::create_dir_all(dir)
        .map_err(|error| format!("cannot create {}: {error}", dir.display()))?;
    let path = dir.join(MANIFEST_FILE);
    let text = serde_json::to_string_pretty(manifest)
        .map_err(|error| format!("cannot serialize the manifest: {error}"))?;
    std::fs::write(&path, text).map_err(|error| format!("cannot write {}: {error}", path.display()))?;
    Ok(path)
}

fn read_manifest(dir: &Path) -> Option<Value> {
    let text = std::fs::read_to_string(dir.join(MANIFEST_FILE)).ok()?;
    serde_json::from_str(&text).ok()
}

/// A stable, short identifier for a manifest, so the UI can show the user the
/// exact bytes they approved. This mirrors the sha256 the driver reports, but is
/// computed here so it exists even when the service is down.
fn manifest_digest(manifest: &Value) -> String {
    let canonical = serde_json::to_string(manifest).unwrap_or_default();
    // FNV-1a over the canonical JSON: this is a display fingerprint, not a
    // security boundary — the driver holds the real sha256.
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in canonical.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{hash:016x}")
}

/// Everything the UI needs to describe the feature honestly.
pub fn status_json(dir: &Path) -> Value {
    let manifest = read_manifest(dir);
    let Some(driver) = binary() else {
        return json!({
            "driverPath": null,
            "driverVersion": null,
            "available": false,
            "levelCounts": level_counts(&[]),
            "unclassified": [],
            "grantState": "stopped",
            "manifest": manifest,
            "manifestDigest": manifest.as_ref().map(manifest_digest),
            "doctor": null,
        });
    };
    let version = run(&driver, &["--version"], PROBE_TIMEOUT)
        .ok()
        .map(|probe| probe.stdout.trim().to_string())
        .filter(|text| !text.is_empty());
    let tools = available_tools(&driver).unwrap_or_default();
    let doctor = run(&driver, &["doctor", "--json"], PROBE_TIMEOUT)
        .ok()
        .and_then(|probe| serde_json::from_str::<Value>(&probe.stdout).ok());
    json!({
        "driverPath": driver.display().to_string(),
        "driverVersion": version,
        "available": !tools.is_empty(),
        "levelCounts": level_counts(&tools),
        "unclassified": unclassified(&tools),
        "grantState": grant_state(&driver),
        "manifest": manifest,
        "manifestDigest": read_manifest(dir).as_ref().map(manifest_digest),
        "doctor": doctor,
    })
}

fn level_counts(available: &[String]) -> Value {
    let mut counts = serde_json::Map::new();
    for level in LEVELS {
        let count = tools_for(level, available).map(|tools| tools.len()).unwrap_or(0);
        counts.insert(level.to_string(), json!(count));
    }
    Value::Object(counts)
}

/// Start the app's own service in bounded mode with a manifest built from the
/// level, and wait until it answers.
pub fn enable(level: &str, dir: &Path) -> Result<Value, String> {
    let driver = binary().ok_or_else(|| {
        "cua-driver is not installed; install it from https://cua.ai before enabling computer use"
            .to_string()
    })?;
    let available = available_tools(&driver)?;
    let manifest = manifest(level, &available)
        .ok_or_else(|| format!("unknown computer-use level {level:?}"))?;
    let path = write_manifest(dir, &manifest)?;

    if service_running(&driver) {
        // The mode and the manifest are fixed for the lifetime of the process:
        // the driver documents that an agent cannot widen them and that changing
        // them requires a restart. So a level change means a stop, not a patch.
        let _ = run(&driver, &["revoke", "--all", "--socket", PIPE], PROBE_TIMEOUT);
        let _ = run(&driver, &["stop", "--socket", PIPE], PROBE_TIMEOUT);
        thread::sleep(Duration::from_millis(400));
    }

    let mut command = Command::new(&driver);
    command
        .args([
            "serve",
            "--socket",
            PIPE,
            "--permission-mode",
            "bounded",
            "--capability-manifest",
            &path.display().to_string(),
            "--approve-capability-manifest",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    hidden_window(&mut command);
    command
        .spawn()
        .map_err(|error| format!("cannot start the computer-use service: {error}"))?;

    let started = Instant::now();
    while started.elapsed() < START_TIMEOUT {
        if grant_state(&driver) == "active" {
            return Ok(status_json(dir));
        }
        thread::sleep(Duration::from_millis(250));
    }
    Err(
        "the computer-use service did not start; run `cua-driver doctor` to see why (an interactive desktop session is required)"
            .to_string(),
    )
}

/// Revoke first, then stop: revocation is deny-only and never needs a token,
/// which is what makes "turn it off" trustworthy even if the stop fails.
pub fn disable(dir: &Path) -> Result<Value, String> {
    if let Some(driver) = binary() {
        let _ = run(&driver, &["revoke", "--all", "--socket", PIPE], PROBE_TIMEOUT);
        let _ = run(&driver, &["stop", "--socket", PIPE], PROBE_TIMEOUT);
    }
    let _ = std::fs::remove_file(dir.join(MANIFEST_FILE));
    Ok(status_json(dir))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The exact list `cua-driver 0.28.2` reports through `list-tools`.
    const V0282: [&str; 57] = [
        "bring_to_front",
        "browser_click",
        "browser_dialog",
        "browser_download",
        "browser_navigate",
        "browser_pointer",
        "browser_prepare",
        "browser_set_input_files",
        "browser_type",
        "check_for_update",
        "check_permissions",
        "click",
        "clipboard_read",
        "clipboard_write",
        "debug_window_info",
        "double_click",
        "drag",
        "end_session",
        "escalate_session",
        "get_accessibility_tree",
        "get_agent_cursor_state",
        "get_browser_state",
        "get_config",
        "get_cursor_position",
        "get_desktop_state",
        "get_recording_state",
        "get_screen_size",
        "get_session",
        "get_session_state",
        "get_window_state",
        "health_report",
        "hotkey",
        "install_ffmpeg",
        "invoke_menu",
        "kill_app",
        "launch_app",
        "list_apps",
        "list_sessions",
        "list_windows",
        "move_cursor",
        "page",
        "press_key",
        "replay_trajectory",
        "right_click",
        "scroll",
        "set_agent_cursor_enabled",
        "set_agent_cursor_motion",
        "set_agent_cursor_theme",
        "set_config",
        "set_value",
        "set_window_frame",
        "start_recording",
        "start_session",
        "stop_recording",
        "type_text",
        "verify_state",
        "zoom",
    ];

    fn fixture() -> Vec<String> {
        V0282.iter().map(|name| name.to_string()).collect()
    }

    #[test]
    fn every_tool_of_the_measured_driver_is_classified() {
        let available = fixture();
        assert_eq!(available.len(), 57, "the fixture is the measured surface");
        assert!(
            unclassified(&available).is_empty(),
            "these tools belong to no level and would be silently ungrantable: {:?}",
            unclassified(&available)
        );
        let everything = tools_for("everything", &available).unwrap();
        assert_eq!(
            everything.len(),
            57,
            "the widest level must cover the whole reviewed surface"
        );
    }

    #[test]
    fn levels_grow_strictly_and_keep_the_drivers_vocabulary() {
        let available = fixture();
        let observe = tools_for("observe", &available).unwrap();
        let control = tools_for("control", &available).unwrap();
        let everything = tools_for("everything", &available).unwrap();
        assert!(observe.len() < control.len());
        assert!(control.len() < everything.len());
        assert!(observe.iter().all(|tool| control.contains(tool)));
        assert!(control.iter().all(|tool| everything.contains(tool)));
        // Nothing is invented: every granted name exists in the driver's list.
        assert!(everything.iter().all(|tool| available.contains(tool)));
    }

    #[test]
    fn killing_an_application_is_not_part_of_control() {
        let available = fixture();
        let control = tools_for("control", &available).unwrap();
        assert!(
            !control.contains(&"kill_app".to_string()),
            "terminating a program can lose unsaved work; it belongs to the widest level"
        );
        assert!(tools_for("everything", &available)
            .unwrap()
            .contains(&"kill_app".to_string()));
    }

    #[test]
    fn an_unknown_level_grants_nothing() {
        let available = fixture();
        assert!(tools_for("admin", &available).is_none());
        assert!(manifest("admin", &available).is_none());
    }

    #[test]
    fn a_tool_the_driver_no_longer_offers_is_dropped_not_guessed() {
        let reduced: Vec<String> = fixture()
            .into_iter()
            .filter(|tool| tool != "click" && tool != "type_text")
            .collect();
        let control = tools_for("control", &reduced).unwrap();
        assert!(!control.contains(&"click".to_string()));
        assert!(!control.contains(&"type_text".to_string()));
        assert!(control.contains(&"get_screen_size".to_string()));
    }

    #[test]
    fn a_tool_the_driver_added_is_reported_and_not_granted() {
        let mut available = fixture();
        available.push("brand_new_tool".to_string());
        assert_eq!(unclassified(&available), vec!["brand_new_tool".to_string()]);
        let everything = tools_for("everything", &available).unwrap();
        assert!(!everything.contains(&"brand_new_tool".to_string()));
    }

    #[test]
    fn the_manifest_is_always_bounded_and_time_boxed() {
        let available = fixture();
        let value = manifest("control", &available).unwrap();
        assert_eq!(value["version"], json!(1));
        assert_eq!(
            value["mode"], "bounded",
            "the driver refuses a legacy manifest whose mode is not bounded"
        );
        assert_eq!(value["expires_after"], json!(EXPIRES_AFTER));
        assert_eq!(value["idle_timeout"], json!(IDLE_TIMEOUT));
        // The only field the driver accepts inside `allow` is `tools`.
        let allow = value["allow"].as_object().expect("allow is an object");
        assert_eq!(allow.len(), 1);
        assert!(allow["tools"].is_array());
    }

    #[test]
    fn every_level_grants_display_observation() {
        let available = fixture();
        for level in LEVELS {
            let m = manifest(level, &available).unwrap();
            assert_eq!(m["resources"]["desktop"]["display"], true, "{level}");
        }
    }

    #[test]
    fn the_manifest_digest_is_stable_and_short() {
        let available = fixture();
        let one = manifest("observe", &available).unwrap();
        let two = manifest("observe", &available).unwrap();
        assert_eq!(manifest_digest(&one), manifest_digest(&two));
        assert_ne!(
            manifest_digest(&one),
            manifest_digest(&manifest("control", &available).unwrap())
        );
        assert_eq!(manifest_digest(&one).len(), 16);
    }

    /// The renderer must not be able to aim the driver anywhere: no path, no
    /// argument, no endpoint crosses this boundary as data.
    #[test]
    fn the_renderer_facing_payload_carries_no_path_control() {
        let status = status_json(std::env::temp_dir().as_path());
        let object = status.as_object().expect("status is an object");
        let mut keys: Vec<&str> = object.keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            [
                "available",
                "doctor",
                "driverPath",
                "driverVersion",
                "grantState",
                "levelCounts",
                "manifest",
                "manifestDigest",
                "unclassified"
            ],
            "the computer-use payload changed shape; review any new field for path or argv control"
        );
        assert!(object["levelCounts"].is_object());
        let grant = object["grantState"].as_str().expect("grantState is a string");
        assert!(
            GRANT_STATES.contains(&grant),
            "grantState must be one of the three documented values, got {grant}"
        );
    }

    #[test]
    fn the_mcp_entry_uses_this_apps_own_endpoint() {
        let driver = Path::new("C:\\cua-driver.exe");
        let entry =
            mcp_server_for(driver, "active").expect("an entry is built while the grant is live");
        assert_eq!(entry["transport"], json!("stdio"));
        assert_eq!(entry["mode"], json!("optional"));
        assert_eq!(entry["command"], json!("C:\\cua-driver.exe"));
        let args = entry["args"].as_array().expect("args is an array");
        assert_eq!(args[0], json!("mcp"));
        assert_eq!(args[1], json!("--socket"));
        assert_eq!(args[2], json!(PIPE), "the endpoint is ours, never discovered");
    }

    /// A grant that has lapsed must not be handed to the host: the service is
    /// still up in that state, which is exactly what makes it easy to get wrong.
    #[test]
    fn only_a_live_grant_is_offered_to_the_host() {
        let driver = Path::new("C:\\cua-driver.exe");
        assert!(mcp_server_for(driver, "stopped").is_none());
        assert!(mcp_server_for(driver, "expired").is_none());
        assert!(mcp_server_for(driver, "active").is_some());
    }
}
