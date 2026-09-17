//! Persistent, workspace-scoped PTY sessions for the Terminal panel.
//!
//! A terminal is owned by a conversation workspace and lives in the supervisor
//! registry rather than in the React panel.  Unmounting or changing work tabs
//! therefore never kills the shell.  Output is drained by an explicit command
//! so the transport has the same reliable `invoke` semantics as the rest of
//! the app, with a bounded tail to prevent an unattended process from growing
//! memory without limit.

use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::{HashMap, VecDeque};
use std::io::{Read, Write};
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::thread;
use uuid::Uuid;

const MAX_OUTPUT_CHARS: usize = 200_000;
const MIN_COLS: u16 = 20;
const MAX_COLS: u16 = 400;
const MIN_ROWS: u16 = 4;
const MAX_ROWS: u16 = 200;

#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TerminalInfo {
    pub terminal_id: String,
    pub session_id: String,
    pub cwd: String,
    pub shell: String,
    pub generation: u64,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TerminalRead {
    pub terminal_id: String,
    pub output: String,
    pub done: bool,
}

#[derive(Debug, Default)]
struct OutputBuffer {
    chunks: VecDeque<String>,
    chars: usize,
    done: bool,
}

impl OutputBuffer {
    fn append(&mut self, text: String) {
        if text.is_empty() {
            return;
        }
        self.chars += text.chars().count();
        self.chunks.push_back(text);
        while self.chars > MAX_OUTPUT_CHARS {
            let Some(front) = self.chunks.pop_front() else {
                break;
            };
            let excess = self.chars.saturating_sub(MAX_OUTPUT_CHARS);
            let skip = excess.min(front.chars().count());
            let clipped: String = front.chars().skip(skip).collect();
            self.chars = self.chars.saturating_sub(front.chars().count());
            if !clipped.is_empty() {
                self.chars += clipped.chars().count();
                self.chunks.push_front(clipped);
            }
        }
    }

    fn drain(&mut self, terminal_id: &str) -> TerminalRead {
        let mut output = String::new();
        for chunk in self.chunks.drain(..) {
            output.push_str(&chunk);
        }
        self.chars = 0;
        TerminalRead {
            terminal_id: terminal_id.to_string(),
            output,
            done: self.done,
        }
    }
}

struct TerminalHandle {
    info: TerminalInfo,
    master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    child: Arc<Mutex<Box<dyn portable_pty::Child + Send + Sync>>>,
    output: Arc<Mutex<OutputBuffer>>,
}

impl TerminalHandle {
    fn close(&self) {
        if let Ok(mut child) = self.child.lock() {
            let _ = child.kill();
            let _ = child.wait();
        }
        // Dropping the writer and master is what closes the PTY handles; the
        // reader thread then observes EOF and exits on its own.
    }
}

#[derive(Default)]
pub struct TerminalRegistry {
    terminals: Mutex<HashMap<String, Arc<TerminalHandle>>>,
    by_session: Mutex<HashMap<String, String>>,
    next_generation: Mutex<u64>,
}

impl TerminalRegistry {
    pub fn open(
        &self,
        session_id: &str,
        cwd: &Path,
        cols: Option<u16>,
        rows: Option<u16>,
    ) -> Result<TerminalInfo, String> {
        if session_id.trim().is_empty() {
            return Err("sessionId must not be empty".to_string());
        }
        if !cwd.is_dir() {
            return Err(format!(
                "terminal cwd is not a directory: {}",
                cwd.display()
            ));
        }
        if let Some(existing_id) = self
            .by_session
            .lock()
            .map_err(|e| format!("terminal state lock: {e}"))?
            .get(session_id)
            .cloned()
        {
            if let Some(existing) = self
                .terminals
                .lock()
                .map_err(|e| format!("terminal state lock: {e}"))?
                .get(&existing_id)
                .cloned()
            {
                return Ok(existing.info.clone());
            }
        }

        let cols = clamp_cols(cols.unwrap_or(100));
        let rows = clamp_rows(rows.unwrap_or(28));
        let shell = default_shell();
        let pty = native_pty_system();
        let pair = pty
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("open terminal: {e}"))?;
        let mut command = CommandBuilder::new(&shell);
        command.cwd(cwd);
        command.env("TERM", "xterm-256color");
        let mut child = pair
            .slave
            .spawn_command(command)
            .map_err(|e| format!("spawn terminal shell: {e}"))?;
        drop(pair.slave);
        let reader = match pair.master.try_clone_reader() {
            Ok(reader) => reader,
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("read terminal: {e}"));
            }
        };
        let writer = match pair.master.take_writer() {
            Ok(writer) => writer,
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("write terminal: {e}"));
            }
        };
        let master: Box<dyn MasterPty + Send> = pair.master;
        let output = Arc::new(Mutex::new(OutputBuffer::default()));
        let output_reader = Arc::clone(&output);
        if let Err(e) = thread::Builder::new()
            .name("muse-terminal-reader".to_string())
            .spawn(move || read_output(reader, output_reader))
        {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!("start terminal reader: {e}"));
        }

        let generation = {
            let mut next = self
                .next_generation
                .lock()
                .map_err(|e| format!("terminal state lock: {e}"))?;
            *next = next.saturating_add(1);
            *next
        };
        let terminal_id = format!("term-{}", Uuid::new_v4());
        let info = TerminalInfo {
            terminal_id: terminal_id.clone(),
            session_id: session_id.to_string(),
            cwd: cwd.display().to_string(),
            shell: shell.clone(),
            generation,
            cols,
            rows,
        };
        let handle = Arc::new(TerminalHandle {
            info: info.clone(),
            master: Arc::new(Mutex::new(master)),
            writer: Arc::new(Mutex::new(writer)),
            child: Arc::new(Mutex::new(child)),
            output,
        });
        self.terminals
            .lock()
            .map_err(|e| format!("terminal state lock: {e}"))?
            .insert(terminal_id.clone(), handle);
        self.by_session
            .lock()
            .map_err(|e| format!("terminal state lock: {e}"))?
            .insert(session_id.to_string(), terminal_id);
        Ok(info)
    }

    pub fn write(&self, terminal_id: &str, input: &str) -> Result<(), String> {
        if input.is_empty() {
            return Ok(());
        }
        let terminal = self.get(terminal_id)?;
        let mut writer = terminal
            .writer
            .lock()
            .map_err(|e| format!("terminal writer lock: {e}"))?;
        writer
            .write_all(input.as_bytes())
            .and_then(|_| writer.flush())
            .map_err(|e| format!("write terminal input: {e}"))
    }

    pub fn resize(&self, terminal_id: &str, cols: u16, rows: u16) -> Result<TerminalInfo, String> {
        let terminal = self.get(terminal_id)?;
        let cols = clamp_cols(cols);
        let rows = clamp_rows(rows);
        terminal
            .master
            .lock()
            .map_err(|e| format!("terminal master lock: {e}"))?
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("resize terminal: {e}"))?;
        let mut info = terminal.info.clone();
        info.cols = cols;
        info.rows = rows;
        Ok(info)
    }

    pub fn read(&self, terminal_id: &str) -> Result<TerminalRead, String> {
        let terminal = self.get(terminal_id)?;
        terminal
            .output
            .lock()
            .map_err(|e| format!("terminal output lock: {e}"))
            .map(|mut output| output.drain(terminal_id))
    }

    pub fn close(&self, terminal_id: &str) -> Result<(), String> {
        let terminal = self
            .terminals
            .lock()
            .map_err(|e| format!("terminal state lock: {e}"))?
            .remove(terminal_id)
            .ok_or_else(|| format!("unknown terminal: {terminal_id}"))?;
        if let Ok(mut sessions) = self.by_session.lock() {
            sessions.retain(|_, id| id != terminal_id);
        }
        terminal.close();
        Ok(())
    }

    pub fn close_all(&self) {
        let terminals = self
            .terminals
            .lock()
            .map(|mut terminals| terminals.drain().map(|(_, t)| t).collect::<Vec<_>>())
            .unwrap_or_default();
        if let Ok(mut sessions) = self.by_session.lock() {
            sessions.clear();
        }
        for terminal in terminals {
            terminal.close();
        }
    }

    fn get(&self, terminal_id: &str) -> Result<Arc<TerminalHandle>, String> {
        if terminal_id.trim().is_empty() {
            return Err("terminalId must not be empty".to_string());
        }
        self.terminals
            .lock()
            .map_err(|e| format!("terminal state lock: {e}"))?
            .get(terminal_id)
            .cloned()
            .ok_or_else(|| format!("unknown terminal: {terminal_id}"))
    }
}

fn read_output(mut reader: Box<dyn Read + Send>, output: Arc<Mutex<OutputBuffer>>) {
    let mut bytes = [0u8; 8192];
    loop {
        match reader.read(&mut bytes) {
            Ok(0) => break,
            Ok(n) => {
                let text = String::from_utf8_lossy(&bytes[..n]).into_owned();
                if let Ok(mut buffer) = output.lock() {
                    buffer.append(text);
                } else {
                    break;
                }
            }
            Err(_) => break,
        }
    }
    if let Ok(mut buffer) = output.lock() {
        buffer.done = true;
    }
}

fn default_shell() -> String {
    #[cfg(windows)]
    {
        std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".to_string())
    }
    #[cfg(not(windows))]
    {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string())
    }
}

fn clamp_cols(cols: u16) -> u16 {
    cols.clamp(MIN_COLS, MAX_COLS)
}

fn clamp_rows(rows: u16) -> u16 {
    rows.clamp(MIN_ROWS, MAX_ROWS)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn terminal_size_is_bounded() {
        assert_eq!(clamp_cols(1), MIN_COLS);
        assert_eq!(clamp_cols(u16::MAX), MAX_COLS);
        assert_eq!(clamp_rows(0), MIN_ROWS);
        assert_eq!(clamp_rows(u16::MAX), MAX_ROWS);
    }

    #[test]
    fn output_tail_stays_bounded_and_drains() {
        let mut buffer = OutputBuffer::default();
        buffer.append("é".repeat(MAX_OUTPUT_CHARS + 10));
        assert!(buffer.chars <= MAX_OUTPUT_CHARS);
        let read = buffer.drain("term-1");
        assert_eq!(read.terminal_id, "term-1");
        assert!(read.output.chars().count() <= MAX_OUTPUT_CHARS);
        assert!(buffer.chunks.is_empty());
    }
}
