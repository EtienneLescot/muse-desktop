//! Windows adapter to Muse in the default WSL distribution.
//! Requires ~/.local/bin/muse in WSL. No credentials are bundled.
use std::io::{self, BufRead, Write};
use std::os::windows::process::CommandExt;
use std::process::{Command, Stdio};

fn wsl(cwd: &std::path::Path) -> Command {
    let mut cmd = Command::new("wsl.exe");
    cmd.arg("--cd").arg(cwd).arg("--exec").creation_flags(0x08000000);
    cmd
}
fn run() -> Result<i32, Box<dyn std::error::Error>> {
    let cwd = std::env::current_dir()?;
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    let remote = wsl(&cwd).arg("pwd").output()?;
    if !remote.status.success() { return Err("WSL cannot open this workspace".into()); }
    let remote = String::from_utf8(remote.stdout)?.trim().to_string();
    let mut child = wsl(&cwd).args(["sh", "-lc",
        "if [ ! -x \"$HOME/.local/bin/muse\" ]; then echo 'Install Muse in WSL (~/.local/bin/muse) first.' >&2; exit 127; fi; exec \"$HOME/.local/bin/muse\" \"$@\"", "muse"])
        .args(args).stdin(Stdio::piped()).stdout(Stdio::inherit()).stderr(Stdio::inherit()).spawn()?;
    let mut input = child.stdin.take().ok_or("Missing engine input")?;
    std::thread::spawn(move || {
        for line in io::stdin().lock().lines() {
            let Ok(line) = line else { break; };
            // Paths sent by the Windows supervisor must match the Linux host.
            let line = match serde_json::from_str::<serde_json::Value>(&line) {
                Ok(mut frame) => {
                    if frame["method"] == "session/start" {
                        frame["params"]["workspaceRoot"] = remote.clone().into();
                    }
                    if let Some(text) = frame.pointer_mut("/params/text").and_then(|v| v.as_str().map(str::to_owned)) {
                        let windows = cwd.to_string_lossy();
                        frame["params"]["text"] = text.replace(windows.as_ref(), &remote).into();
                    }
                    frame.to_string()
                }
                Err(_) => line,
            };
            if writeln!(input, "{line}").and_then(|_| input.flush()).is_err() { break; }
        }
        // EOF closes the host's input when the desktop supervisor disconnects.
    });
    Ok(child.wait()?.code().unwrap_or(1))
}
fn main() {
    match run() {
        Ok(code) => std::process::exit(code),
        Err(error) => { eprintln!("Muse WSL adapter: {error}"); std::process::exit(1); }
    }
}
