//! Explicit, bounded desktop-control primitives for the native shell.
//!
//! This module deliberately contains no agentic policy. The renderer must
//! present the capability as denied until the user enables it, and every
//! mutating action is a direct, user-visible gesture. Windows is the first
//! supported runtime; other platforms return a structured unsupported error
//! so the UI cannot imply parity that is not present.

use serde::Serialize;

pub const MAX_TEXT_CHARS: usize = 2_000;
pub const MAX_WINDOWS: usize = 200;
pub const MAX_ELEMENTS: usize = 300;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DesktopControlStatus {
    pub supported: bool,
    pub platform: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DesktopWindow {
    pub id: String,
    pub title: String,
    pub bounds: DesktopBounds,
}

/// A bounded, read-only snapshot of a visible child control. Bounds are
/// relative to the selected top-level window so the renderer can reason about
/// the surface without exposing process handles or document contents.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DesktopElement {
    pub id: String,
    pub title: String,
    pub class_name: String,
    pub bounds: DesktopBounds,
    pub enabled: bool,
    pub visible: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct DesktopBounds {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DesktopKey {
    Enter,
    Escape,
    Tab,
    Backspace,
    Space,
    ArrowUp,
    ArrowDown,
    ArrowLeft,
    ArrowRight,
}

impl DesktopKey {
    pub fn parse(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "enter" | "return" => Some(Self::Enter),
            "escape" | "esc" => Some(Self::Escape),
            "tab" => Some(Self::Tab),
            "backspace" | "back" => Some(Self::Backspace),
            "space" => Some(Self::Space),
            "arrowup" | "up" => Some(Self::ArrowUp),
            "arrowdown" | "down" => Some(Self::ArrowDown),
            "arrowleft" | "left" => Some(Self::ArrowLeft),
            "arrowright" | "right" => Some(Self::ArrowRight),
            _ => None,
        }
    }
}

pub fn status() -> DesktopControlStatus {
    #[cfg(windows)]
    {
        DesktopControlStatus {
            supported: true,
            platform: "windows".to_string(),
            reason: "Windows desktop control is available after explicit consent".to_string(),
        }
    }

    #[cfg(not(windows))]
    {
        #[cfg(target_os = "macos")]
        let platform = "macos";
        #[cfg(target_os = "linux")]
        let platform = "linux";
        #[cfg(not(any(target_os = "macos", target_os = "linux")))]
        let platform = "unknown";
        DesktopControlStatus {
            supported: false,
            platform: platform.to_string(),
            reason: "Desktop control is not available on this platform yet".to_string(),
        }
    }
}

#[cfg(not(windows))]
fn unsupported() -> Result<(), String> {
    Err(status().reason)
}

#[cfg(not(windows))]
pub fn windows() -> Result<Vec<DesktopWindow>, String> {
    unsupported()?;
    unreachable!()
}

#[cfg(not(windows))]
pub fn elements(_id: &str) -> Result<Vec<DesktopElement>, String> {
    unsupported()?;
    unreachable!()
}

#[cfg(not(windows))]
pub fn focus(_id: &str) -> Result<(), String> {
    unsupported()
}

#[cfg(not(windows))]
pub fn send_text(_id: &str, _text: &str) -> Result<usize, String> {
    unsupported()?;
    unreachable!()
}

#[cfg(not(windows))]
pub fn press_key(_id: &str, _key: DesktopKey) -> Result<(), String> {
    unsupported()
}

#[cfg(not(windows))]
pub fn click(_id: &str, _x: i32, _y: i32) -> Result<(), String> {
    unsupported()
}

#[cfg(windows)]
mod windows_impl {
    use super::{DesktopBounds, DesktopElement, DesktopKey, DesktopWindow, MAX_ELEMENTS, MAX_TEXT_CHARS, MAX_WINDOWS};
    use std::mem::size_of;
    use windows_sys::Win32::Foundation::{BOOL, HWND, LPARAM, RECT, TRUE};
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, INPUT_MOUSE, KEYBDINPUT, KEYEVENTF_KEYUP,
        KEYEVENTF_UNICODE, MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP, MOUSEINPUT, VK_BACK, VK_DOWN,
        VK_ESCAPE, VK_LEFT, VK_RETURN, VK_RIGHT, VK_SPACE, VK_TAB, VK_UP,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        EnumChildWindows, EnumWindows, GetClassNameW, GetWindowLongW, GetWindowRect,
        GetWindowTextLengthW, GetWindowTextW, IsWindowVisible, SetCursorPos, SetForegroundWindow,
        GWL_STYLE, WS_DISABLED,
    };

    fn id_for(hwnd: HWND) -> String {
        format!("{:x}", hwnd as usize)
    }

    fn parse_hwnd(value: &str) -> Result<HWND, String> {
        let raw = value.trim();
        if raw.is_empty() || raw.len() > 32 {
            return Err("invalid desktop window id".to_string());
        }
        let number = usize::from_str_radix(raw.trim_start_matches("0x"), 16)
            .map_err(|_| "invalid desktop window id".to_string())?;
        if number == 0 {
            return Err("invalid desktop window id".to_string());
        }
        Ok(number as HWND)
    }

    fn title(hwnd: HWND) -> String {
        let length = unsafe { GetWindowTextLengthW(hwnd) };
        if length <= 0 {
            return String::new();
        }
        let mut buffer = vec![0u16; length as usize + 1];
        let copied = unsafe { GetWindowTextW(hwnd, buffer.as_mut_ptr(), buffer.len() as i32) };
        String::from_utf16_lossy(&buffer[..copied.max(0) as usize])
            .trim()
            .chars()
            .take(240)
            .collect()
    }

    fn class_name(hwnd: HWND) -> String {
        let mut buffer = vec![0u16; 128];
        let copied = unsafe { GetClassNameW(hwnd, buffer.as_mut_ptr(), buffer.len() as i32) };
        String::from_utf16_lossy(&buffer[..copied.max(0) as usize])
            .trim()
            .chars()
            .take(80)
            .collect()
    }

    fn bounds(hwnd: HWND) -> Option<DesktopBounds> {
        let mut rect = RECT {
            left: 0,
            top: 0,
            right: 0,
            bottom: 0,
        };
        if unsafe { GetWindowRect(hwnd, &mut rect) } == 0 {
            return None;
        }
        Some(DesktopBounds {
            x: rect.left,
            y: rect.top,
            width: (rect.right - rect.left).max(0),
            height: (rect.bottom - rect.top).max(0),
        })
    }

    unsafe extern "system" fn collect(hwnd: HWND, data: LPARAM) -> BOOL {
        if unsafe { IsWindowVisible(hwnd) } == 0 {
            return TRUE;
        }
        let title = title(hwnd);
        let Some(bounds) = bounds(hwnd) else {
            return TRUE;
        };
        if title.is_empty() || bounds.width <= 0 || bounds.height <= 0 {
            return TRUE;
        }
        let rows = unsafe { &mut *(data as *mut Vec<DesktopWindow>) };
        if rows.len() < MAX_WINDOWS {
            rows.push(DesktopWindow {
                id: id_for(hwnd),
                title,
                bounds,
            });
        }
        TRUE
    }

    pub fn windows() -> Result<Vec<DesktopWindow>, String> {
        let mut rows = Vec::with_capacity(32);
        let result = unsafe { EnumWindows(Some(collect), &mut rows as *mut _ as LPARAM) };
        if result == 0 {
            return Err("Windows could not enumerate desktop windows".to_string());
        }
        Ok(rows)
    }

    struct ElementContext {
        root: DesktopBounds,
        rows: Vec<DesktopElement>,
    }

    unsafe extern "system" fn collect_child(hwnd: HWND, data: LPARAM) -> BOOL {
        let context = unsafe { &mut *(data as *mut ElementContext) };
        if context.rows.len() >= MAX_ELEMENTS || unsafe { IsWindowVisible(hwnd) } == 0 {
            return TRUE;
        }
        let Some(screen_bounds) = bounds(hwnd) else {
            return TRUE;
        };
        if screen_bounds.width <= 0 || screen_bounds.height <= 0 {
            return TRUE;
        }
        let class_name = class_name(hwnd);
        let title = title(hwnd);
        if class_name.is_empty() && title.is_empty() {
            return TRUE;
        }
        context.rows.push(DesktopElement {
            id: id_for(hwnd),
            title,
            class_name,
            bounds: DesktopBounds {
                x: screen_bounds.x.saturating_sub(context.root.x),
                y: screen_bounds.y.saturating_sub(context.root.y),
                width: screen_bounds.width,
                height: screen_bounds.height,
            },
            enabled: unsafe { (GetWindowLongW(hwnd, GWL_STYLE) as u32 & WS_DISABLED) == 0 },
            visible: true,
        });
        TRUE
    }

    pub fn elements(id: &str) -> Result<Vec<DesktopElement>, String> {
        let hwnd = parse_hwnd(id)?;
        let Some(root) = bounds(hwnd) else {
            return Err("desktop window bounds are unavailable".to_string());
        };
        let mut context = ElementContext {
            root,
            rows: Vec::with_capacity(48),
        };
        let result = unsafe {
            EnumChildWindows(hwnd, Some(collect_child), &mut context as *mut _ as LPARAM)
        };
        if result == 0 {
            return Err("Windows could not enumerate child controls".to_string());
        }
        Ok(context.rows)
    }

    pub fn focus(id: &str) -> Result<HWND, String> {
        let hwnd = parse_hwnd(id)?;
        if unsafe { SetForegroundWindow(hwnd) } == 0 {
            return Err("Windows refused to focus that window".to_string());
        }
        Ok(hwnd)
    }

    fn send(inputs: &[INPUT]) -> Result<(), String> {
        if inputs.is_empty() {
            return Ok(());
        }
        let sent = unsafe {
            SendInput(
                inputs.len() as u32,
                inputs.as_ptr(),
                size_of::<INPUT>() as i32,
            )
        };
        if sent != inputs.len() as u32 {
            return Err(format!(
                "Windows injected {sent}/{} input events",
                inputs.len()
            ));
        }
        Ok(())
    }

    pub fn send_text(id: &str, text: &str) -> Result<usize, String> {
        let _ = focus(id)?;
        let chars: Vec<u16> = text
            .chars()
            .flat_map(|ch| ch.encode_utf16(&mut [0; 2]).to_vec())
            .collect();
        if chars.len() > MAX_TEXT_CHARS {
            return Err(format!(
                "desktop text is limited to {MAX_TEXT_CHARS} UTF-16 code units"
            ));
        }
        let mut inputs = Vec::with_capacity(chars.len() * 2);
        for scan in chars.iter().copied() {
            inputs.push(INPUT {
                r#type: INPUT_KEYBOARD,
                Anonymous: INPUT_0 {
                    ki: KEYBDINPUT {
                        wVk: 0,
                        wScan: scan,
                        dwFlags: KEYEVENTF_UNICODE,
                        time: 0,
                        dwExtraInfo: 0,
                    },
                },
            });
            inputs.push(INPUT {
                r#type: INPUT_KEYBOARD,
                Anonymous: INPUT_0 {
                    ki: KEYBDINPUT {
                        wVk: 0,
                        wScan: scan,
                        dwFlags: KEYEVENTF_UNICODE | KEYEVENTF_KEYUP,
                        time: 0,
                        dwExtraInfo: 0,
                    },
                },
            });
        }
        send(&inputs)?;
        Ok(text.chars().count())
    }

    fn key_code(key: DesktopKey) -> u16 {
        match key {
            DesktopKey::Enter => VK_RETURN,
            DesktopKey::Escape => VK_ESCAPE,
            DesktopKey::Tab => VK_TAB,
            DesktopKey::Backspace => VK_BACK,
            DesktopKey::Space => VK_SPACE,
            DesktopKey::ArrowUp => VK_UP,
            DesktopKey::ArrowDown => VK_DOWN,
            DesktopKey::ArrowLeft => VK_LEFT,
            DesktopKey::ArrowRight => VK_RIGHT,
        }
    }

    pub fn press_key(id: &str, key: DesktopKey) -> Result<(), String> {
        let _ = focus(id)?;
        let code = key_code(key);
        let inputs = [
            INPUT {
                r#type: INPUT_KEYBOARD,
                Anonymous: INPUT_0 {
                    ki: KEYBDINPUT {
                        wVk: code,
                        wScan: 0,
                        dwFlags: 0,
                        time: 0,
                        dwExtraInfo: 0,
                    },
                },
            },
            INPUT {
                r#type: INPUT_KEYBOARD,
                Anonymous: INPUT_0 {
                    ki: KEYBDINPUT {
                        wVk: code,
                        wScan: 0,
                        dwFlags: KEYEVENTF_KEYUP,
                        time: 0,
                        dwExtraInfo: 0,
                    },
                },
            },
        ];
        send(&inputs)
    }

    pub fn click(id: &str, x: i32, y: i32) -> Result<(), String> {
        let hwnd = focus(id)?;
        let Some(rect) = bounds(hwnd) else {
            return Err("desktop window bounds are unavailable".to_string());
        };
        if x < 0 || y < 0 || x >= rect.width || y >= rect.height {
            return Err("click coordinates must stay inside the selected window".to_string());
        }
        let screen_x = rect.x.saturating_add(x);
        let screen_y = rect.y.saturating_add(y);
        if unsafe { SetCursorPos(screen_x, screen_y) } == 0 {
            return Err("Windows refused to move the pointer".to_string());
        }
        let inputs = [
            INPUT {
                r#type: INPUT_MOUSE,
                Anonymous: INPUT_0 {
                    mi: MOUSEINPUT {
                        dx: 0,
                        dy: 0,
                        mouseData: 0,
                        dwFlags: MOUSEEVENTF_LEFTDOWN,
                        time: 0,
                        dwExtraInfo: 0,
                    },
                },
            },
            INPUT {
                r#type: INPUT_MOUSE,
                Anonymous: INPUT_0 {
                    mi: MOUSEINPUT {
                        dx: 0,
                        dy: 0,
                        mouseData: 0,
                        dwFlags: MOUSEEVENTF_LEFTUP,
                        time: 0,
                        dwExtraInfo: 0,
                    },
                },
            },
        ];
        send(&inputs)
    }
}

#[cfg(windows)]
pub fn windows() -> Result<Vec<DesktopWindow>, String> {
    windows_impl::windows()
}

#[cfg(windows)]
pub fn elements(id: &str) -> Result<Vec<DesktopElement>, String> {
    windows_impl::elements(id)
}

#[cfg(windows)]
pub fn focus(id: &str) -> Result<(), String> {
    windows_impl::focus(id).map(|_| ())
}

#[cfg(windows)]
pub fn send_text(id: &str, text: &str) -> Result<usize, String> {
    windows_impl::send_text(id, text)
}

#[cfg(windows)]
pub fn press_key(id: &str, key: DesktopKey) -> Result<(), String> {
    windows_impl::press_key(id, key)
}

#[cfg(windows)]
pub fn click(id: &str, x: i32, y: i32) -> Result<(), String> {
    windows_impl::click(id, x, y)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_are_allowlisted() {
        assert_eq!(DesktopKey::parse("ENTER"), Some(DesktopKey::Enter));
        assert_eq!(DesktopKey::parse("unknown"), None);
    }

    #[test]
    fn status_is_explicit() {
        let current = status();
        assert!(!current.platform.is_empty());
        assert!(!current.reason.is_empty());
    }
}
