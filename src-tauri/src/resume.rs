//! Validate durable identity before attaching an existing session.
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

pub fn params(session_id: &str, command_id: String) -> Value {
    json!({"sessionId":session_id,"commandId":command_id,"excludeItems":true})
}

pub fn validate(session: &Value, expected_id: &str, root: &Path) -> Result<(), String> {
    if session.get("sessionId").and_then(Value::as_str) != Some(expected_id) {
        return Err("the engine returned a different conversation".into());
    }
    if session
        .get("path")
        .and_then(Value::as_str)
        .filter(|p| !p.is_empty())
        .is_none()
    {
        return Err("this conversation has no durable history and cannot be reconnected".into());
    }
    let workspace = session
        .get("workspaceRoot")
        .and_then(Value::as_str)
        .ok_or("the saved conversation has no workspace")?;
    let path = host_path(workspace);
    let canonical = path
        .canonicalize()
        .map_err(|_| "the saved workspace is unavailable")?;
    if canonical != root {
        return Err("the saved conversation belongs to a different workspace".into());
    }
    Ok(())
}

pub(crate) fn host_path(raw: &str) -> PathBuf {
    // The bundled Windows adapter uses WSL's default drive mounts. Fail closed
    // for custom mounts rather than guessing a different workspace.
    #[cfg(windows)]
    if let Some(rest) = raw.strip_prefix("/mnt/") {
        let bytes = rest.as_bytes();
        if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b'/' {
            return PathBuf::from(format!(
                "{}:\\{}",
                bytes[0] as char,
                rest[2..].replace('/', "\\")
            ));
        }
    }
    PathBuf::from(raw)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validates_identity_durability_and_workspace_before_resume() {
        let root = std::env::current_dir().unwrap().canonicalize().unwrap();
        let good = json!({"sessionId":"a","path":"durable.jsonl","workspaceRoot":root});
        assert!(validate(&good, "a", &root).is_ok());
        assert!(validate(&good, "b", &root).is_err());
        let mut ephemeral = good.clone();
        ephemeral["path"] = json!("");
        assert!(validate(&ephemeral, "a", &root).is_err());
        let mut wrong = good.clone();
        wrong["workspaceRoot"] = json!(root.parent().unwrap());
        assert!(validate(&wrong, "a", &root).is_err());
        let mut missing = good;
        missing["workspaceRoot"] = Value::Null;
        assert!(validate(&missing, "a", &root).is_err());
    }
    #[test]
    fn resume_preserves_id_and_requests_metadata_without_replaying_local_history() {
        let p = params("saved", "command".into());
        assert_eq!(
            p,
            json!({"sessionId":"saved","commandId":"command","excludeItems":true})
        );
    }
}
