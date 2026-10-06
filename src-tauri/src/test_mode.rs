//! Isolated test mode for the M0-14 end-to-end check (ADR 0003).
//!
//! Debug builds on Windows only: elsewhere `data_dir` compiles to `None`, so
//! none of this can switch on in a shipped app, nor on macOS or Linux, where
//! it would lift the single-instance guard without moving the webview store.
//! `MUSE_DESKTOP_TEST_DATA_DIR` turns it on. That folder then holds the app
//! data and the WebView2 profile, the computer-use service gets a pipe named
//! after it (`computer::endpoint`), the single-instance guard and the OS wake-up
//! task are skipped, and every local engine is `MUSE_DESKTOP_TEST_SIDECAR`, a
//! JSON argv such as `["node", "scripts/muse-fixture.mjs"]`. A remote target
//! (`ssh://`) that the test profile itself configured is reached over the
//! system ssh, as outside test mode: a test that configures none never leaves
//! the fixture, as in CI.
//! `MUSE_DESKTOP_TEST_CDP_PORT` opens the DevTools protocol of the webview on
//! that port. `MUSE_DESKTOP_TEST_REMOTE_MCP` names the one loopback origin a
//! remote MCP connector may use over plain HTTP (`remote_mcp_origin`).

use std::path::PathBuf;

/// The switch. Only a build that can enter test mode carries this string:
/// the E2E runner refuses an exe without it.
#[cfg(all(debug_assertions, windows))]
const SWITCH: &str = "MUSE_DESKTOP_TEST_DATA_DIR";

/// The isolated instance's data folder, when test mode is on.
#[cfg(all(debug_assertions, windows))]
pub fn data_dir() -> Option<PathBuf> {
    std::env::var_os(SWITCH)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

/// A release build is never in test mode, nor macOS or Linux.
#[cfg(not(all(debug_assertions, windows)))]
pub fn data_dir() -> Option<PathBuf> {
    None
}

/// Called once in `main`, before any webview exists: moves the WebView2
/// profile (the renderer's localStorage) into the test folder and leaves
/// `test-mode.pid` there, the proof of entry the E2E runner waits for.
/// Returns whether test mode is on.
pub fn enter() -> bool {
    let Some(dir) = data_dir() else { return false };
    // A variable left in a developer shell must not switch it on silently.
    #[cfg(all(debug_assertions, windows))]
    eprintln!("muse-desktop: {SWITCH} is set, test mode: app data and WebView2 profile in {}", dir.display());
    std::env::set_var("WEBVIEW2_USER_DATA_FOLDER", dir.join("WebView2"));
    let marker = std::fs::create_dir_all(&dir)
        .and_then(|()| std::fs::write(dir.join("test-mode.pid"), std::process::id().to_string()));
    if let Err(error) = marker {
        eprintln!("muse-desktop: test mode marker not written: {error}");
    }
    true
}

/// The DevTools port goes through the WebView2 options: an elevated host, as
/// on a CI runner, ignores `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`.
pub fn open_devtools<R: tauri::Runtime>(context: &mut tauri::Context<R>) {
    let Some(args) = browser_args() else { return };
    for window in &mut context.config_mut().app.windows {
        window.additional_browser_args = Some(args.clone());
    }
}

/// The WebView2 arguments of a test instance, for every webview it opens:
/// WebView2 refuses a second webview whose options differ, so the native
/// browser window (opened at run time) needs them too — without, it never
/// showed while its command answered "opened" (M0-13, 06/10/2026).
pub fn browser_args() -> Option<String> {
    let port = data_dir()
        .and_then(|_| std::env::var("MUSE_DESKTOP_TEST_CDP_PORT").ok())
        .and_then(|value| value.parse::<u16>().ok())?;
    // Options replace wry's default arguments: keep them.
    Some(format!(
        "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --remote-debugging-port={port}"
    ))
}

/// The argv of every local engine. Fails closed: a test instance never starts a
/// real local engine; a configured ssh:// target goes over the system ssh.
pub fn sidecar_argv() -> Result<Vec<String>, String> {
    parse_argv(&std::env::var("MUSE_DESKTOP_TEST_SIDECAR").unwrap_or_default())
}

/// The one loopback origin a test instance may use as a remote MCP endpoint
/// over plain HTTP: `MUSE_DESKTOP_TEST_REMOTE_MCP`, exactly
/// `http://127.0.0.1:<port>`, where the M3-02 bearer proof runs its server
/// (`scripts/mcp-bearer-test-server.mjs`). Every other URL keeps the
/// public-HTTPS rule, and outside test mode there is none.
pub fn remote_mcp_origin() -> Option<String> {
    data_dir()?;
    loopback_origin(&std::env::var("MUSE_DESKTOP_TEST_REMOTE_MCP").ok()?)
}

fn loopback_origin(raw: &str) -> Option<String> {
    let port = raw.strip_prefix("http://127.0.0.1:")?.parse::<u16>().ok().filter(|port| *port > 0)?;
    Some(format!("http://127.0.0.1:{port}"))
}

fn parse_argv(raw: &str) -> Result<Vec<String>, String> {
    serde_json::from_str::<Vec<String>>(raw)
        .ok()
        .filter(|argv| !argv.is_empty())
        .ok_or_else(|| "test mode needs MUSE_DESKTOP_TEST_SIDECAR, a JSON argv for the fixture engine".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sidecar_argv_fails_closed() {
        assert_eq!(parse_argv(r#"["node","muse-fixture.mjs"]"#).unwrap(), ["node", "muse-fixture.mjs"]);
        assert!(parse_argv("").is_err());
        assert!(parse_argv("[]").is_err());
        assert!(parse_argv("node muse-fixture.mjs").is_err());
    }

    #[test]
    fn remote_mcp_origin_is_one_loopback_port() {
        assert_eq!(loopback_origin("http://127.0.0.1:47123").as_deref(), Some("http://127.0.0.1:47123"));
        for raw in [
            "",
            "http://127.0.0.1:0",
            "http://127.0.0.1:47123/mcp",
            "https://127.0.0.1:47123",
            "http://localhost:47123",
            "http://10.0.0.1:47123",
            "http://127.0.0.1:99999",
        ] {
            assert_eq!(loopback_origin(raw), None, "{raw}");
        }
    }
}
