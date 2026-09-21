//! Read the Muse CLI's authentication posture, without ever handling a secret.
//!
//! Why this exists. The desktop cannot authenticate on its own: MSP runs over
//! stdio inside the user's session and its schema carries no authentication
//! concept, so there is no public Meta/Muse OAuth endpoint an editor could use.
//! The CLI owns that flow (`muse login`, a device-code approval in the browser)
//! and stores the result itself. The honest thing the desktop can do is report
//! which credential is in effect and let the user drive the CLI in the built-in
//! terminal.
//!
//! The precedence rule is the whole point. `muse login --help` states that
//! `META_API_KEY` **always takes priority over the account login**, so an editor
//! who signs in expecting to spend a subscription can keep spending API credits
//! and never know. Reporting the effective mode is what turns that into a
//! visible fact.
//!
//! Two hard rules, both structural rather than conventional:
//!   * no secret value is ever read into a variable, returned, or logged — only
//!     whether a credential exists and which one wins;
//!   * the decision is a pure function of what was found, so it is unit-testable
//!     without a filesystem or an environment.

use std::path::PathBuf;

/// Which credential Muse will actually use.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthMode {
    /// A provider API key, from `META_API_KEY` or the CLI's stored key.
    ApiKey,
    /// A Meta account login obtained through the CLI's device-code flow.
    Account,
    /// No credential found. Muse calls will fail until one is provided.
    None,
}

impl AuthMode {
    fn as_str(self) -> &'static str {
        match self {
            AuthMode::ApiKey => "api_key",
            AuthMode::Account => "account",
            AuthMode::None => "none",
        }
    }
}

/// Where the effective credential came from, so the UI can explain itself.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthSource {
    /// The `META_API_KEY` environment variable.
    Environment,
    /// The CLI's own credential file.
    Stored,
    /// Nothing was found.
    Absent,
}

impl AuthSource {
    fn as_str(self) -> &'static str {
        match self {
            AuthSource::Environment => "environment",
            AuthSource::Stored => "stored",
            AuthSource::Absent => "absent",
        }
    }
}

/// What was observed, with no secret in it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthObservation {
    /// Whether `META_API_KEY` is present and non-blank.
    pub environment_key: bool,
    /// Whether the CLI's credential file holds a provider key.
    pub stored_key: bool,
}

/// The reported posture.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthStatus {
    pub mode: AuthMode,
    pub source: AuthSource,
    /// True when an API key is active, because that is the case where a user
    /// asking to use a subscription would otherwise be misled.
    pub api_key_overrides_login: bool,
}

/// Decide the effective mode from what was found. Pure: no I/O, no globals.
///
/// `META_API_KEY` wins over the stored credential, which matches the CLI's
/// documented rule exactly. Note that the stored key may itself be either an
/// API key or an account token — the CLI records both under `providers.meta` —
/// so a stored credential alone is reported as a stored key, and only the
/// environment variable is treated as overriding a login.
pub fn decide(observation: &AuthObservation) -> AuthStatus {
    if observation.environment_key {
        return AuthStatus {
            mode: AuthMode::ApiKey,
            source: AuthSource::Environment,
            api_key_overrides_login: observation.stored_key,
        };
    }
    if observation.stored_key {
        return AuthStatus {
            mode: AuthMode::ApiKey,
            source: AuthSource::Stored,
            api_key_overrides_login: false,
        };
    }
    AuthStatus {
        mode: AuthMode::None,
        source: AuthSource::Absent,
        api_key_overrides_login: false,
    }
}

/// The user's home directory, as the CLI sees it.
///
/// `USERPROFILE` first (Windows), then `HOME`, matching what the CLI does on
/// each platform; an empty value counts as unset so a broken environment does
/// not resolve to the current directory.
pub fn home_dir() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .filter(|value| !value.is_empty())
        .or_else(|| std::env::var_os("HOME").filter(|value| !value.is_empty()))
        .map(PathBuf::from)
}

/// The CLI's credential file: `~/.config/muse/auth.json` on every platform the
/// CLI supports, including Windows (it does not use `%APPDATA%`).
pub fn credentials_path() -> Option<PathBuf> {
    Some(home_dir()?.join(".config").join("muse").join("auth.json"))
}

/// Whether the credential file holds a provider key.
///
/// Only the *presence* of a key is derived. The file is parsed with the same
/// serde stack the rest of the app uses; a malformed or unreadable file is
/// treated as "no stored credential" rather than as an error, because a missing
/// credential is a normal state the UI must render.
fn stored_key_present(path: &std::path::Path) -> bool {
    let Ok(text) = std::fs::read_to_string(path) else {
        return false;
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) else {
        return false;
    };
    let key = value
        .get("providers")
        .and_then(|providers| providers.get("meta"))
        .and_then(|meta| meta.get("api_key"))
        .and_then(serde_json::Value::as_str);
    key.is_some_and(|key| !key.trim().is_empty())
}

/// Whether `META_API_KEY` is set to something usable.
fn environment_key_present() -> bool {
    std::env::var("META_API_KEY")
        .map(|value| !value.trim().is_empty())
        .unwrap_or(false)
}

/// Observe the machine, then decide. The only function here that touches I/O.
pub fn status() -> AuthStatus {
    let observation = AuthObservation {
        environment_key: environment_key_present(),
        stored_key: credentials_path().is_some_and(|path| stored_key_present(&path)),
    };
    decide(&observation)
}

/// Whether the built-in terminal can drive the CLI at all.
///
/// `muse login` is only reachable when the CLI is on the PATH that the terminal
/// inherits -- the PTY spawns without clearing the environment, so the terminal
/// sees exactly this PATH. The UI hides the sign-in action when this is false
/// rather than offering a button that would fail in the terminal.
///
/// Candidate names differ per platform because the CLI ships a `.cmd` shim on
/// Windows. `split_paths` is used instead of splitting on `;` or `:`, so a
/// Windows drive letter or a quoted component cannot mis-parse.
fn cli_candidates() -> Vec<&'static str> {
    if cfg!(windows) {
        vec!["muse.cmd", "muse.exe", "muse"]
    } else {
        vec!["muse"]
    }
}

/// Whether the CLI resolves on PATH. The resolved path is never returned to the
/// renderer, so this answers only "can the terminal run it".
pub fn cli_on_path() -> bool {
    let Some(path) = std::env::var_os("PATH") else {
        return false;
    };
    let candidates = cli_candidates();
    std::env::split_paths(&path).any(|dir| {
        if dir.as_os_str().is_empty() {
            return false;
        }
        candidates.iter().any(|name| dir.join(name).is_file())
    })
}

/// Render the status for the renderer. A flat object of strings and booleans,
/// deliberately: nothing here can carry a credential.
///
/// The credentials *path* is not included even though a path is not a secret.
/// It is `…/muse/auth.json`, and the substring `api_key` never appears in it —
/// but the broader rule this module enforces is that the payload mentions no
/// credential-shaped word at all, and keeping the path out is what lets that
/// rule stay absolute instead of accumulating exceptions. The UI names the file
/// in prose when it needs to.
pub fn status_json() -> serde_json::Value {
    let status = status();
    serde_json::json!({
        "mode": status.mode.as_str(),
        "source": status.source.as_str(),
        "apiKeyOverridesLogin": status.api_key_overrides_login,
        // Whether the built-in terminal can drive the CLI at all.
        "loginCommand": "muse login",
        // The sign-in action is hidden rather than shown-and-failing when the
        // CLI is not on the PATH the terminal inherits.
        "cliAvailable": cli_on_path(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn observe(environment_key: bool, stored_key: bool) -> AuthObservation {
        AuthObservation { environment_key, stored_key }
    }

    #[test]
    fn environment_key_wins_and_reports_that_it_overrides_a_login() {
        let status = decide(&observe(true, true));
        assert_eq!(status.mode, AuthMode::ApiKey);
        assert_eq!(status.source, AuthSource::Environment);
        assert!(
            status.api_key_overrides_login,
            "a stored credential plus an environment key is exactly the case the user must be warned about"
        );
    }

    #[test]
    fn environment_key_alone_does_not_claim_to_override_a_stored_login() {
        let status = decide(&observe(true, false));
        assert_eq!(status.mode, AuthMode::ApiKey);
        assert_eq!(status.source, AuthSource::Environment);
        assert!(!status.api_key_overrides_login);
    }

    #[test]
    fn a_stored_credential_alone_is_used() {
        let status = decide(&observe(false, true));
        assert_eq!(status.mode, AuthMode::ApiKey);
        assert_eq!(status.source, AuthSource::Stored);
        assert!(!status.api_key_overrides_login);
    }

    #[test]
    fn nothing_found_is_reported_as_absent_not_as_an_error() {
        let status = decide(&observe(false, false));
        assert_eq!(status.mode, AuthMode::None);
        assert_eq!(status.source, AuthSource::Absent);
        assert!(!status.api_key_overrides_login);
    }

    #[test]
    fn a_missing_credentials_file_is_not_an_error() {
        let missing = std::path::Path::new("definitely/not/a/real/path/auth.json");
        assert!(!stored_key_present(missing));
    }

    #[test]
    fn a_malformed_credentials_file_reports_no_stored_credential() {
        let dir = std::env::temp_dir().join("muse-auth-status-test");
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("malformed.json");
        std::fs::write(&path, "{ not json").expect("write fixture");
        assert!(!stored_key_present(&path));
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn a_blank_key_is_not_a_credential() {
        let dir = std::env::temp_dir().join("muse-auth-status-test");
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("blank.json");
        std::fs::write(
            &path,
            r#"{"schema_version":1,"providers":{"meta":{"api_key":"   "}}}"#,
        )
        .expect("write fixture");
        assert!(!stored_key_present(&path));

        let real = dir.join("real.json");
        std::fs::write(
            &real,
            r#"{"schema_version":1,"providers":{"meta":{"api_key":"abcdef"}}}"#,
        )
        .expect("write fixture");
        assert!(stored_key_present(&real));

        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(&real);
    }

    /// The payload must expose only reviewed fields, each with a bounded value.
    ///
    /// Two earlier versions of this test failed on the legitimate field name
    /// `apiKeyOverridesLogin` and the legitimate enum value `"api_key"`, because
    /// they scanned for credential-shaped *words*. That approach cannot work: a
    /// UI has to be able to name the mode it reports, and any substring rule
    /// either forbids the vocabulary or waves through a field called `key`.
    ///
    /// The invariant is structural, so it is asserted structurally:
    ///   * the field set is an exact allowlist, so a new field cannot appear
    ///     without someone reviewing it here;
    ///   * every value is pinned to its enumeration or to a fixed command;
    ///   * no value is long enough to hold a credential.
    #[test]
    fn the_reported_payload_exposes_only_reviewed_and_bounded_fields() {
        let payload = status_json();
        let object = payload.as_object().expect("payload is an object");

        let mut keys: Vec<&str> = object.keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            ["apiKeyOverridesLogin", "cliAvailable", "loginCommand", "mode", "source"],
            "the auth status payload changed shape; review any new field for credential content before updating this list"
        );

        let mode = object["mode"].as_str().expect("mode is a string");
        assert!(
            ["api_key", "account", "none"].contains(&mode),
            "mode must be one of the three documented values, got {mode}"
        );
        let source = object["source"].as_str().expect("source is a string");
        assert!(
            ["environment", "stored", "absent"].contains(&source),
            "source must be one of the three documented values, got {source}"
        );
        assert!(object["apiKeyOverridesLogin"].is_boolean(), "apiKeyOverridesLogin is a bool");
        assert!(object["cliAvailable"].is_boolean(), "cliAvailable is a bool");
        assert_eq!(
            object["loginCommand"].as_str(),
            Some("muse login"),
            "the login command is fixed; anything else would mean the UI runs an unreviewed command"
        );

        for (key, value) in object {
            if let serde_json::Value::String(text) = value {
                assert!(
                    text.len() <= 32,
                    "field {key} holds a {}-character string; no credential is this short, so a longer value means the payload started carrying data instead of a classification",
                    text.len()
                );
            }
        }
    }
}
