//! WKWebView test bridge: macOS debug builds in test mode only (ADR 0003,
//! amendment of 13/10/2026).
//!
//! WKWebView exposes no DevTools protocol. This serves the subset of it the
//! native proofs use (`scripts/cdp-harness.mjs`) on
//! `127.0.0.1:<MUSE_DESKTOP_TEST_CDP_PORT>`: `/json/list`, then one WebSocket
//! per window. Each call runs on the main thread against the window's own
//! WKWebView:
//!
//! - `Runtime.evaluate` through `callAsyncJavaScript` in the page world, so a
//!   promise is awaited and a throw comes back as `exceptionDetails`;
//! - `Input.*` as AppKit events handed to the WKWebView, which WebKit treats
//!   as real input (`isTrusted`), with no Accessibility grant;
//! - `Page.captureScreenshot` through `takeSnapshot`, `Page.reload`, scripts on
//!   new documents as `WKUserScript`s, the colour scheme through the view's
//!   appearance and the window bounds through Tauri.
//!
//! Console errors and uncaught exceptions are kept by `ERROR_CAPTURE` and
//! relayed as `Runtime.consoleAPICalled` / `Runtime.exceptionThrown`. Any
//! other method answers -32601: a proof never mistakes a missing emulation for
//! a pass. The module is not compiled into a release build, and only
//! `test_mode::setup` starts it.

use std::ffi::c_void;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;

use base64::Engine as _;
use block2::RcBlock;
use objc2::rc::{Allocated, Retained};
use objc2::runtime::{AnyObject, Bool};
use objc2::{class, msg_send};
use objc2_foundation::{NSPoint, NSString};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

/// Keeps console errors and uncaught exceptions for the bridge to relay.
/// Installed on every document of a test window (`test_mode::setup`).
pub const ERROR_CAPTURE: &str = r#"(() => {
  if (window.__museBridgeErrors) return;
  const queue = window.__museBridgeErrors = [];
  const push = (kind, text) => { if (queue.length < 200) queue.push({ kind, text: String(text).slice(0, 2000) }); };
  const show = (value) => {
    if (value instanceof Error) return value.stack || value.message;
    if (typeof value === 'string') return value;
    try { return JSON.stringify(value); } catch { return String(value); }
  };
  const original = console.error.bind(console);
  console.error = (...args) => { try { push('console', args.map(show).join(' ')); } catch {} return original(...args); };
  addEventListener('error', (event) => push('exception', (event.error && event.error.stack) || event.message));
  addEventListener('unhandledrejection', (event) => push('exception', show(event.reason)));
})();"#;

const DRAIN_ERRORS: &str = "JSON.stringify((window.__museBridgeErrors || []).splice(0))";
/// Longer than any proof's own bound: the harness times its calls out first.
const CALL_TIMEOUT: Duration = Duration::from_secs(600);
const MAX_FRAME: u64 = 64 << 20;

static NEXT_SCRIPT: AtomicU64 = AtomicU64::new(1);
/// Scripts added by `Page.addScriptToEvaluateOnNewDocument`: (identifier, source).
static SCRIPTS: Mutex<Vec<(String, String)>> = Mutex::new(Vec::new());

pub fn start(app: AppHandle, port: u16) {
    let listener = match TcpListener::bind(("127.0.0.1", port)) {
        Ok(listener) => listener,
        Err(error) => {
            eprintln!("muse-desktop: test bridge not opened on 127.0.0.1:{port}: {error}");
            return;
        }
    };
    eprintln!("muse-desktop: test mode: WKWebView test bridge on 127.0.0.1:{port}");
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let app = app.clone();
            std::thread::spawn(move || {
                if let Err(error) = serve(&app, stream, port) {
                    eprintln!("muse-desktop: test bridge connection: {error}");
                }
            });
        }
    });
}

fn serve(app: &AppHandle, stream: TcpStream, port: u16) -> std::io::Result<()> {
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut request_line = String::new();
    reader.read_line(&mut request_line)?;
    let path = request_line.split_whitespace().nth(1).unwrap_or("/").to_string();
    let mut key = None;
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line)? == 0 || line.trim().is_empty() {
            break;
        }
        if let Some((name, value)) = line.split_once(':') {
            if name.trim().eq_ignore_ascii_case("sec-websocket-key") {
                key = Some(value.trim().to_string());
            }
        }
    }
    let mut out = stream;
    if let (Some(label), Some(key)) = (path.strip_prefix("/devtools/page/"), key) {
        let label = label.to_string();
        if app.get_webview_window(&label).is_none() {
            return http(&mut out, "404 Not Found", &json!({ "error": "no such target" }));
        }
        write!(
            out,
            "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {}\r\n\r\n",
            accept_key(&key)
        )?;
        return socket(app, label, reader, out);
    }
    match path.trim_end_matches('/') {
        "/json" | "/json/list" => http(&mut out, "200 OK", &targets(app, port)),
        "/json/version" => http(
            &mut out,
            "200 OK",
            &json!({ "Browser": "Muse-Desktop WKWebView test bridge", "Protocol-Version": "1.3" }),
        ),
        _ => http(&mut out, "404 Not Found", &json!({ "error": "unknown path" })),
    }
}

fn http(out: &mut TcpStream, status: &str, body: &Value) -> std::io::Result<()> {
    let body = body.to_string();
    write!(
        out,
        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
}

fn targets(app: &AppHandle, port: u16) -> Value {
    let mut list: Vec<Value> = app
        .webview_windows()
        .into_iter()
        .map(|(label, window)| {
            json!({
                "id": label,
                "type": "page",
                "title": window.title().unwrap_or_default(),
                "url": window.url().map(|url| url.to_string()).unwrap_or_default(),
                "webSocketDebuggerUrl": format!("ws://127.0.0.1:{port}/devtools/page/{label}"),
            })
        })
        .collect();
    list.sort_by_key(|target| target["id"] != "main");
    Value::Array(list)
}

fn accept_key(key: &str) -> String {
    use sha1::{Digest, Sha1};
    let digest = Sha1::digest(format!("{key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11").as_bytes());
    base64::engine::general_purpose::STANDARD.encode(digest)
}

fn socket(app: &AppHandle, label: String, mut reader: BufReader<TcpStream>, out: TcpStream) -> std::io::Result<()> {
    let out = Arc::new(Mutex::new(out));
    let open = Arc::new(AtomicBool::new(true));
    {
        // Relay the page's console errors and uncaught exceptions as events.
        let (app, label, out, open) = (app.clone(), label.clone(), out.clone(), open.clone());
        std::thread::spawn(move || {
            while open.load(Ordering::Relaxed) {
                std::thread::sleep(Duration::from_millis(500));
                let Ok(text) = evaluate_script(&app, &label, DRAIN_ERRORS) else { continue };
                let entries: Vec<Value> = serde_json::from_str(&text).unwrap_or_default();
                for entry in entries {
                    let text = entry["text"].as_str().unwrap_or_default();
                    let event = if entry["kind"] == "console" {
                        json!({ "method": "Runtime.consoleAPICalled",
                                "params": { "type": "error", "args": [{ "type": "string", "value": text }] } })
                    } else {
                        json!({ "method": "Runtime.exceptionThrown",
                                "params": { "exceptionDetails": { "text": "Uncaught", "exception": { "description": text } } } })
                    };
                    if send(&out, &event).is_err() {
                        return;
                    }
                }
            }
        });
    }
    let result = (|| loop {
        let (opcode, payload) = read_frame(&mut reader)?;
        match opcode {
            0x1 => {
                let Ok(message) = serde_json::from_slice::<Value>(&payload) else { continue };
                let (app, label, out) = (app.clone(), label.clone(), out.clone());
                // Calls run side by side, as over CDP: a long evaluation never
                // holds back the next one.
                std::thread::spawn(move || {
                    let id = message["id"].clone();
                    let method = message["method"].as_str().unwrap_or_default();
                    let params = message.get("params").cloned().unwrap_or_else(|| json!({}));
                    let reply = match dispatch(&app, &label, method, &params) {
                        Ok(result) => json!({ "id": id, "result": result }),
                        Err((code, message)) => json!({ "id": id, "error": { "code": code, "message": message } }),
                    };
                    let _ = send(&out, &reply);
                });
            }
            0x8 => return Ok(()),
            0x9 => write_frame(&out, 0xA, &payload)?,
            _ => {}
        }
    })();
    open.store(false, Ordering::Relaxed);
    result
}

fn read_frame(reader: &mut impl Read) -> std::io::Result<(u8, Vec<u8>)> {
    let mut head = [0u8; 2];
    reader.read_exact(&mut head)?;
    let opcode = head[0] & 0x0f;
    let masked = head[1] & 0x80 != 0;
    let mut len = u64::from(head[1] & 0x7f);
    if len == 126 {
        let mut ext = [0u8; 2];
        reader.read_exact(&mut ext)?;
        len = u64::from(u16::from_be_bytes(ext));
    } else if len == 127 {
        let mut ext = [0u8; 8];
        reader.read_exact(&mut ext)?;
        len = u64::from_be_bytes(ext);
    }
    if len > MAX_FRAME {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "frame too large"));
    }
    let mut mask = [0u8; 4];
    if masked {
        reader.read_exact(&mut mask)?;
    }
    let mut payload = vec![0u8; len as usize];
    reader.read_exact(&mut payload)?;
    if masked {
        for (index, byte) in payload.iter_mut().enumerate() {
            *byte ^= mask[index % 4];
        }
    }
    Ok((opcode, payload))
}

fn write_frame(out: &Mutex<TcpStream>, opcode: u8, payload: &[u8]) -> std::io::Result<()> {
    let mut frame = vec![0x80 | opcode];
    match payload.len() {
        len if len < 126 => frame.push(len as u8),
        len if len <= 0xffff => {
            frame.push(126);
            frame.extend_from_slice(&(len as u16).to_be_bytes());
        }
        len => {
            frame.push(127);
            frame.extend_from_slice(&(len as u64).to_be_bytes());
        }
    }
    frame.extend_from_slice(payload);
    let mut stream = out.lock().map_err(|_| std::io::Error::other("socket lock poisoned"))?;
    stream.write_all(&frame)
}

fn send(out: &Mutex<TcpStream>, value: &Value) -> std::io::Result<()> {
    write_frame(out, 0x1, value.to_string().as_bytes())
}

type CallError = (i64, String);

fn unsupported(method: &str) -> CallError {
    (-32601, format!("{method} is not supported by the WKWebView test bridge"))
}

fn dispatch(app: &AppHandle, label: &str, method: &str, params: &Value) -> Result<Value, CallError> {
    let fail = |message: String| (-32000, message);
    match method {
        "Runtime.enable" | "Page.enable" | "DOM.enable" | "Network.enable" | "Log.enable" => Ok(json!({})),
        "Runtime.evaluate" => runtime_evaluate(app, label, params).map_err(fail),
        "Page.reload" => on_main(app, label, |web_view, _| unsafe {
            let _: *mut AnyObject = msg_send![web_view, reload];
            Ok(json!({}))
        })
        .map_err(fail),
        "Page.captureScreenshot" => screenshot(app, label).map_err(fail),
        "Page.addScriptToEvaluateOnNewDocument" => add_script(app, label, params).map_err(fail),
        "Page.removeScriptToEvaluateOnNewDocument" => remove_script(app, label, params).map_err(fail),
        "Input.insertText" => {
            let text = params["text"].as_str().unwrap_or_default().to_string();
            insert_text(app, label, text).map_err(fail)
        }
        "Input.dispatchKeyEvent" => key_event(app, label, params).map_err(fail),
        "Input.dispatchMouseEvent" => mouse_event(app, label, params),
        "Emulation.setEmulatedMedia" => emulated_media(app, label, params),
        "Browser.getWindowForTarget" => {
            let window = app.get_webview_window(label).ok_or_else(|| fail("no such target".into()))?;
            let scale = window.scale_factor().unwrap_or(1.0);
            let size = window.outer_size().map_err(|e| fail(e.to_string()))?.to_logical::<f64>(scale);
            let position = window.outer_position().map_err(|e| fail(e.to_string()))?.to_logical::<f64>(scale);
            Ok(json!({ "windowId": 1, "bounds": {
                "left": position.x, "top": position.y, "width": size.width, "height": size.height, "windowState": "normal" } }))
        }
        "Browser.setWindowBounds" => {
            let window = app.get_webview_window(label).ok_or_else(|| fail("no such target".into()))?;
            let bounds = &params["bounds"];
            if let (Some(width), Some(height)) = (bounds["width"].as_f64(), bounds["height"].as_f64()) {
                window
                    .set_size(tauri::LogicalSize::new(width, height))
                    .map_err(|e| fail(e.to_string()))?;
            }
            Ok(json!({}))
        }
        _ => Err(unsupported(method)),
    }
}

/// Runs `body` on the main thread with the window's WKWebView and NSWindow,
/// and waits for the value it sends back (possibly from a completion block).
fn on_main_async<F>(app: &AppHandle, label: &str, body: F) -> Result<Value, String>
where
    F: FnOnce(*mut AnyObject, *mut AnyObject, mpsc::Sender<Result<Value, String>>) + Send + 'static,
{
    let window = app.get_webview_window(label).ok_or("no such target")?;
    let (tx, rx) = mpsc::channel();
    window
        .with_webview(move |platform| {
            body(platform.inner().cast::<AnyObject>(), platform.ns_window().cast::<AnyObject>(), tx)
        })
        .map_err(|error| format!("webview unavailable: {error}"))?;
    rx.recv_timeout(CALL_TIMEOUT).map_err(|_| "no answer from the webview".to_string())?
}

fn on_main<F>(app: &AppHandle, label: &str, body: F) -> Result<Value, String>
where
    F: FnOnce(*mut AnyObject, *mut AnyObject) -> Result<Value, String> + Send + 'static,
{
    on_main_async(app, label, move |web_view, window, tx| {
        let _ = tx.send(body(web_view, window));
    })
}

unsafe fn string_of(object: *mut AnyObject) -> Option<String> {
    if object.is_null() {
        return None;
    }
    let is_string: bool = msg_send![object, isKindOfClass: class!(NSString)];
    is_string.then(|| (*object.cast::<NSString>()).to_string())
}

/// WebKit's message for a failed evaluation: the JavaScript exception when
/// there was one, the error's own description otherwise.
unsafe fn error_text(error: *mut AnyObject) -> String {
    let info: *mut AnyObject = msg_send![error, userInfo];
    if !info.is_null() {
        let key = NSString::from_str("WKJavaScriptExceptionMessage");
        let message: *mut AnyObject = msg_send![info, objectForKey: &*key];
        if let Some(text) = string_of(message) {
            return text;
        }
    }
    let description: *mut AnyObject = msg_send![error, localizedDescription];
    string_of(description).unwrap_or_else(|| "evaluation failed".to_string())
}

/// `evaluateJavaScript` of a script whose completion value is a string.
fn evaluate_script(app: &AppHandle, label: &str, script: &'static str) -> Result<String, String> {
    let value = on_main_async(app, label, move |web_view, _, tx| unsafe {
        let source = NSString::from_str(script);
        let block = RcBlock::new(move |result: *mut AnyObject, error: *mut AnyObject| {
            let _ = tx.send(if error.is_null() {
                Ok(Value::String(string_of(result).unwrap_or_default()))
            } else {
                Err(error_text(error))
            });
        });
        let _: () = msg_send![web_view, evaluateJavaScript: &*source, completionHandler: &*block];
    })?;
    Ok(value.as_str().unwrap_or_default().to_string())
}

fn runtime_evaluate(app: &AppHandle, label: &str, params: &Value) -> Result<Value, String> {
    let expression = params["expression"].as_str().unwrap_or_default();
    let await_promise = params["awaitPromise"].as_bool().unwrap_or(false);
    // Indirect eval runs the expression as a global script, as CDP does; the
    // function body only carries the value back as JSON.
    let body = format!(
        "let v = (0, eval)({source});\n\
         if ({await_promise}) v = await v;\n\
         const t = v === null ? 'object' : typeof v;\n\
         let out;\n\
         try {{ out = JSON.stringify({{ t, u: v === undefined, v: v === undefined ? null : v }}); }} catch {{ out = undefined; }}\n\
         return out === undefined ? JSON.stringify({{ t, d: String(v) }}) : out;",
        source = Value::String(expression.to_string()),
    );
    let outcome = on_main_async(app, label, move |web_view, _, tx| unsafe {
        let body = NSString::from_str(&body);
        let world: *mut AnyObject = msg_send![class!(WKContentWorld), pageWorld];
        let block = RcBlock::new(move |result: *mut AnyObject, error: *mut AnyObject| {
            let _ = tx.send(Ok(if error.is_null() {
                json!({ "ok": string_of(result).unwrap_or_default() })
            } else {
                json!({ "thrown": error_text(error) })
            }));
        });
        let none: *mut AnyObject = std::ptr::null_mut();
        let _: () = msg_send![
            web_view,
            callAsyncJavaScript: &*body,
            arguments: none,
            inFrame: none,
            inContentWorld: world,
            completionHandler: &*block
        ];
    })?;
    if let Some(message) = outcome["thrown"].as_str() {
        return Ok(json!({
            "result": { "type": "object", "subtype": "error", "description": message },
            "exceptionDetails": { "text": "Uncaught", "exception": { "type": "object", "subtype": "error", "description": message } },
        }));
    }
    let carried: Value = serde_json::from_str(outcome["ok"].as_str().unwrap_or("{}")).unwrap_or_default();
    let kind = carried["t"].as_str().unwrap_or("undefined");
    let result = if carried["u"] == true {
        json!({ "type": "undefined" })
    } else if let Some(description) = carried.get("d") {
        json!({ "type": kind, "description": description })
    } else {
        json!({ "type": kind, "value": carried["v"] })
    };
    Ok(json!({ "result": result }))
}

fn screenshot(app: &AppHandle, label: &str) -> Result<Value, String> {
    on_main_async(app, label, |web_view, _, tx| unsafe {
        let block = RcBlock::new(move |image: *mut AnyObject, error: *mut AnyObject| {
            if image.is_null() {
                let message = if error.is_null() { "no snapshot".to_string() } else { error_text(error) };
                let _ = tx.send(Err(message));
                return;
            }
            let tiff: *mut AnyObject = msg_send![image, TIFFRepresentation];
            let rep: *mut AnyObject = msg_send![class!(NSBitmapImageRep), imageRepWithData: tiff];
            let properties: *mut AnyObject = msg_send![class!(NSDictionary), dictionary];
            // NSBitmapImageFileTypePNG
            let png: *mut AnyObject = msg_send![rep, representationUsingType: 4usize, properties: properties];
            if png.is_null() {
                let _ = tx.send(Err("PNG encoding failed".to_string()));
                return;
            }
            let length: usize = msg_send![png, length];
            let bytes: *const c_void = msg_send![png, bytes];
            let data = std::slice::from_raw_parts(bytes.cast::<u8>(), length);
            let _ = tx.send(Ok(json!({ "data": base64::engine::general_purpose::STANDARD.encode(data) })));
        });
        let none: *mut AnyObject = std::ptr::null_mut();
        let _: () = msg_send![web_view, takeSnapshotWithConfiguration: none, completionHandler: &*block];
    })
}

unsafe fn content_controller(web_view: *mut AnyObject) -> *mut AnyObject {
    let configuration: *mut AnyObject = msg_send![web_view, configuration];
    msg_send![configuration, userContentController]
}

unsafe fn user_script(source: &str) -> Retained<AnyObject> {
    let source = NSString::from_str(source);
    let allocated: Allocated<AnyObject> = msg_send![class!(WKUserScript), alloc];
    // WKUserScriptInjectionTimeAtDocumentStart, main frame only.
    msg_send![allocated, initWithSource: &*source, injectionTime: 0isize, forMainFrameOnly: Bool::YES]
}

fn add_script(app: &AppHandle, label: &str, params: &Value) -> Result<Value, String> {
    let source = params["source"].as_str().unwrap_or_default().to_string();
    let identifier = NEXT_SCRIPT.fetch_add(1, Ordering::Relaxed).to_string();
    SCRIPTS
        .lock()
        .map_err(|_| "script list poisoned")?
        .push((identifier.clone(), source.clone()));
    on_main(app, label, move |web_view, _| unsafe {
        let script = user_script(&source);
        let _: () = msg_send![content_controller(web_view), addUserScript: &*script];
        Ok(json!({ "identifier": identifier }))
    })
}

/// WebKit removes user scripts all at once: every other one, Tauri's own
/// included, is added back in its order.
fn remove_script(app: &AppHandle, label: &str, params: &Value) -> Result<Value, String> {
    let identifier = params["identifier"].as_str().unwrap_or_default();
    let source = {
        let mut scripts = SCRIPTS.lock().map_err(|_| "script list poisoned")?;
        let Some(index) = scripts.iter().position(|(id, _)| id == identifier) else {
            return Err(format!("no script {identifier}"));
        };
        scripts.remove(index).1
    };
    on_main(app, label, move |web_view, _| unsafe {
        let controller = content_controller(web_view);
        let current: *mut AnyObject = msg_send![controller, userScripts];
        let kept: Retained<AnyObject> = msg_send![current, copy];
        let _: () = msg_send![controller, removeAllUserScripts];
        let count: usize = msg_send![&*kept, count];
        let mut removed = false;
        for index in 0..count {
            let script: *mut AnyObject = msg_send![&*kept, objectAtIndex: index];
            let text: *mut AnyObject = msg_send![script, source];
            if !removed && string_of(text).as_deref() == Some(source.as_str()) {
                removed = true;
                continue;
            }
            let _: () = msg_send![controller, addUserScript: script];
        }
        Ok(json!({}))
    })
}

/// Makes the WKWebView its window's first responder, as a click would, so key
/// events and text reach the focused element.
unsafe fn focus(web_view: *mut AnyObject, window: *mut AnyObject) {
    let responder: *mut AnyObject = msg_send![window, firstResponder];
    if responder != web_view {
        let _: bool = msg_send![window, makeFirstResponder: web_view];
    }
}

fn insert_text(app: &AppHandle, label: &str, text: String) -> Result<Value, String> {
    on_main(app, label, move |web_view, window| unsafe {
        focus(web_view, window);
        let text = NSString::from_str(&text);
        let _: () = msg_send![web_view, insertText: &*text];
        Ok(json!({}))
    })
}

const SHIFT: usize = 1 << 17;
const CONTROL: usize = 1 << 18;
const OPTION: usize = 1 << 19;
const COMMAND: usize = 1 << 20;

/// CDP modifiers (Alt 1, Ctrl 2, Meta 4, Shift 8) as AppKit flags.
fn modifier_flags(modifiers: u64) -> usize {
    let mut flags = 0;
    if modifiers & 1 != 0 {
        flags |= OPTION;
    }
    if modifiers & 2 != 0 {
        flags |= CONTROL;
    }
    if modifiers & 4 != 0 {
        flags |= COMMAND;
    }
    if modifiers & 8 != 0 {
        flags |= SHIFT;
    }
    flags
}

/// The macOS virtual key code and the characters AppKit attaches to a key,
/// from the CDP `code` (or `key` when `code` is absent).
fn key_of(code: &str, key: &str) -> Option<(u16, String)> {
    let special = |c: u32| char::from_u32(c).map(String::from).unwrap_or_default();
    let name = if code.is_empty() { key } else { code };
    let fixed = match name {
        "Enter" | "NumpadEnter" => Some((36, "\r".to_string())),
        "Tab" => Some((48, "\t".to_string())),
        "Space" | " " => Some((49, " ".to_string())),
        "Backspace" => Some((51, special(0x7f))),
        "Escape" => Some((53, special(0x1b))),
        "Delete" => Some((117, special(0xF728))),
        "Home" => Some((115, special(0xF729))),
        "End" => Some((119, special(0xF72B))),
        "PageUp" => Some((116, special(0xF72C))),
        "PageDown" => Some((121, special(0xF72D))),
        "ArrowLeft" => Some((123, special(0xF702))),
        "ArrowRight" => Some((124, special(0xF703))),
        "ArrowDown" => Some((125, special(0xF701))),
        "ArrowUp" => Some((126, special(0xF700))),
        "F1" => Some((122, special(0xF704))),
        "F2" => Some((120, special(0xF705))),
        "F5" => Some((96, special(0xF708))),
        "F6" => Some((97, special(0xF709))),
        "Slash" => Some((44, "/".to_string())),
        "Period" => Some((47, ".".to_string())),
        "Comma" => Some((43, ",".to_string())),
        "Minus" => Some((27, "-".to_string())),
        "Equal" => Some((24, "=".to_string())),
        "BracketLeft" => Some((33, "[".to_string())),
        "BracketRight" => Some((30, "]".to_string())),
        "Semicolon" => Some((41, ";".to_string())),
        "Quote" => Some((39, "'".to_string())),
        "Backquote" => Some((50, "`".to_string())),
        "Backslash" => Some((42, "\\".to_string())),
        _ => None,
    };
    if fixed.is_some() {
        return fixed;
    }
    // KeyA..KeyZ, Digit0..Digit9, or a single character key.
    const LETTERS: [u16; 26] = [0, 11, 8, 2, 14, 3, 5, 4, 34, 38, 40, 37, 46, 45, 31, 35, 12, 15, 1, 17, 32, 9, 13, 7, 16, 6];
    const DIGITS: [u16; 10] = [29, 18, 19, 20, 21, 23, 22, 26, 28, 25];
    let single = name
        .strip_prefix("Key")
        .or_else(|| name.strip_prefix("Digit"))
        .unwrap_or(name);
    let mut chars = single.chars();
    let (Some(c), None) = (chars.next(), chars.next()) else { return None };
    let lower = c.to_ascii_lowercase();
    if lower.is_ascii_lowercase() {
        return Some((LETTERS[(lower as u8 - b'a') as usize], lower.to_string()));
    }
    if c.is_ascii_digit() {
        return Some((DIGITS[(c as u8 - b'0') as usize], c.to_string()));
    }
    None
}

unsafe fn now() -> f64 {
    let info: *mut AnyObject = msg_send![class!(NSProcessInfo), processInfo];
    msg_send![info, systemUptime]
}

fn key_event(app: &AppHandle, label: &str, params: &Value) -> Result<Value, String> {
    let kind = params["type"].as_str().unwrap_or_default().to_string();
    let text = params["text"].as_str().unwrap_or_default().to_string();
    if kind == "char" {
        return insert_text(app, label, text);
    }
    let down = match kind.as_str() {
        "keyDown" | "rawKeyDown" => true,
        "keyUp" => false,
        other => return Err(format!("unknown key event type {other}")),
    };
    let code = params["code"].as_str().unwrap_or_default();
    let key = params["key"].as_str().unwrap_or_default();
    let (key_code, base) = key_of(code, key).ok_or_else(|| format!("no macOS key for code {code:?} key {key:?}"))?;
    let flags = modifier_flags(params["modifiers"].as_u64().unwrap_or(0));
    // The text CDP would type wins over the bare key (Shift+a gives "A").
    let characters = if text.is_empty() || flags & (COMMAND | CONTROL) != 0 { base.clone() } else { text };
    on_main(app, label, move |web_view, window| unsafe {
        focus(web_view, window);
        let number: isize = msg_send![window, windowNumber];
        let characters = NSString::from_str(&characters);
        let bare = NSString::from_str(&base);
        let none: *mut AnyObject = std::ptr::null_mut();
        // NSEventTypeKeyDown 10, NSEventTypeKeyUp 11.
        let event: *mut AnyObject = msg_send![
            class!(NSEvent),
            keyEventWithType: if down { 10usize } else { 11usize },
            location: NSPoint::new(0.0, 0.0),
            modifierFlags: flags,
            timestamp: now(),
            windowNumber: number,
            context: none,
            characters: &*characters,
            charactersIgnoringModifiers: &*bare,
            isARepeat: Bool::NO,
            keyCode: key_code
        ];
        if event.is_null() {
            return Err("AppKit refused the key event".to_string());
        }
        // A Command shortcut goes through the menu first, as typed.
        if down && flags & COMMAND != 0 {
            let handled: bool = msg_send![web_view, performKeyEquivalent: event];
            if handled {
                return Ok(json!({}));
            }
        }
        if down {
            let _: () = msg_send![web_view, keyDown: event];
        } else {
            let _: () = msg_send![web_view, keyUp: event];
        }
        Ok(json!({}))
    })
}

fn mouse_event(app: &AppHandle, label: &str, params: &Value) -> Result<Value, CallError> {
    let kind = params["type"].as_str().unwrap_or_default();
    let right = params["button"] == "right";
    let held = params["buttons"].as_u64().unwrap_or(0) & 1 != 0;
    // NSEventType: LeftMouseDown 1, LeftMouseUp 2, RightMouseDown 3,
    // RightMouseUp 4, MouseMoved 5, LeftMouseDragged 6.
    let event_type: usize = match (kind, right) {
        ("mousePressed", false) => 1,
        ("mouseReleased", false) => 2,
        ("mousePressed", true) => 3,
        ("mouseReleased", true) => 4,
        ("mouseMoved", _) if held => 6,
        ("mouseMoved", _) => 5,
        _ => return Err(unsupported(&format!("Input.dispatchMouseEvent {kind}"))),
    };
    let x = params["x"].as_f64().unwrap_or(0.0);
    let y = params["y"].as_f64().unwrap_or(0.0);
    let clicks = params["clickCount"].as_i64().unwrap_or(if event_type <= 4 { 1 } else { 0 }) as isize;
    let flags = modifier_flags(params["modifiers"].as_u64().unwrap_or(0));
    on_main(app, label, move |web_view, window| unsafe {
        // CSS pixels from the view's top-left, in window coordinates.
        let none: *mut AnyObject = std::ptr::null_mut();
        let location: NSPoint = msg_send![web_view, convertPoint: NSPoint::new(x, y), toView: none];
        let number: isize = msg_send![window, windowNumber];
        let event: *mut AnyObject = msg_send![
            class!(NSEvent),
            mouseEventWithType: event_type,
            location: location,
            modifierFlags: flags,
            timestamp: now(),
            windowNumber: number,
            context: none,
            eventNumber: 0isize,
            clickCount: clicks,
            pressure: if event_type == 1 || event_type == 3 { 1.0f32 } else { 0.0f32 }
        ];
        if event.is_null() {
            return Err("AppKit refused the mouse event".to_string());
        }
        if event_type == 1 || event_type == 3 {
            focus(web_view, window);
        }
        let _: () = match event_type {
            1 => msg_send![web_view, mouseDown: event],
            2 => msg_send![web_view, mouseUp: event],
            3 => msg_send![web_view, rightMouseDown: event],
            4 => msg_send![web_view, rightMouseUp: event],
            5 => msg_send![web_view, mouseMoved: event],
            _ => msg_send![web_view, mouseDragged: event],
        };
        Ok(json!({}))
    })
    .map_err(|message| (-32000, message))
}

fn emulated_media(app: &AppHandle, label: &str, params: &Value) -> Result<Value, CallError> {
    let mut scheme = None;
    for feature in params["features"].as_array().into_iter().flatten() {
        let name = feature["name"].as_str().unwrap_or_default();
        let value = feature["value"].as_str().unwrap_or_default().to_string();
        match name {
            "prefers-color-scheme" => scheme = Some(value),
            // An empty value clears an emulation: nothing to clear here.
            _ if value.is_empty() => {}
            _ => return Err(unsupported(&format!("Emulation.setEmulatedMedia {name}"))),
        }
    }
    let Some(scheme) = scheme else { return Ok(json!({})) };
    on_main(app, label, move |web_view, _| unsafe {
        let appearance: *mut AnyObject = match scheme.as_str() {
            "dark" | "light" => {
                let name = NSString::from_str(if scheme == "dark" { "NSAppearanceNameDarkAqua" } else { "NSAppearanceNameAqua" });
                msg_send![class!(NSAppearance), appearanceNamed: &*name]
            }
            _ => std::ptr::null_mut(),
        };
        let _: () = msg_send![web_view, setAppearance: appearance];
        Ok(json!({}))
    })
    .map_err(|message| (-32000, message))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn handshake_matches_rfc_6455() {
        assert_eq!(accept_key("dGhlIHNhbXBsZSBub25jZQ=="), "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
    }

    #[test]
    fn keys_map_to_macos_codes() {
        assert_eq!(key_of("KeyA", "a"), Some((0, "a".into())));
        assert_eq!(key_of("", "Z"), Some((6, "z".into())));
        assert_eq!(key_of("Digit7", "7"), Some((26, "7".into())));
        assert_eq!(key_of("Enter", "Enter"), Some((36, "\r".into())));
        assert_eq!(key_of("", "Escape").map(|k| k.0), Some(53));
        assert_eq!(key_of("Unidentified", ""), None);
        assert_eq!(modifier_flags(4 | 8), COMMAND | SHIFT);
    }

    #[test]
    fn frames_round_trip_masked_text() {
        let payload = br#"{"id":1,"method":"Runtime.enable"}"#;
        let mask = [1u8, 2, 3, 4];
        let mut frame = vec![0x81, 0x80 | payload.len() as u8];
        frame.extend_from_slice(&mask);
        frame.extend(payload.iter().enumerate().map(|(i, b)| b ^ mask[i % 4]));
        let (opcode, read) = read_frame(&mut &frame[..]).unwrap();
        assert_eq!(opcode, 1);
        assert_eq!(read, payload);
    }
}
