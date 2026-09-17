//! Bounded native workspace change notifications for the Files panel.
//!
//! The watcher never reads file contents and never executes a command. It
//! only reports relative paths that remain inside the canonical workspace;
//! the renderer decides when to request a fresh bounded listing or preview.

use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::path::Path;

const MAX_CHANGED_PATHS: usize = 20;

#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceChange {
    pub kind: String,
    pub paths: Vec<String>,
}

/// Own one watcher registration. Dropping it unregisters the callback and
/// stops native notifications for that session.
pub struct WorkspaceWatcher {
    _watcher: RecommendedWatcher,
}

impl WorkspaceWatcher {
    pub fn start<F>(root: &Path, mut callback: F) -> Result<Self, String>
    where
        F: FnMut(Result<WorkspaceChange, String>) + Send + 'static,
    {
        let callback_root = root.to_path_buf();
        let mut watcher = notify::recommended_watcher(move |result: notify::Result<Event>| {
            let change = result
                .map_err(|error| format!("workspace watcher failed: {error}"))
                .and_then(|event| summarize_event(&callback_root, event));
            if let Ok(Some(change)) = change {
                callback(Ok(change));
            } else if let Err(error) = change {
                callback(Err(error));
            }
        })
        .map_err(|error| format!("could not start workspace watcher: {error}"))?;
        watcher
            .watch(root, RecursiveMode::Recursive)
            .map_err(|error| format!("could not watch workspace: {error}"))?;
        Ok(Self { _watcher: watcher })
    }
}

/// Convert a notify event into a small renderer payload. Access events are
/// deliberately ignored: reading a file should not make the Files panel
/// claim that the workspace changed.
pub fn summarize_event(root: &Path, event: Event) -> Result<Option<WorkspaceChange>, String> {
    if matches!(event.kind, EventKind::Access(_)) {
        return Ok(None);
    }
    let kind = match event.kind {
        EventKind::Create(_) => "created",
        EventKind::Modify(_) => "modified",
        EventKind::Remove(_) => "removed",
        EventKind::Any | EventKind::Other => "changed",
        EventKind::Access(_) => return Ok(None),
    };
    let mut paths = Vec::new();
    for path in event.paths {
        let relative = path
            .strip_prefix(root)
            .map_err(|_| "workspace watcher reported a path outside its root".to_string())?;
        let text = relative.to_string_lossy().replace('\\', "/");
        if text.is_empty() || paths.iter().any(|item| item == &text) {
            continue;
        }
        paths.push(text);
        if paths.len() >= MAX_CHANGED_PATHS {
            break;
        }
    }
    if paths.is_empty() {
        return Ok(None);
    }
    Ok(Some(WorkspaceChange {
        kind: kind.to_string(),
        paths,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn root() -> PathBuf {
        if cfg!(windows) {
            PathBuf::from(r"C:\workspace")
        } else {
            PathBuf::from("/workspace")
        }
    }

    #[test]
    fn summarizes_relative_paths_and_bounds_duplicates() {
        let root = root();
        let event = Event {
            kind: EventKind::Modify(notify::event::ModifyKind::Any),
            paths: vec![root.join("src/main.ts"), root.join("src/main.ts")],
            attrs: Default::default(),
        };
        let change = summarize_event(&root, event).unwrap().unwrap();
        assert_eq!(change.kind, "modified");
        assert_eq!(change.paths, vec!["src/main.ts"]);
    }

    #[test]
    fn ignores_access_and_rejects_paths_outside_root() {
        let root = root();
        let access = Event {
            kind: EventKind::Access(notify::event::AccessKind::Any),
            paths: vec![root.join("src/main.ts")],
            attrs: Default::default(),
        };
        assert!(summarize_event(&root, access).unwrap().is_none());
        let outside = Event {
            kind: EventKind::Remove(notify::event::RemoveKind::Any),
            paths: vec![PathBuf::from("/outside.txt")],
            attrs: Default::default(),
        };
        assert!(summarize_event(&root, outside).is_err());
    }
}
