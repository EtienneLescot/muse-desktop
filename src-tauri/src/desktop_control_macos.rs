//! macOS backend for `desktop_control`.
//!
//! The Accessibility tree is read and driven through System Events with a
//! single JavaScript for Automation script run by `/usr/bin/osascript`. Every
//! user-controlled value (window id, text, coordinates) travels as an argv
//! entry, never interpolated into script source. macOS gates all of this
//! behind the Accessibility (and, for System Events, Automation) privacy
//! prompts; a refusal is surfaced as a structured, actionable error.
//!
//! Window ids are `<pid>:<index>` — the owning process and the window's
//! position in that process's Accessibility window list. Unlike an HWND the
//! index can shift when the app opens or closes windows, so the renderer's
//! existing "refresh before acting" flow is what keeps it accurate.

use super::{
    looks_sensitive, DesktopBounds, DesktopElement, DesktopKey, DesktopWindow, MAX_ELEMENTS,
    MAX_TEXT_CHARS, MAX_WINDOWS,
};
use serde::Deserialize;
use std::io::Read;
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

const OSASCRIPT: &str = "/usr/bin/osascript";
const LIST_TIMEOUT: Duration = Duration::from_secs(20);
const ACTION_TIMEOUT: Duration = Duration::from_secs(8);

const SCRIPT: &str = r#"
function run(argv) {
  const se = Application('System Events');
  const action = argv[0];
  const MAX_WINDOWS = Number(argv[1]);
  const MAX_ELEMENTS = Number(argv[1]);

  function target(id) {
    const m = /^(\d{1,10}):(\d{1,5})$/.exec(id || '');
    if (!m) throw new Error('MUSE:invalid desktop window id');
    const procs = se.processes.whose({ unixId: Number(m[1]) })();
    if (!procs.length) throw new Error('MUSE:that window is no longer available');
    const p = procs[0];
    const ws = p.windows();
    const index = Number(m[2]);
    if (index >= ws.length) throw new Error('MUSE:that window is no longer available');
    return { p: p, w: ws[index] };
  }
  function rect(w) {
    const pos = w.position();
    const size = w.size();
    return { x: Math.round(pos[0]), y: Math.round(pos[1]), width: Math.round(size[0]), height: Math.round(size[1]) };
  }
  function focus(t) {
    t.p.frontmost = true;
    try { t.w.actions.byName('AXRaise').perform(); } catch (e) {}
    delay(0.05);
  }

  if (action === 'windows') {
    const rows = [];
    const procs = se.processes.whose({ backgroundOnly: false })();
    for (const p of procs) {
      if (rows.length >= MAX_WINDOWS) break;
      let pid, ws;
      try { pid = p.unixId(); ws = p.windows(); } catch (e) { continue; }
      for (let i = 0; i < ws.length && rows.length < MAX_WINDOWS; i++) {
        try {
          const title = String(ws[i].name() || '').trim();
          const b = rect(ws[i]);
          if (!title || b.width <= 0 || b.height <= 0) continue;
          rows.push({ id: pid + ':' + i, title: title, bounds: b });
        } catch (e) {}
      }
    }
    return JSON.stringify(rows);
  }

  if (action === 'elements') {
    const t = target(argv[2]);
    const root = rect(t.w);
    const rows = [];
    const walk = (el, depth) => {
      if (rows.length >= MAX_ELEMENTS || depth > 32) return;
      let children;
      try { children = el.uiElements(); } catch (e) { return; }
      for (const child of children) {
        if (rows.length >= MAX_ELEMENTS) return;
        let props;
        try { props = child.properties(); } catch (e) { continue; }
        const pos = props.position, size = props.size;
        if (pos && size && size[0] > 0 && size[1] > 0) {
          let value = props.value;
          if (value === null || value === undefined) value = '';
          else if (typeof value === 'boolean') value = value ? 'on' : 'off';
          else if (typeof value === 'number') value = String(value);
          else if (typeof value !== 'string') value = '';
          const x = Math.round(pos[0]) - root.x, y = Math.round(pos[1]) - root.y;
          const w = Math.round(size[0]), h = Math.round(size[1]);
          rows.push({
            index: rows.length,
            title: String(props.name || props.title || props.description || ''),
            className: String(props.class || ''),
            role: String(props.roleDescription || props.role || ''),
            subrole: String(props.subrole || ''),
            identifier: '',
            value: value,
            enabled: props.enabled !== false,
            offscreen: x + w <= 0 || y + h <= 0 || x >= root.width || y >= root.height,
            bounds: { x: x, y: y, width: w, height: h },
          });
        }
        walk(child, depth + 1);
      }
    };
    walk(t.w, 0);
    return JSON.stringify(rows);
  }

  if (action === 'focus') {
    focus(target(argv[2]));
    return 'null';
  }

  if (action === 'text') {
    focus(target(argv[2]));
    se.keystroke(argv[3]);
    return 'null';
  }

  if (action === 'key') {
    focus(target(argv[2]));
    se.keyCode(Number(argv[3]));
    return 'null';
  }

  if (action === 'click') {
    const t = target(argv[2]);
    const b = rect(t.w);
    const x = Number(argv[3]), y = Number(argv[4]);
    if (!(x >= 0 && y >= 0 && x < b.width && y < b.height))
      throw new Error('MUSE:click coordinates must stay inside the selected window');
    focus(t);
    se.click({ at: [b.x + x, b.y + y] });
    return 'null';
  }

  throw new Error('MUSE:unknown desktop action');
}
"#;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawElement {
    index: usize,
    title: String,
    class_name: String,
    role: String,
    subrole: String,
    identifier: String,
    value: String,
    enabled: bool,
    offscreen: bool,
    bounds: DesktopBounds,
}

#[derive(Deserialize)]
struct RawWindow {
    id: String,
    title: String,
    bounds: DesktopBounds,
}

fn clean(value: &str, max: usize) -> String {
    value
        .chars()
        .map(|character| {
            if character.is_control()
                || matches!(
                    character,
                    '\u{fffd}' | '\u{200b}' | '\u{200c}' | '\u{200d}' | '\u{2060}' | '\u{feff}'
                )
            {
                ' '
            } else {
                character
            }
        })
        .collect::<String>()
        .trim()
        .chars()
        .take(max)
        .collect()
}

/// Map osascript failures to the product error copy. The script tags its own
/// validation errors with `MUSE:`; everything else is a platform refusal.
fn script_error(stderr: &str) -> String {
    if let Some(start) = stderr.find("MUSE:") {
        let message = &stderr[start + 5..];
        let end = message
            .find(|c: char| c == '(' || c == '\n')
            .unwrap_or(message.len());
        return message[..end].trim().trim_end_matches('.').to_string();
    }
    let lower = stderr.to_ascii_lowercase();
    if lower.contains("-1719")
        || lower.contains("-25211")
        || lower.contains("assistive access")
        || lower.contains("not allowed assistive")
    {
        return "macOS denied Accessibility access. Allow Muse-Desktop in System Settings › Privacy & Security › Accessibility, then retry".to_string();
    }
    if lower.contains("-1743") || lower.contains("not authorized to send apple events") {
        return "macOS denied Automation access to System Events. Allow Muse-Desktop in System Settings › Privacy & Security › Automation, then retry".to_string();
    }
    let detail = clean(stderr, 180);
    if detail.is_empty() {
        "macOS desktop control failed".to_string()
    } else {
        format!("macOS desktop control failed: {detail}")
    }
}

fn run(args: &[&str], timeout: Duration) -> Result<String, String> {
    let mut child = Command::new(OSASCRIPT)
        .args(["-l", "JavaScript", "-e", SCRIPT])
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("cannot run osascript: {error}"))?;
    // Drain both pipes on threads so a large element tree cannot fill a pipe
    // while this thread waits on the child.
    let mut stdout = child.stdout.take().expect("piped stdout");
    let mut stderr = child.stderr.take().expect("piped stderr");
    let out = thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = stdout.read_to_end(&mut bytes);
        bytes
    });
    let err = thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = stderr.read_to_end(&mut bytes);
        bytes
    });
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if started.elapsed() < timeout => thread::sleep(Duration::from_millis(20)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("macOS desktop control timed out".to_string());
            }
            Err(error) => return Err(format!("macOS desktop control failed: {error}")),
        }
    };
    let stdout = String::from_utf8_lossy(&out.join().unwrap_or_default()).into_owned();
    let stderr = String::from_utf8_lossy(&err.join().unwrap_or_default()).into_owned();
    if !status.success() {
        return Err(script_error(&stderr));
    }
    Ok(stdout.trim().to_string())
}

fn validate_id(id: &str) -> Result<&str, String> {
    let id = id.trim();
    let valid = id.len() <= 20
        && id
            .split_once(':')
            .map(|(pid, index)| {
                !pid.is_empty()
                    && !index.is_empty()
                    && pid.bytes().all(|b| b.is_ascii_digit())
                    && index.bytes().all(|b| b.is_ascii_digit())
            })
            .unwrap_or(false);
    if valid {
        Ok(id)
    } else {
        Err("invalid desktop window id".to_string())
    }
}

pub fn windows() -> Result<Vec<DesktopWindow>, String> {
    let limit = MAX_WINDOWS.to_string();
    let raw = run(&["windows", &limit], LIST_TIMEOUT)?;
    let rows: Vec<RawWindow> =
        serde_json::from_str(&raw).map_err(|_| "macOS returned an unreadable window list")?;
    Ok(rows
        .into_iter()
        .take(MAX_WINDOWS)
        .map(|row| DesktopWindow {
            id: row.id,
            title: clean(&row.title, 240),
            bounds: row.bounds,
        })
        .collect())
}

fn element_from(raw: RawElement) -> DesktopElement {
    let title = clean(&raw.title, 240);
    let class_name = clean(&raw.class_name, 100);
    let semantic_role = clean(&raw.role, 80);
    let automation_id = clean(&raw.identifier, 120);
    let value_redacted = raw.subrole == "AXSecureTextField"
        || looks_sensitive(&title, &class_name, &semantic_role, &automation_id);
    DesktopElement {
        id: format!("ax:{}", raw.index),
        title,
        class_name,
        semantic_role,
        automation_id,
        value: if value_redacted {
            String::new()
        } else {
            clean(&raw.value, 500)
        },
        value_redacted,
        bounds: raw.bounds,
        enabled: raw.enabled,
        visible: !raw.offscreen,
        offscreen: raw.offscreen,
    }
}

pub fn elements(id: &str) -> Result<Vec<DesktopElement>, String> {
    let id = validate_id(id)?;
    let limit = MAX_ELEMENTS.to_string();
    let raw = run(&["elements", &limit, id], LIST_TIMEOUT)?;
    let rows: Vec<RawElement> =
        serde_json::from_str(&raw).map_err(|_| "macOS returned an unreadable control tree")?;
    Ok(rows
        .into_iter()
        .take(MAX_ELEMENTS)
        .map(element_from)
        .collect())
}

pub fn focus(id: &str) -> Result<(), String> {
    let id = validate_id(id)?;
    run(&["focus", "0", id], ACTION_TIMEOUT).map(|_| ())
}

pub fn send_text(id: &str, text: &str) -> Result<usize, String> {
    let id = validate_id(id)?;
    if text.encode_utf16().count() > MAX_TEXT_CHARS {
        return Err(format!(
            "desktop text is limited to {MAX_TEXT_CHARS} UTF-16 code units"
        ));
    }
    run(&["text", "0", id, text], ACTION_TIMEOUT)?;
    Ok(text.chars().count())
}

fn key_code(key: DesktopKey) -> u16 {
    // Carbon virtual key codes (HIToolbox/Events.h).
    match key {
        DesktopKey::Enter => 36,
        DesktopKey::Escape => 53,
        DesktopKey::Tab => 48,
        DesktopKey::Backspace => 51,
        DesktopKey::Space => 49,
        DesktopKey::ArrowUp => 126,
        DesktopKey::ArrowDown => 125,
        DesktopKey::ArrowLeft => 123,
        DesktopKey::ArrowRight => 124,
    }
}

pub fn press_key(id: &str, key: DesktopKey) -> Result<(), String> {
    let id = validate_id(id)?;
    let code = key_code(key).to_string();
    run(&["key", "0", id, &code], ACTION_TIMEOUT).map(|_| ())
}

pub fn click(id: &str, x: i32, y: i32) -> Result<(), String> {
    let id = validate_id(id)?;
    if x < 0 || y < 0 {
        return Err("click coordinates must stay inside the selected window".to_string());
    }
    let (x, y) = (x.to_string(), y.to_string());
    run(&["click", "0", id, &x, &y], ACTION_TIMEOUT).map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn window_ids_are_strict() {
        assert!(validate_id("123:0").is_ok());
        assert!(validate_id(" 42:3 ").is_ok());
        for bad in ["", "abc", "1:", ":1", "1:2:3", "1;x", "-1:0", "0x1f"] {
            assert!(validate_id(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn script_errors_are_actionable() {
        assert_eq!(
            script_error("execution error: Error: MUSE:that window is no longer available (-2700)"),
            "that window is no longer available"
        );
        assert!(script_error("System Events got an error: osascript is not allowed assistive access. (-1719)")
            .contains("Accessibility"));
        assert!(script_error("Not authorized to send Apple events to System Events. (-1743)")
            .contains("Automation"));
    }

    #[test]
    fn secure_fields_are_redacted() {
        let element = element_from(RawElement {
            index: 0,
            title: "Account".into(),
            class_name: "text field".into(),
            role: "text field".into(),
            subrole: "AXSecureTextField".into(),
            identifier: String::new(),
            value: "hunter2".into(),
            enabled: true,
            offscreen: false,
            bounds: DesktopBounds { x: 0, y: 0, width: 10, height: 10 },
        });
        assert!(element.value_redacted);
        assert!(element.value.is_empty());
    }
}
