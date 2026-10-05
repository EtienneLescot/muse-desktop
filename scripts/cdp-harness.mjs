/**
 * Shared CDP plumbing for the 05/10/2026 baseline proofs
 * (cdp-m0-08-engine-run, cdp-m2-01-project-roots, cdp-m0-13-click-effect).
 * Not a scenario: it only opens the page target, evaluates async expressions,
 * collects console errors, traces the Tauri IPC and redacts paths.
 *
 * Requires the CDP-enabled build:
 *   $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=9222"
 * MUSE_CDP_PORT overrides the port (default 9222).
 */
import { execFileSync } from "node:child_process";

export const PORT = Number(process.env.MUSE_CDP_PORT ?? 9222);
export const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

export function argValue(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] !== undefined ? process.argv[index + 1] : fallback;
}

/** Open the app page; `ev` awaits promises; console errors are collected. */
export async function openPage() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = list.find((t) => t.type === "page" && typeof t.webSocketDebuggerUrl === "string"
    && /tauri\.localhost/.test(t.url));
  if (!page) throw new Error(`no app page target on CDP ${PORT}`);
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  let nextId = 1;
  const pending = new Map();
  const errors = [];
  socket.addEventListener("message", (event) => {
    let frame;
    try { frame = JSON.parse(String(event.data)); } catch { return; }
    if (frame.method === "Runtime.exceptionThrown") {
      errors.push(String(frame.params?.exceptionDetails?.exception?.description ?? frame.params?.exceptionDetails?.text).slice(0, 300));
    } else if (frame.method === "Runtime.consoleAPICalled" && frame.params?.type === "error") {
      errors.push((frame.params.args ?? []).map((a) => a.value ?? a.description ?? "").join(" ").slice(0, 300));
    }
    const entry = frame.id !== undefined ? pending.get(frame.id) : undefined;
    if (!entry) return;
    pending.delete(frame.id);
    clearTimeout(entry.timer);
    if (frame.error) entry.reject(new Error(`${entry.method}: ${frame.error.message}`));
    else entry.resolve(frame.result);
  });
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", () => reject(new Error("CDP socket error")), { once: true });
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method}: timed out`)); }, 60_000);
    pending.set(id, { resolve, reject, method, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
  await send("Runtime.enable");
  const ev = async (expression) => {
    const result = await send("Runtime.evaluate", {
      expression: `(async () => { try { return JSON.stringify(await (${expression})); }
        catch (error) { return JSON.stringify({ __error: String((error && error.message) || error) }); } })()`,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? "evaluation failed");
    const parsed = JSON.parse(result.result?.value ?? "null");
    if (parsed && typeof parsed === "object" && "__error" in parsed) throw new Error(parsed.__error);
    return parsed;
  };
  return { send, ev, errors, close: () => { try { socket.close(); } catch { /* closed */ } } };
}

/** Poll an async probe until it returns a truthy value or the bound expires. */
export async function waitFor(probe, timeoutMs, everyMs = 500) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await probe();
    if (last) return last;
    await sleep(everyMs);
  }
  return last;
}

/**
 * Page-side IPC trace on window.fetch (the Tauri custom-protocol transport,
 * see cdp-stop-terminal.mjs). Records command, arguments and the bounded
 * result; event polls are skipped. `plugin:dialog|open` is answered from
 * window.__baselineIpc.dialogQueue when an answer is queued: CDP cannot drive
 * the OS folder dialog, so the harness supplies the folder the user would pick.
 * Wraps fetch once per page load; every call starts a fresh trace.
 */
export const INSTALL_IPC_TRACE = `(() => {
  if (window.__baselineIpc && window.__baselineIpc.installed) {
    window.__baselineIpc.calls = [];
    window.__baselineIpc.dialogQueue = [];
    return 'reset';
  }
  const state = window.__baselineIpc = { installed: true, calls: [], dialogQueue: [], t0: Date.now() };
  const original = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = String(typeof input === 'string' ? input : (input && input.url) || input);
    const match = url.match(/^https?:\\/\\/ipc\\.localhost\\/([^/?#]+)/);
    if (!match) return original(input, init);
    const cmd = decodeURIComponent(match[1]);
    let args = null;
    try { args = typeof (init && init.body) === 'string' ? JSON.parse(init.body) : null; } catch { args = null; }
    if (args && typeof args === 'object' && 'since' in args) return original(input, init);
    const entry = { atMs: Date.now() - state.t0, cmd, args };
    state.calls.push(entry);
    if (state.calls.length > 400) state.calls.shift();
    // Safety guard: a command listed in state.block is refused before it
    // reaches the backend (used to make sure a probe can never send a turn).
    if ((state.block || []).includes(cmd)) {
      entry.blockedByHarness = true;
      entry.ok = false;
      return new Response(JSON.stringify('blocked by the test harness'), {
        status: 200,
        headers: { 'Tauri-Response': 'error', 'Content-Type': 'application/json' },
      });
    }
    if (cmd === 'plugin:dialog|open' && state.dialogQueue.length > 0) {
      const answer = state.dialogQueue.shift();
      entry.answeredByHarness = true;
      entry.ok = true;
      entry.result = JSON.stringify(answer);
      return new Response(JSON.stringify(answer), {
        status: 200,
        headers: { 'Tauri-Response': 'ok', 'Content-Type': 'application/json' },
      });
    }
    const response = await original(input, init);
    entry.ok = response.headers.get('Tauri-Response') === 'ok';
    try { entry.result = (await response.clone().text()).slice(0, 2000); } catch { entry.result = null; }
    return response;
  };
  return 'installed';
})()`;

/** Replace every spelling of the given roots (and the user profile) by labels. */
export function redactor(pairs) {
  const variants = [];
  for (const [path, label] of pairs) {
    const plain = path.replace(/[\\/]+$/, "");
    // Raw, slash, JSON-escaped and doubly escaped (an error string kept as JSON text).
    const json = plain.replaceAll("\\", "\\\\");
    for (const form of new Set([plain, plain.replaceAll("\\", "/"), json, json.replaceAll("\\", "\\\\"), plain.replaceAll("/", "\\\\")])) {
      variants.push([form, label]);
    }
  }
  variants.sort((a, b) => b[0].length - a[0].length);
  const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return (value) => {
    let text = JSON.stringify(value);
    for (const [form, label] of variants) {
      text = text.replace(new RegExp(`(\\\\\\\\\\\\\\\\\\?\\\\\\\\)?${escape(form)}`, "gi"), label);
    }
    text = text.replace(/[A-Za-z]:(\\\\|\/)Users(\\\\|\/)[^"\\/]+/g, "<home>");
    return JSON.parse(text);
  };
}

export function gitHead() {
  return execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
}
