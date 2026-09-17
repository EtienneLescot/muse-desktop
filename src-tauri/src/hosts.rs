//! Workspace-owned clients and explicit session ownership. No default-host fallback.
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::Arc,
};

pub struct Hosts<T> {
    clients: HashMap<PathBuf, Arc<T>>,
    sessions: HashMap<String, (PathBuf, Arc<T>)>,
}

impl<T> Default for Hosts<T> {
    fn default() -> Self {
        Self {
            clients: HashMap::new(),
            sessions: HashMap::new(),
        }
    }
}

impl<T> Hosts<T> {
    pub fn client_count(&self) -> usize {
        self.clients.len()
    }

    pub fn session_count(&self) -> usize {
        self.sessions.len()
    }

    pub fn workspace(&self, root: &Path) -> Option<Arc<T>> {
        self.clients.get(root).cloned()
    }
    pub fn insert(&mut self, root: PathBuf, client: Arc<T>) {
        self.clients.insert(root, client);
    }
    pub fn bind(&mut self, sid: &str, root: &Path, client: &Arc<T>) -> Result<(), String> {
        if !self
            .clients
            .get(root)
            .is_some_and(|current| Arc::ptr_eq(current, client))
        {
            return Err("workspace engine is no longer available".into());
        }
        if let Some((_, owner)) = self.sessions.get(sid) {
            if !Arc::ptr_eq(owner, client) {
                return Err("session belongs to another engine".into());
            }
        }
        self.sessions
            .insert(sid.into(), (root.into(), client.clone()));
        Ok(())
    }
    pub fn session(&self, sid: &str) -> Result<Arc<T>, String> {
        self.sessions
            .get(sid)
            .map(|(_, c)| c.clone())
            .ok_or_else(|| {
                "conversation engine is unavailable — start or restore the conversation first"
                    .into()
            })
    }
    pub fn session_workspace(&self, sid: &str) -> Result<PathBuf, String> {
        self.sessions
            .get(sid)
            .map(|(root, _)| root.clone())
            .ok_or_else(|| "conversation workspace is unavailable".into())
    }
    pub fn owns(&self, sid: &str, client: &Arc<T>) -> bool {
        self.sessions
            .get(sid)
            .is_some_and(|(_, owner)| Arc::ptr_eq(owner, client))
    }
    pub fn forget(&mut self, sid: &str) {
        self.sessions.remove(sid);
    }
    pub fn snapshot(&self) -> Vec<(PathBuf, Arc<T>)> {
        self.clients
            .iter()
            .map(|(p, c)| (p.clone(), c.clone()))
            .collect()
    }
    pub fn remove(&mut self, client: &Arc<T>) -> Vec<String> {
        self.clients.retain(|_, c| !Arc::ptr_eq(c, client));
        let ids = self
            .sessions
            .iter()
            .filter(|(_, (_, c))| Arc::ptr_eq(c, client))
            .map(|(sid, _)| sid.clone())
            .collect::<Vec<_>>();
        for sid in &ids {
            self.sessions.remove(sid);
        }
        ids
    }
    pub fn drain(&mut self) -> Vec<Arc<T>> {
        self.sessions.clear();
        self.clients.drain().map(|(_, c)| c).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn two_workspaces_keep_their_clients_and_session_routes() {
        let mut hosts = Hosts::default();
        let a = Arc::new(1);
        let b = Arc::new(2);
        hosts.insert("a".into(), a.clone());
        hosts.bind("a1", Path::new("a"), &a).unwrap();
        hosts.insert("b".into(), b.clone());
        hosts.bind("b1", Path::new("b"), &b).unwrap();
        hosts.bind("a2", Path::new("a"), &a).unwrap();
        assert!(Arc::ptr_eq(&hosts.session("a1").unwrap(), &a));
        assert!(Arc::ptr_eq(&hosts.session("b1").unwrap(), &b));
        assert!(Arc::ptr_eq(&hosts.session("a2").unwrap(), &a));
        assert!(hosts.session("unknown").is_err());
        assert_eq!(hosts.session_workspace("a1").unwrap(), PathBuf::from("a"));
        assert_eq!(hosts.session_workspace("b1").unwrap(), PathBuf::from("b"));
        assert!(hosts.bind("a1", Path::new("b"), &b).is_err());
        assert!(!hosts.owns("a1", &b));
    }
    #[test]
    fn death_and_late_exit_cannot_remove_another_host_or_replacement() {
        let mut hosts = Hosts::default();
        let a = Arc::new(1);
        let b = Arc::new(2);
        hosts.insert("a".into(), a.clone());
        hosts.bind("a1", Path::new("a"), &a).unwrap();
        hosts.insert("b".into(), b.clone());
        hosts.bind("b1", Path::new("b"), &b).unwrap();
        assert_eq!(hosts.remove(&a), vec!["a1"]);
        assert!(hosts.session("a1").is_err());
        assert!(hosts.owns("b1", &b));
        let replacement = Arc::new(3);
        hosts.insert("a".into(), replacement.clone());
        assert!(hosts.remove(&a).is_empty());
        assert!(hosts.bind("late", Path::new("a"), &a).is_err());
        assert!(Arc::ptr_eq(
            &hosts.workspace(Path::new("a")).unwrap(),
            &replacement
        ));
    }
    #[test]
    fn deleting_one_session_keeps_others_and_exit_drains_every_host() {
        let mut hosts = Hosts::default();
        let a = Arc::new(1);
        let b = Arc::new(2);
        hosts.insert("a".into(), a.clone());
        hosts.bind("a1", Path::new("a"), &a).unwrap();
        hosts.bind("a2", Path::new("a"), &a).unwrap();
        hosts.insert("b".into(), b);
        hosts.forget("a1");
        assert!(hosts.session("a1").is_err());
        assert!(hosts.owns("a2", &a));
        assert_eq!(hosts.drain().len(), 2);
        assert!(hosts.snapshot().is_empty());
        assert!(hosts.session("a2").is_err());
    }
}
