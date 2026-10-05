//! Isolated test mode for the M0-14 end-to-end check (ADR 0003).
//!
//! Debug builds only: a release build compiles `data_dir` to `None`, so none
//! of this can switch on in a shipped app. `MUSE_DESKTOP_TEST_DATA_DIR` turns
//! it on. That folder then holds the app data and the WebView2 profile, the
//! single-instance guard and the OS wake-up task are skipped, and every engine
//! is `MUSE_DESKTOP_TEST_SIDECAR`, a JSON argv such as
//! `["node", "scripts/muse-fixture.mjs"]`.

use std::path::PathBuf;

/// The isolated instance's data folder, when test mode is on.
#[cfg(debug_assertions)]
pub fn data_dir() -> Option<PathBuf> {
    std::env::var_os("MUSE_DESKTOP_TEST_DATA_DIR")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

/// A release build is never in test mode.
#[cfg(not(debug_assertions))]
pub fn data_dir() -> Option<PathBuf> {
    None
}

/// Called once, first thing in `main`: moves the WebView2 profile (the
/// renderer's localStorage) into the test folder. Returns whether test mode is on.
pub fn enter() -> bool {
    let Some(dir) = data_dir() else { return false };
    std::env::set_var("WEBVIEW2_USER_DATA_FOLDER", dir.join("WebView2"));
    true
}

/// The engine argv. Fails closed: a test instance never starts a real engine.
pub fn sidecar_argv() -> Result<Vec<String>, String> {
    parse_argv(&std::env::var("MUSE_DESKTOP_TEST_SIDECAR").unwrap_or_default())
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
}
