/**
 * One isolated test instance of the macOS debug build (ADR 0003, amendment of
 * 13/10/2026), for the native macOS proofs. Shared by every scripts/macos/
 * proof so that none of them re-implements the isolation:
 *
 * - refuses an exe without the test-mode switch (a release build would run on
 *   the user's own profile) and a CDP port already taken;
 * - every local engine is the pinned engine binary, never the self-updating
 *   launcher ~/.local/bin/muse, with MUSE_NO_AUTO_UPDATE=1; its exact version
 *   is read before the app starts;
 * - waits for test-mode.pid, then checks, before handing the page over, that
 *   the window runs on its own WKWebView store and that the installed app's
 *   store and the debug exe's default store did not change;
 * - stop() closes the app's window (Tauri's window close, the OS close path;
 *   Cmd+Q as a fallback), kills what is left of
 *   its process group, checks the stores again and deletes the test store.
 *
 *   const inst = await launch({ exe, port, data, engine });
 *   await inst.app.ev("document.title"); ...; const end = await inst.stop();
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openPage, sleep, waitFor } from "../cdp-harness.mjs";

export const SWITCH = "MUSE_DESKTOP_TEST_DATA_DIR";
export const DEFAULT_ENGINE = join(homedir(), "muse-proofs", "engine", "1.4.2-R4684.1", "muse-bin");
export const FIXTURE = fileURLToPath(new URL("../muse-fixture.mjs", import.meta.url));
const WEBKIT = join(homedir(), "Library", "WebKit");

/** The engine's own version line, read with auto-update off. */
export function engineVersion(engine = DEFAULT_ENGINE) {
  return execFileSync(engine, ["--version"], { encoding: "utf8", env: { ...process.env, MUSE_NO_AUTO_UPDATE: "1" }, timeout: 30_000 }).trim();
}

/** Every file of the given folders with size and mtime. */
export function treeStamp(dirs) {
  const files = {};
  const walk = (dir) => {
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else try { const s = statSync(path); files[path] = `${s.size}:${s.mtimeMs}`; } catch { /* gone */ }
    }
  };
  for (const dir of dirs) walk(dir);
  return files;
}

/** The app pid and every process under it (ps), as { pid, ppid, command }. */
export function processTree(root) {
  const rows = execFileSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8", maxBuffer: 32 << 20 })
    .split("\n").map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)).filter(Boolean)
    .map(([, pid, ppid, command]) => ({ pid: Number(pid), ppid: Number(ppid), command }));
  const out = rows.filter((p) => p.pid === root);
  for (let i = 0; i < out.length; i++) out.push(...rows.filter((p) => p.ppid === out[i].pid && !out.includes(p)));
  return out;
}

/**
 * Starts the instance. `engine` is a path (wrapped as a one-element argv) or
 * an argv array (e.g. ["node", FIXTURE]). `env` adds variables (e.g.
 * MUSE_DESKTOP_TEST_REMOTE_MCP).
 */
export async function launch({ exe, port, data, engine = DEFAULT_ENGINE, env = {}, loadTimeoutMs = 60_000 }) {
  exe = resolve(exe);
  if (!existsSync(exe)) throw new Error(`no app at ${exe}`);
  if (!readFileSync(exe).includes(SWITCH)) throw new Error(`${exe} has no test mode (release build?): refusing to start it`);
  if (await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(3_000) }).then(() => true, (e) => e?.name === "TimeoutError")) {
    throw new Error(`port ${port} is already taken: refusing to drive another app`);
  }
  const argv = Array.isArray(engine) ? engine : [engine];
  const version = Array.isArray(engine) ? "fixture" : engineVersion(engine);
  mkdirSync(data, { recursive: true });
  const defaults = [join(WEBKIT, "com.muse.desktop"), join(WEBKIT, basename(exe), "WebsiteData")];
  const before = treeStamp(defaults);
  const output = [];
  const childEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^WEBVIEW2_|^MUSE_DESKTOP_TEST_/i.test(name)));
  const child = spawn(exe, [], {
    env: { ...childEnv, ...env, [SWITCH]: data, MUSE_DESKTOP_TEST_SIDECAR: JSON.stringify(argv), MUSE_DESKTOP_TEST_CDP_PORT: String(port), MUSE_NO_AUTO_UPDATE: "1" },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  const keep = (chunk) => { output.push(...String(chunk).split(/\r?\n/).filter(Boolean)); output.splice(0, output.length - 200); };
  child.stdout.on("data", keep);
  child.stderr.on("data", keep);
  child.once("error", (error) => keep(`spawn failed: ${error.message}`));
  const killGroup = () => { try { process.kill(-child.pid, "SIGKILL"); } catch { /* gone */ } };
  try {
    const entered = await waitFor(() => { try { return readFileSync(join(data, "test-mode.pid"), "utf8").trim() === String(child.pid); } catch { return false; } }, 10_000, 100);
    if (!entered) throw new Error(`no test-mode.pid within 10 s (exit ${child.exitCode}): not in test mode`);
    const app = await waitFor(() => (child.exitCode === null ? openPage(port).catch(() => null) : "exited"), 60_000, 500);
    if (!app || app === "exited") throw new Error(`no page on the bridge ${port} (exit ${child.exitCode})`);
    const loaded = await waitFor(() => app.ev("location.protocol === 'tauri:' && document.readyState === 'complete'").catch(() => false), loadTimeoutMs, 250);
    if (!loaded) throw new Error("the app page never finished loading");
    const store = join(WEBKIT, basename(exe), "WebsiteDataStore", readFileSync(join(data, "webkit-store"), "utf8").trim().toLowerCase());
    await app.ev("(localStorage.setItem('muse-proof.store-probe', '1'), true)");
    if (!(await waitFor(() => existsSync(store), 30_000, 500))) throw new Error("the test WKWebView store was not written");
    const sameDefaults = () => JSON.stringify(before) === JSON.stringify(treeStamp(defaults));
    if (!sameDefaults()) throw new Error("a default WKWebView store changed: stopped before driving the app");
    const isolation = { data, store: `~/Library/WebKit/${basename(exe)}/WebsiteDataStore/<${basename(store)}>`, defaultStoresUnchangedAtStart: true };

    async function stop({ keepStore = false } = {}) {
      const end = { quitBy: null };
      if (child.exitCode === null) {
        // The window closed through Tauri's window API, the path of a close
        // from the OS: the last window closed ends the app (RunEvent::Exit
        // stops the hosts). macOS draws no Close button in the page. Not awaited:
        // the page goes with the window.
        await app.ev("(window.__TAURI_INTERNALS__.invoke('plugin:window|close', { label: 'main' }), true)").catch(() => null);
        end.quitBy = (await waitFor(() => child.exitCode !== null, 20_000, 200)) ? "window closed" : null;
        if (!end.quitBy) {
          await app.send("Input.dispatchKeyEvent", { type: "keyDown", key: "q", code: "KeyQ", modifiers: 4 }).catch(() => null);
          end.quitBy = (await waitFor(() => child.exitCode !== null, 10_000, 200)) ? "Cmd+Q" : "SIGKILL";
        }
      } else {
        end.quitBy = "already exited";
      }
      app.close();
      await sleep(1_000);
      end.leftAfterQuit = processTree(child.pid).map((p) => p.command.slice(0, 160));
      const group = execFileSync("ps", ["-axo", "pid=,pgid=,command="], { encoding: "utf8" }).split("\n")
        .map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)).filter((m) => m && Number(m[2]) === child.pid).map((m) => m[3].slice(0, 160));
      end.groupLeftAfterQuit = group;
      killGroup();
      end.exitCode = child.exitCode;
      end.defaultStoresUnchangedAtEnd = sameDefaults();
      if (!keepStore) { try { rmSync(store, { recursive: true, force: true }); end.testStoreDeleted = !existsSync(store); } catch { end.testStoreDeleted = false; } }
      return end;
    }
    return { app, child, pid: child.pid, data, store, isolation, engineVersion: version, output, stop };
  } catch (error) {
    killGroup();
    error.appOutput = output.slice(-40);
    throw error;
  }
}
