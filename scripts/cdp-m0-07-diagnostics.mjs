#!/usr/bin/env node

/**
 * M0-07 native acceptance: errors and diagnostics stay bounded, readable and
 * masked with multibyte Unicode across every truncation bound, a long error, a
 * synthetic secret and a stderr flood; nothing panics. No model turn.
 *
 * Phases, each in its own launch of the dev build. Results merge into --out
 * (path-free; the synthetic secret is written as <SENTINEL>):
 *   reject  real engine. A test conversation in <base>\m0-07-project (the default
 *           folder is pointed there for the start, then restored: the project
 *           list is full). Its first send_input, the Retry and a composer
 *           follow-up are answered with forged engine rejections (5,000+ chars,
 *           emoji/CJK/combining marks across the 500-unit bound, a
 *           token=SYNTH-SECRET-<hex> value before, across and after it). The
 *           text is what msp.rs returns for an MSP error frame (RpcError
 *           Display, passed unchanged by send_input), inside the bridge's own
 *           IPC error envelope: the request is re-pointed at a session id the
 *           bridge does not know, so no engine sees it. The banner, the unsent
 *           message rows, the composer line, the stored outbox and Settings >
 *           Export diagnostics are scanned.
 *   stderr  fake engine. The sidecar the dev build spawns (debug\muse.exe) is
 *           backed up and replaced by a tiny fake that floods stderr (Unicode,
 *           secrets, a 100 KB line), prints one non-JSON stdout line and exits
 *           after the first request. The boot resume and an explicit Reconnect
 *           of the test conversation fail through the real stderr tail; the
 *           pill, the notice, the recovery panel and the export are scanned.
 *           The real binary is restored in a finally block and its SHA-256
 *           compared with src-tauri/binaries.
 *   verify  real engine. The test conversation reconnects; localStorage,
 *           sessionStorage and the app data folders are scanned for every
 *           sentinel this harness ever generated (kept in <base>).
 *   plan    no app: builds the payloads and prints the predicted straddles.
 *   verdict no app: recomputes the per-criterion verdicts of every run in --out.
 *
 * Usage:
 *   node scripts/cdp-m0-07-diagnostics.mjs [plan|verdict|reject|stderr|verify ...]   (default: reject stderr verify)
 *     [--base G:\muse-proofs\diagnostics] [--build pre-fix|fixed]
 *     [--exe G:\muse-build\cool-rubin-target\debug\muse-desktop.exe]
 *     [--out docs/evidence/2026-10-05-roadmap-closure/m0-07-diagnostics.json]
 * The harness launches and stops the app itself (MUSE_NO_AUTO_UPDATE=1, CDP on
 * MUSE_CDP_PORT or 9222) and refuses to run beside another muse-desktop process.
 */
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { copyFileSync, createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { INSTALL_IPC_TRACE, PORT, argValue, gitHead, openPage, redactor, sleep, waitFor } from "./cdp-harness.mjs";
import { redactDiagnostic } from "../src/lib/diagnostics.ts";

const VALUE_FLAGS = new Set(["--base", "--build", "--exe", "--out"]);
const ASKED = process.argv.slice(2).filter((arg, i, all) => !arg.startsWith("--") && !VALUE_FLAGS.has(all[i - 1]));
const PHASES = ASKED.length > 0 ? ASKED : ["reject", "stderr", "verify"];
const BASE = argValue("--base", "G:\\muse-proofs\\diagnostics");
const BUILD = argValue("--build", "fixed");
const EXE = argValue("--exe", "G:\\muse-build\\cool-rubin-target\\debug\\muse-desktop.exe");
const OUT = argValue("--out", "docs/evidence/2026-10-05-roadmap-closure/m0-07-diagnostics.json");
const TARGET = join(dirname(EXE), "muse.exe");
const REFERENCE = join("src-tauri", "binaries", "muse-x86_64-pc-windows-msvc.exe");
const BACKUP = join(BASE, "muse.exe.real");
const FAKE_EXE = join(BASE, "fake-muse.exe");
const PAYLOAD = join(BASE, "fake-payload");
const PROJECT = join(BASE, "m0-07-project");
const DOWNLOADS = join(BASE, "downloads");
const STATE_FILE = join(BASE, "harness-state.json");
const SHOTS = "docs/evidence/2026-10-05-roadmap-closure/shots";
const SENTINEL = `SYNTH-SECRET-${randomBytes(6).toString("hex")}`;
const SECRET = `token=${SENTINEL}`;
const redactPaths = redactor([[PROJECT, "<test project>"], [BASE, "<proof>"]]);

const readJson = (path, fallback) => { try { return JSON.parse(readFileSync(path, "utf8")); } catch { return fallback; } };
const state = () => readJson(STATE_FILE, {});
const saveState = (patch) => writeFileSync(STATE_FILE, JSON.stringify({ ...state(), ...patch }, null, 2));

// ---- text model ---------------------------------------------------------

const enc = new TextEncoder();
const dec = new TextDecoder();
const utf8 = (s) => enc.encode(s).length;
const isHigh = (c) => c >= 0xd800 && c <= 0xdbff;
const isLow = (c) => c >= 0xdc00 && c <= 0xdfff;
function loneSurrogates(s) {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (isHigh(c) && isLow(s.charCodeAt(i + 1))) i++;
    else if (isHigh(c) || isLow(c)) n++;
  }
  return n;
}

const CJK = "診断情報境界検査中文字符測試資料漢字";
const COMBINING = "e\u0301 a\u0308 n\u0303 \u0915\u094d\u0937 Z\u0351\u0352";
const RUN_EMOJI = "😀";
const WORDS = ["bounded", "diagnostics", "stderr", "flood", "engine", "rejection", "unicode", "line", "volume", "probe", "host", "tail"];
const GLYPHS = ["診断", "e\u0301", "𠜎", "🇫🇷", "👩\u200d💻", "👍🏽", "中文", "a\u0308", "𩸽", "クラッシュ", "🔐", "\u0915\u094d\u0937"];
/** Deterministic filler: ASCII words with one Unicode glyph every `every` tokens. */
function* tokens(every) {
  for (let i = 0; ; i++) yield i % every === every - 1 ? GLYPHS[(i / every | 0) % GLYPHS.length] : WORDS[i % WORDS.length];
}
/** Append filler while `measure` stays at or below `limit`. */
function fill(s, measure, limit, every = 4) {
  for (const tok of tokens(every)) {
    if (measure(`${s}${tok} `) > limit) return s;
    s += `${tok} `;
  }
  return s;
}
/** Start an emoji at UTF-16 index `target` of the measured string (a pair split by a cut there). */
function emojiAtUnit(s, measure, target) {
  if ((target - measure(s)) % 2 !== 0) s += "x";
  if (measure(s) > target) throw new Error(`unit target ${target} overshot`);
  return `${s}${RUN_EMOJI.repeat(Math.ceil((target - measure(s)) / 2) + 6)} `;
}
/** Put a 4-byte emoji across UTF-8 byte `target` of the measured string. */
function emojiAcrossByte(s, measure, target) {
  if ((target - measure(s)) % 4 === 0) s += "x";
  if (measure(s) >= target) throw new Error(`byte target ${target} overshot`);
  return `${s}${RUN_EMOJI.repeat(Math.ceil((target - measure(s)) / 4) + 4)} `;
}

// Renderer and bridge transforms, mirrored to predict where each bound falls.
const TOKEN_RE = /(["']?(?:token|access_token|refresh_token|api[_-]?key|secret|password)["']?\s*[:=]\s*)(["']?)[^\s,;}"']+\2/gi;
const normRedact = (s) => s.replace(/bearer\s+[^\s,;]+/gi, "Bearer [redacted]").replace(TOKEN_RE, "$1[redacted]").replace(/\s+/g, " ").trim();
const norm = (s) => s.replace(/\s+/g, " ").trim();
const at = (f) => (s) => f(`${s}|`).length - 1; // index where the next character lands
function rustTruncate(s, n) {
  const b = enc.encode(s);
  if (b.length <= n) return s;
  let end = n;
  while (end > 0 && (b[end] & 0xc0) === 0x80) end--;
  return `${dec.decode(b.subarray(0, end))}…`;
}
const rustRedact = (s) => s.replaceAll(SECRET, "token=[redacted]");
const lineOut = (l) => rustTruncate(rustRedact(l), 1000);
const RUST_PREFIX = "MSP handshake failed (sidecar dropped the response). Host stderr: ";
const RECONNECT = "Reconnect failed: ";
const SEND_PREFIX = "send_input failed: ";
const RPC_PREFIX = "MSP error -32000: ";
const RPC_SUFFIX = " [commandRejected] (m0_07_forged) [retryable=false]";
const continuation = (s, byte) => (enc.encode(s)[byte] & 0xc0) === 0x80;

/** Forged rejection A: an emoji pair across unit 499 of the redacted, normalized failure. */
function rejectionA() {
  const measure = at((s) => normRedact(`${SEND_PREFIX}${RPC_PREFIX}${s}`));
  let msg = `M0-07 forged engine rejection ${CJK} ${COMBINING} ${SECRET} `;
  msg = emojiAtUnit(fill(msg, measure, 495), measure, 499);
  for (const mark of [1500, 3000, 4500, 5200]) msg = `${fill(msg, (s) => s.length, mark)}${SECRET} `;
  return `${RPC_PREFIX}${msg}end-of-forged-rejection${RPC_SUFFIX}`;
}
/** Forged rejection B: the secret value itself spans unit 500 before redaction. */
function rejectionB() {
  const measure = at((s) => norm(`${SEND_PREFIX}${RPC_PREFIX}${s}`));
  let msg = `M0-07 forged engine rejection, retry ${CJK} ${COMBINING} `;
  msg = `${fill(msg, measure, 486)}${SECRET} `;
  for (const mark of [1500, 3000, 4500, 5200]) msg = `${fill(msg, (s) => s.length, mark)}${SECRET} `;
  return `${RPC_PREFIX}${msg}end-of-forged-rejection${RPC_SUFFIX}`;
}
function rejectionFacts(forged) {
  const failure = `${SEND_PREFIX}${forged}`;
  const normalized = normRedact(failure);
  const raw = norm(failure);
  const secretAt = raw.indexOf(SENTINEL);
  return {
    chars: forged.length,
    sentinels: forged.split(SENTINEL).length - 1,
    emojiAcrossUnit500: isHigh(normalized.charCodeAt(499)),
    secretAcrossUnit500BeforeRedaction: secretAt >= 0 && secretAt < 500 && secretAt + SENTINEL.length > 500,
    rendererBound: redactDiagnostic(failure)?.length ?? null,
  };
}

/** Fake engine output and the stderr tail the bridge must build from it. */
function stderrPayload() {
  const flood = [];
  for (let i = 0; i < 400; i++) {
    flood.push(`m0-07 flood ${i} ${SECRET} ${CJK} ${GLYPHS[i % GLYPHS.length]} ${COMBINING} ${"diagnostics line ".repeat(10)}`);
  }
  flood.push(`m0-07 huge line ${SECRET} ${`${CJK}😀e\u0301 `.repeat(1700)}`);

  // T1: the line right after "Host stderr: ". Unit 216 of the message is the
  // notice cut (217 kept), unit 499 of "Reconnect failed: ..." the export cut,
  // UTF-8 byte 1000 the bridge's per-line cut.
  const unitR = at((s) => `${RUST_PREFIX}${rustRedact(s)}`);
  const unitExport = at((s) => `${RECONNECT}${RUST_PREFIX}${rustRedact(s)}`);
  const byteLine = (s) => utf8(rustRedact(s));
  let t1 = `M0-07 stderr tail head ${SECRET} ${CJK} ${COMBINING} `;
  t1 = emojiAtUnit(fill(t1, unitR, 212), unitR, 216);
  t1 = emojiAtUnit(fill(t1, unitExport, 495), unitExport, 499);
  if (byteLine(t1) > 960) throw new Error("export target is too close to the per-line byte cut");
  t1 = emojiAcrossByte(fill(t1, byteLine, 992, 2), byteLine, 1000);
  t1 = fill(`${t1}${SECRET} `, byteLine, 1400);

  // T2..T19, then the non-JSON stdout line that lands last as "unparsable frame".
  // Unit 3999 of the sanitized "Reconnect failed: ..." is the recovery panel cut,
  // UTF-8 byte 8000 of the joined tail the bridge's total cut.
  const lines = [t1];
  const lineBytes = Math.floor((7700 - utf8(lineOut(t1)) - 3) / 18) - 3;
  const unitPanel = (partial) => at((s) => `${RECONNECT}${RUST_PREFIX}${[...lines.map(lineOut), rustRedact(s)].join(" | ")}`)(partial);
  let panelPlaced = false;
  for (let k = 2; k <= 19; k++) {
    let line = `M0-07 stderr tail ${k} ${SECRET} `;
    // Margin of one line head, so the next head cannot already pass the target.
    if (!panelPlaced && unitPanel(fill(line, (s) => utf8(rustRedact(s)), lineBytes, 6)) > 3999 - 80) {
      line = emojiAtUnit(fill(line, unitPanel, 3995, 6), unitPanel, 3999);
      panelPlaced = true;
    }
    lines.push(fill(line, (s) => utf8(rustRedact(s)), lineBytes, 6));
  }
  if (!panelPlaced) throw new Error("recovery panel target not reached");
  const tailBytes = (s) => utf8([...lines.map(lineOut), rustRedact(`unparsable frame: ${s}`)].join(" | "));
  let garbage = `M0-07 stdout garbage, not JSON ${SECRET} ${CJK} `;
  if (tailBytes(garbage) > 7960) throw new Error("the stderr lines leave no room for the total-cut target");
  garbage = emojiAcrossByte(fill(garbage, tailBytes, 7992, 3), tailBytes, 8000);
  garbage = fill(`${garbage}${SECRET} `, (s) => utf8(s), 900);

  const entries = [...lines, `unparsable frame: ${garbage}`];
  const tail = rustTruncate(entries.map(lineOut).join(" | "), 8000);
  const message = `${RUST_PREFIX}${tail}`;
  const reconnect = `${RECONNECT}${message}. Your saved messages are still available.`;
  return {
    stderr: `${[...flood, ...lines].join("\n")}\n`,
    stdout: `${garbage}\n`,
    message,
    facts: {
      stderrBytes: utf8(`${[...flood, ...lines].join("\n")}\n`),
      stderrLines: flood.length + lines.length,
      longestLineBytes: Math.max(...[...flood, ...lines].map(utf8)),
      stdoutBytes: utf8(garbage) + 1,
      sentinels: [...flood, ...lines, garbage].join("\n").split(SENTINEL).length - 1,
      predictedMessageUnits: message.length,
      predictedTailBytes: utf8(tail),
      emojiAcrossNoticeUnit216: isHigh(message.charCodeAt(216)),
      emojiAcrossExportUnit499: isHigh(normRedact(reconnect).charCodeAt(499)),
      emojiAcrossPanelUnit3999: isHigh(norm(reconnect.replace(/[\u0000-\u001f\u007f-\u009f\u200b\u200c\u200d\u2060\ufeff\ufffd]/g, " ")).charCodeAt(3999)),
      emojiAcrossLineByte1000: continuation(rustRedact(t1), 1000),
      emojiAcrossTailByte8000: continuation(entries.map(lineOut).join(" | "), 8000),
    },
  };
}

// ---- fake engine ----------------------------------------------------------

const FAKE_SOURCE = (payload) => `// M0-07 fake muse sidecar (scripts/cdp-m0-07-diagnostics.mjs): replays a
// recorded stderr flood and one non-JSON stdout line, reads the first MSP
// request without answering it, then exits.
use std::io::{BufRead, Write};
use std::time::Duration;

fn main() {
    let base = std::env::var("MUSE_M007_FAKE_PAYLOAD").unwrap_or_else(|_| ${JSON.stringify(payload)}.to_string());
    let err = std::fs::read(format!("{base}.stderr")).unwrap_or_else(|_| b"m0-07 fake sidecar: payload missing\\n".to_vec());
    let out = std::fs::read(format!("{base}.stdout")).unwrap_or_default();
    let _ = std::io::stderr().write_all(&err);
    std::thread::sleep(Duration::from_millis(300));
    let mut stdout = std::io::stdout();
    let _ = stdout.write_all(&out);
    let _ = stdout.flush();
    std::thread::sleep(Duration::from_millis(300));
    let mut line = String::new();
    let _ = std::io::stdin().lock().read_line(&mut line);
    std::thread::sleep(Duration::from_millis(200));
    std::process::exit(3);
}
`;

function buildFake() {
  const source = FAKE_SOURCE(PAYLOAD);
  const src = join(BASE, "fake-muse.rs");
  if (!existsSync(FAKE_EXE) || !existsSync(src) || readFileSync(src, "utf8") !== source) {
    writeFileSync(src, source);
    execFileSync("rustc", ["-O", "-o", FAKE_EXE, src], { cwd: BASE, stdio: "inherit" });
  }
}

async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

// ---- app lifecycle ----------------------------------------------------------

function ps(command) {
  // "exit 0": Get-Process finding nothing is an answer, not a failure.
  return execFileSync("powershell.exe", ["-NoProfile", "-Command", `${command}; exit 0`], { encoding: "utf8" }).trim();
}
const appProcesses = () => ps("Get-Process muse-desktop -ErrorAction SilentlyContinue | ForEach-Object { $_.Id }")
  .split(/\s+/).filter(Boolean).map(Number);
const targetProcesses = () => ps(`Get-Process muse -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq '${TARGET}' } | ForEach-Object { $_.Id }`)
  .split(/\s+/).filter(Boolean).map(Number);
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

let appPid = null;
async function launch(env = {}) {
  const foreign = appProcesses();
  if (foreign.length > 0) throw new Error(`blocked: foreign instance (${foreign.length} muse-desktop process not started by this harness)`);
  const child = spawn(EXE, [], {
    cwd: BASE,
    detached: true,
    stdio: "ignore",
    env: { ...process.env, MUSE_NO_AUTO_UPDATE: "1", WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`, ...env },
  });
  child.unref();
  appPid = child.pid;
  const app = await waitFor(async () => { try { return await openPage(); } catch { return null; } }, 60_000, 1_000);
  if (!app) throw new Error("the app page never reached CDP");
  await waitFor(() => app.ev("Boolean(document.querySelector('.primary-nav'))"), 30_000);
  await app.ev(INSTALL_IPC_TRACE);
  await app.ev(INSTALL_M007);
  return app;
}

/** Close this harness's instance (WM_CLOSE, then force) and any engine it left. */
async function stopApp(app) {
  app?.close();
  if (appPid === null) return null;
  const pid = appPid;
  appPid = null;
  try { execFileSync("taskkill", ["/PID", String(pid)], { stdio: "ignore" }); } catch { /* already gone */ }
  let graceful = Boolean(await waitFor(() => !alive(pid), 20_000));
  if (!graceful) {
    try { execFileSync("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore" }); } catch { /* gone */ }
    await waitFor(() => !alive(pid), 10_000);
  }
  await sleep(1_000);
  const leftovers = targetProcesses();
  for (const leftover of leftovers) { try { execFileSync("taskkill", ["/F", "/PID", String(leftover)], { stdio: "ignore" }); } catch { /* gone */ } }
  return { graceful, exited: !alive(pid), enginesLeftAndKilled: leftovers.length };
}

// ---- page side ------------------------------------------------------------

/** IPC layer above the shared trace: forged send rejections, full error bodies, export blobs. */
const INSTALL_M007 = `(() => {
  const s = window.__m007 = window.__m007 || { forge: [], forged: [], full: [], blobs: [] };
  if (s.installed) return 'already';
  s.installed = true;
  const inner = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = String(typeof input === 'string' ? input : (input && input.url) || input);
    const match = url.match(/^https?:\\/\\/ipc\\.localhost\\/([^/?#]+)/);
    const cmd = match ? decodeURIComponent(match[1]) : null;
    if (cmd === 'send_input' && s.forge.length > 0 && init && typeof init.body === 'string') {
      const forged = s.forge.shift();
      const args = JSON.parse(init.body);
      const real = await inner(input, { ...init, body: JSON.stringify({ ...args, sessionId: 'm0-07-no-such-session' }) });
      const realBody = await real.text();
      s.forged.push({ status: real.status, tauriResponse: real.headers.get('Tauri-Response'), contentType: real.headers.get('Content-Type'), realBody: realBody.slice(0, 200), forgedUnits: forged.length });
      return new Response(JSON.stringify(forged), { status: real.status, headers: real.headers });
    }
    const response = await inner(input, init);
    if (cmd === 'resume_session') {
      try { s.full.push({ cmd, ok: response.headers.get('Tauri-Response') === 'ok', body: await response.clone().text() }); } catch (error) { s.full.push({ cmd, unreadable: String(error) }); }
    }
    return response;
  };
  const createObjectURL = URL.createObjectURL.bind(URL);
  URL.createObjectURL = (object) => {
    if (object instanceof Blob) object.text().then((text) => s.blobs.push(text));
    return createObjectURL(object);
  };
  return 'installed';
})()`;

const H = `
  const vis = (n) => n && n.offsetParent !== null;
  const q = (s, root) => [...(root || document).querySelectorAll(s)].filter(vis);
  const setValue = (el, v) => {
    const P = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(P, 'value').set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const button = (text, root) => q('button', root).find((b) => (b.innerText || '').trim() === text) || null;
  const store = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key) || fallback); } catch { return null; } };
  const activeSid = () => document.querySelector('li.session-item.active')?.getAttribute('data-session-id') || null;
`;
const page = (body) => `(async () => { ${H} ${body} })()`;

/** Every error surface as exact text (textContent), plus the whole DOM for the sentinel scan. */
const SURFACES = page(`
  const texts = (sel) => [...document.querySelectorAll(sel)].map((n) => n.textContent);
  const pill = document.querySelector('.connection-state');
  return {
    activeSid: activeSid(),
    banner: texts('.error-banner > span'),
    pending: texts('.pending-send-error'),
    composerBlocked: texts('.mention-error'),
    notice: texts('.connection-notice'),
    pill: pill ? { text: pill.textContent.trim(), title: pill.getAttribute('title') } : null,
    panel: texts('.sidecar-error-message'),
    alerts: texts('[role="alert"]'),
    conversation: document.querySelector('main.conversation')?.textContent ?? '',
    dom: document.documentElement.outerHTML,
  };
`);

function textFacts(text, max) {
  if (typeof text !== "string") return null;
  const points = Array.from(text);
  return {
    units: text.length,
    bounded: max === undefined ? undefined : text.length <= max,
    loneSurrogates: loneSurrogates(text),
    replacementChars: text.split("\ufffd").length - 1,
    sentinel: text.includes(SENTINEL),
    redactedMarks: text.split("[redacted]").length - 1,
    head: points.slice(0, 100).join(""),
    end: points.slice(-40).join(""),
  };
}

function surfaceFacts(raw, bounds) {
  const out = { activeSid: raw.activeSid };
  for (const [key, max] of Object.entries(bounds)) {
    const value = raw[key];
    out[key] = Array.isArray(value) ? value.map((t) => textFacts(t, max)) : textFacts(value, max);
  }
  out.pillTitle = textFacts(raw.pill?.title ?? null, 220);
  out.pillText = raw.pill?.text ?? null;
  out.alerts = raw.alerts.map((t) => textFacts(t));
  out.domSentinel = raw.dom.includes(SENTINEL);
  out.conversationLoneSurrogates = loneSurrogates(raw.conversation);
  return out;
}

async function shot(app, selector, name) {
  const clip = await app.ev(page(`const n = q(${JSON.stringify(selector)})[0]; if (!n) return null; n.scrollIntoView({ block: 'center' });
    const r = n.getBoundingClientRect(); return { x: r.x, y: r.y, width: Math.min(r.width, 1400), height: Math.min(r.height, 900), scale: 1 };`));
  if (!clip || clip.width < 1 || clip.height < 1) return null;
  mkdirSync(SHOTS, { recursive: true });
  const capture = await app.send("Page.captureScreenshot", { format: "png", clip });
  writeFileSync(join(SHOTS, `${name}.png`), Buffer.from(capture.data, "base64"));
  return `shots/${name}.png`;
}

/**
 * Settings > Change folder, the OS dialog answered with `folder`. The project
 * list is full (5/5) with the user's and earlier campaigns' projects, so the
 * test conversation runs in the default folder, switched for the start only and
 * restored right after (the M3-07/08 harness does the same).
 */
async function setDefaultFolder(app, folder) {
  await app.ev(`(window.__baselineIpc.dialogQueue.push(${JSON.stringify(folder)}), true)`);
  return app.ev(page(`
    document.querySelector('button.account[aria-label="Settings"]')?.click();
    await new Promise((r) => setTimeout(r, 800));
    const b = q('.workspace-picker button.workspace-button')[0];
    if (!b) return { clicked: false, applied: false };
    b.click();
    await new Promise((r) => setTimeout(r, 1200));
    return { clicked: true, applied: store('muse-desktop.workspace.v1', 'null') === ${JSON.stringify(folder)} };
  `));
}

const calls = (app, cmd) => app.ev(`window.__baselineIpc.calls.filter((c) => c.cmd === ${JSON.stringify(cmd)})`);

/** Welcome screen in the default folder (no project) -> first message -> Start; the send is forged. */
async function startConversation(app, text) {
  await app.ev(page(`
    sessionStorage.removeItem('muse-desktop.welcome-environment');
    q('.primary-nav button').find((n) => /Automations/.test(n.innerText))?.click();
    await new Promise((r) => setTimeout(r, 700));
    q('.primary-nav button[aria-label="New conversation"]')[0]?.click();
    await new Promise((r) => setTimeout(r, 1200));
    return true;
  `));
  const picked = await app.ev(page(`
    const trigger = document.querySelector('.project-trigger-name')?.textContent.trim() ?? null;
    const runsInTestFolder = (document.body.innerText || '').includes(${JSON.stringify(`Runs in ${PROJECT.split(/[\\/]/).pop()} with the global settings`)});
    if (trigger !== 'Choose a project' || !runsInTestFolder) return { clicked: false, trigger, runsInTestFolder };
    setValue(document.querySelector('textarea[aria-label="Your first message"]'), ${JSON.stringify(text)});
    await new Promise((r) => setTimeout(r, 300));
    const start = document.querySelector('button.welcome-send');
    if (!start || start.disabled) return { clicked: false, trigger, runsInTestFolder, startDisabled: true };
    start.click();
    return { clicked: true };
  `));
  if (!picked.clicked) throw new Error(`refusing to start outside the test folder: ${JSON.stringify(picked)}`);
  const started = await waitFor(async () => {
    const list = await calls(app, "start_session");
    return list.length > 0 && list.at(-1).result ? list.at(-1) : null;
  }, 90_000);
  const sid = started?.ok ? JSON.parse(started.result).session_id : null;
  if (!sid) throw new Error(`start_session failed: ${JSON.stringify(started)?.slice(0, 300)}`);
  return { sid, startedInTestFolder: started.args?.workspacePath === PROJECT };
}

/** Sidebar click: also closes Settings (openPage("task")). */
async function selectConversation(app, sid) {
  await app.ev(page(`const b = document.querySelector('li.session-item[data-session-id="${sid}"] button.session-select'); if (b) b.click(); return !!b;`));
  return waitFor(() => app.ev(page(`return activeSid() === ${JSON.stringify(sid)} && !document.querySelector('.settings-panel');`)), 15_000, 300);
}

/** Settings > Export diagnostics, saved by WebView2 into <base>\downloads; the blob is kept as a cross-check. */
async function exportDiagnostics(app, label, sid) {
  mkdirSync(DOWNLOADS, { recursive: true });
  const name = `muse-desktop-diagnostics-${new Date().toISOString().slice(0, 10)}.json`;
  const file = join(DOWNLOADS, name);
  rmSync(file, { force: true });
  let behavior = "Browser.setDownloadBehavior";
  try { await app.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: DOWNLOADS }); }
  catch { behavior = "Page.setDownloadBehavior"; await app.send("Page.setDownloadBehavior", { behavior: "allow", downloadPath: DOWNLOADS }); }
  const blobsBefore = await app.ev("window.__m007.blobs.length");
  const clicked = await app.ev(page(`
    document.querySelector('button.account[aria-label="Settings"]')?.click();
    await new Promise((r) => setTimeout(r, 1000));
    const b = button('Export diagnostics');
    if (!b) return false;
    b.click();
    return true;
  `));
  if (!clicked) return { label, clicked: false };
  const saved = await waitFor(() => existsSync(file) && statSync(file).size > 0, 15_000);
  const blob = await waitFor(async () => (await app.ev(`window.__m007.blobs.slice(${blobsBefore})`))[0] ?? null, 5_000);
  const native = await app.ev("window.__TAURI_INTERNALS__.invoke('collect_diagnostics')").catch((e) => ({ error: String(e.message ?? e) }));
  await selectConversation(app, sid);
  const text = saved ? readFileSync(file, "utf8") : null;
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
  const nativeText = JSON.stringify(native);
  return {
    label,
    behavior,
    savedByWebView2: Boolean(saved),
    fileBytes: saved ? statSync(file).size : 0,
    fileEqualsBlob: text !== null && text === blob,
    schema: parsed?.schema ?? null,
    keys: parsed ? Object.keys(parsed) : [],
    file: text === null ? null : {
      sentinel: text.includes(SENTINEL),
      replacementChars: text.split("\ufffd").length - 1,
      escapedLoneSurrogates: (text.match(/\\ud[89ab][0-9a-f]{2}(?!\\ud[c-f][0-9a-f]{2})|(?<!\\ud[89ab][0-9a-f]{2})\\ud[c-f][0-9a-f]{2}/gi) ?? []).length,
      rawLoneSurrogates: loneSurrogates(text),
    },
    lastError: textFacts(parsed?.lastError ?? null, 501),
    native: { schema: native?.schema ?? null, hostEngines: native?.hostEngines ?? null, sentinel: nativeText.includes(SENTINEL), loneSurrogates: loneSurrogates(nativeText), error: native?.error ?? null },
  };
}

/** localStorage + sessionStorage: keys holding a sentinel (any run), lone surrogates in values. */
async function scanWebStorage(app, sentinels) {
  return app.ev(page(`
    const sentinels = ${JSON.stringify(sentinels)};
    const lone = (s) => { let n = 0; for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff && s.charCodeAt(i + 1) >= 0xdc00 && s.charCodeAt(i + 1) <= 0xdfff) i++;
      else if (c >= 0xd800 && c <= 0xdfff) n++; } return n; };
    const scan = (st) => { const hits = []; const loneKeys = []; let bytes = 0;
      for (let i = 0; i < st.length; i++) { const k = st.key(i); const v = st.getItem(k) || ''; bytes += v.length;
        if (sentinels.some((x) => v.includes(x) || k.includes(x))) hits.push(k);
        if (lone(v) > 0) loneKeys.push(k); }
      return { keys: st.length, units: bytes, sentinelKeys: hits, loneSurrogateKeys: loneKeys }; };
    return { localStorage: scan(localStorage), sessionStorage: scan(sessionStorage) };
  `));
}

/** App data folders, byte scan for every sentinel as UTF-8 and UTF-16LE. */
function scanAppFiles(sentinels) {
  const roots = [
    ["roaming", join(process.env.APPDATA ?? "", "com.muse.desktop")],
    ["local", join(process.env.LOCALAPPDATA ?? "", "com.muse.desktop")],
  ];
  const needles = sentinels.flatMap((s) => [Buffer.from(s, "utf8"), Buffer.from(s, "utf16le")]);
  const skip = /[\\/](Cache|Code Cache|GPUCache|DawnCache|DawnGraphiteCache|DawnWebGPUCache|GrShaderCache|ShaderCache|Crashpad)[\\/]/i;
  const out = { files: 0, bytes: 0, unreadable: 0, hits: [] };
  const walk = (label, root, dir) => {
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) { if (!skip.test(`${path}\\`)) walk(label, root, path); continue; }
      let data;
      try { if (statSync(path).size > 64 * 1024 * 1024) continue; data = readFileSync(path); } catch { out.unreadable++; continue; }
      out.files++;
      out.bytes += data.length;
      if (needles.some((n) => data.includes(n))) out.hits.push(`${label}/${relative(root, path).replaceAll("\\", "/")}`);
    }
  };
  for (const [label, root] of roots) if (existsSync(root)) walk(label, root, root);
  return out;
}

// ---- phases -------------------------------------------------------------------

async function rejectPhase() {
  const forgedA = rejectionA();
  const forgedB = rejectionB();
  const result = { liveTurns: 0, forged: { A: rejectionFacts(forgedA), B: rejectionFacts(forgedB) } };
  mkdirSync(PROJECT, { recursive: true });
  const app = await launch();
  let userFolder;
  try {
    result.schedules = await app.ev(page(`const list = store('muse-desktop.schedules.v1', '[]') || [];
      return { count: list.length, enabled: list.filter((s) => s && s.enabled).length };`));
    userFolder = await app.ev(page("return store('muse-desktop.workspace.v1', 'null');"));
    if (typeof userFolder !== "string") throw new Error("no default folder to restore afterwards; refusing to change it");
    saveState({ userFolder });
    result.defaultFolderSwitched = (await setDefaultFolder(app, PROJECT)).applied;
    if (!result.defaultFolderSwitched) throw new Error("could not point the default folder at the test folder");
    await app.ev(`(window.__m007.forge.push(${JSON.stringify(forgedA)}, ${JSON.stringify(forgedB)}), window.__m007.forge.length)`);
    const { sid, startedInTestFolder } = await startConversation(app, "M0-07 diagnostics probe: this first message is answered by a forged engine rejection.");
    saveState({ sid });
    result.sessionStarted = true;
    result.startedInTestFolder = startedInTestFolder;
    await waitFor(() => app.ev(page("return q('.pending-send-error').length > 0;")), 20_000);
    await sleep(1_500);
    const bounds = { banner: 600, pending: 600, composerBlocked: 600 };
    result.afterA = surfaceFacts(await app.ev(SURFACES), bounds);
    // Never write a picture of the synthetic secret.
    result.shotPending = result.afterA.pending.some((t) => t.sentinel) ? "skipped: shows the sentinel" : await shot(app, ".pending-send", `m0-07-a-pending-${BUILD}`);
    // Retry: the same entry is sent again and meets rejection B.
    await app.ev(page("const b = q('.pending-send button').find((n) => n.innerText.trim() === 'Retry'); if (b) b.click(); return !!b;"));
    await waitFor(async () => (await app.ev("window.__m007.forged.length")) >= 2, 20_000);
    await sleep(1_500);
    result.afterB = surfaceFacts(await app.ev(SURFACES), bounds);
    // A follow-up from the composer meets rejection A again: the composer's own refusal line.
    await app.ev(`(window.__m007.forge.push(${JSON.stringify(forgedA)}), true)`);
    result.followUp = await app.ev(page(`
      const field = document.querySelector('textarea[aria-label="Message Muse"]');
      if (!field) return { sent: false, reason: 'no composer' };
      setValue(field, 'M0-07 follow-up probe: answered by a forged engine rejection.');
      await new Promise((r) => setTimeout(r, 300));
      const send = document.querySelector('button.send');
      if (!send || send.disabled) return { sent: false, reason: 'send disabled' };
      send.click();
      return { sent: true };
    `));
    await waitFor(async () => (await app.ev("window.__m007.forged.length")) >= 3, 20_000);
    await sleep(1_500);
    result.afterComposer = surfaceFacts(await app.ev(SURFACES), bounds);
    result.envelopes = await app.ev("window.__m007.forged");
    result.sendCalls = (await calls(app, "send_input")).map((c) => ({ ok: c.ok, sessionRedirected: c.args?.sessionId === "m0-07-no-such-session" }));
    await sleep(2_000);
    result.storage = await scanWebStorage(app, [SENTINEL]);
    result.outboxMirror = scanAppFiles([SENTINEL]);
    result.export = await exportDiagnostics(app, "after forged rejection B", sid);
    // Cleanup: discard the unsent probes and the composer draft so nothing can resend them later.
    for (let i = 0; i < 4; i++) {
      const discarded = await app.ev(page("const b = q('.pending-send button').find((n) => n.innerText.trim() === 'Discard'); if (b) b.click(); return !!b;"));
      if (!discarded) break;
      await sleep(800);
    }
    await app.ev(page("const f = document.querySelector('textarea[aria-label=\"Message Muse\"]'); if (f) setValue(f, ''); return true;"));
    await sleep(1_500);
    result.afterDiscard = await scanWebStorage(app, [SENTINEL]);
    result.consoleErrors = app.errors.slice(0, 10);
  } finally {
    if (typeof userFolder === "string" && result.defaultFolderSwitched !== undefined) {
      result.defaultFolderRestored = (await setDefaultFolder(app, userFolder).catch(() => ({ applied: false }))).applied;
      const sid = state().sid;
      if (sid) await selectConversation(app, sid).catch(() => null);
    }
    result.stop = await stopApp(app);
  }
  return result;
}

async function stderrPhase() {
  const sid = state().sid;
  if (!sid) throw new Error("no test conversation: run the reject phase first");
  const payload = stderrPayload();
  writeFileSync(`${PAYLOAD}.stderr`, payload.stderr);
  writeFileSync(`${PAYLOAD}.stdout`, payload.stdout);
  buildFake();
  const result = { liveTurns: 0, payload: payload.facts, binary: {} };
  if (targetProcesses().length > 0) throw new Error("blocked: an engine runs from the debug sidecar path");
  const reference = await sha256(REFERENCE);
  const before = await sha256(TARGET);
  result.binary.targetMatchedReferenceBefore = before === reference;
  if (before !== reference) throw new Error("debug\\muse.exe differs from src-tauri/binaries before the swap; refusing to touch it");
  if (!existsSync(BACKUP) || (await sha256(BACKUP)) !== reference) copyFileSync(TARGET, BACKUP);
  result.binary.backupMatchesReference = (await sha256(BACKUP)) === reference;
  if (!result.binary.backupMatchesReference) throw new Error("backup copy failed");
  let app = null;
  try {
    copyFileSync(FAKE_EXE, TARGET);
    result.binary.fakeInstalled = true;
    app = await launch({ MUSE_M007_FAKE_PAYLOAD: PAYLOAD });
    // Boot resume of the open conversation: silent, so only the pill and notice speak.
    await waitFor(() => app.ev(page("return Boolean(document.querySelector('li.session-item'));")), 20_000);
    if ((await app.ev(page("return activeSid();"))) !== sid) await selectConversation(app, sid);
    result.bootNotice = await waitFor(() => app.ev(page("return q('.connection-notice').length > 0;")), 60_000);
    await sleep(1_000);
    result.afterBootResume = surfaceFacts(await app.ev(SURFACES), { notice: 220 });
    // Explicit Reconnect: the same failure, now also in the recovery panel and the error state.
    await app.ev(page("const b = q('button.workspace-button').find((n) => /^Reconnect/.test(n.innerText.trim())); if (b) b.click(); return !!b;"));
    await waitFor(async () => (await app.ev("window.__m007.full.filter((c) => c.cmd === 'resume_session').length")) > 0, 60_000);
    await waitFor(() => app.ev(page("return q('.sidecar-error-message').length > 0;")), 15_000);
    await sleep(1_000);
    result.afterReconnect = surfaceFacts(await app.ev(SURFACES), { notice: 220, panel: 4000, banner: 600 });
    const resume = (await app.ev("window.__m007.full.filter((c) => c.cmd === 'resume_session')")).at(-1);
    const bridgeError = resume && !resume.ok ? JSON.parse(resume.body) : null;
    result.bridgeError = {
      ...textFacts(bridgeError),
      utf8Bytes: bridgeError === null ? null : utf8(bridgeError),
      tailUtf8Bytes: bridgeError === null ? null : utf8(bridgeError.slice(RUST_PREFIX.length)),
      equalsPrediction: bridgeError === payload.message,
    };
    if (bridgeError !== null && bridgeError !== payload.message) {
      const got = Array.from(bridgeError);
      const want = Array.from(payload.message);
      result.bridgeError.firstDifferenceAtCodePoint = got.findIndex((ch, n) => ch !== want[n]);
    }
    result.shotNotice = await shot(app, ".connection-notice", `m0-07-b-notice-${BUILD}`);
    result.export = await exportDiagnostics(app, "after the failed Reconnect", sid);
    result.appAliveAfterFlood = alive(appPid);
    result.consoleErrors = app.errors.slice(0, 10);
  } finally {
    result.stop = await stopApp(app);
    for (const pid of targetProcesses()) { try { execFileSync("taskkill", ["/F", "/PID", String(pid)], { stdio: "ignore" }); } catch { /* gone */ } }
    copyFileSync(BACKUP, TARGET);
    result.binary.restored = (await sha256(TARGET)) === (await sha256(REFERENCE));
    if (!result.binary.restored) copyFileSync(REFERENCE, TARGET);
    result.binary.restoredAfterFallback = (await sha256(TARGET)) === (await sha256(REFERENCE));
  }
  return result;
}

async function verifyPhase() {
  const sid = state().sid;
  const sentinels = state().sentinels ?? [];
  const result = { liveTurns: 0, sentinelsScanned: sentinels.length };
  const app = await launch();
  try {
    await waitFor(() => app.ev(page("return Boolean(document.querySelector('li.session-item'));")), 20_000);
    if (sid && (await app.ev(page("return activeSid();"))) !== sid) await selectConversation(app, sid);
    result.reconnected = Boolean(await waitFor(() => app.ev(page("return document.querySelector('.connection-state')?.textContent.trim() === 'Connected';")), 90_000, 1_000));
    result.afterReconnect = surfaceFacts(await app.ev(SURFACES), { notice: 220 });
    result.webStorage = await scanWebStorage(app, sentinels);
  } finally {
    result.stop = await stopApp(app);
  }
  result.appFiles = scanAppFiles(sentinels);
  return result;
}

function engineVersion() {
  try {
    return execFileSync(REFERENCE, ["--version"], { encoding: "utf8", env: { ...process.env, MUSE_NO_AUTO_UPDATE: "1" } }).trim();
  } catch { return null; }
}

/** Per-criterion verdict from the recorded facts only; each failing check is named. */
function verdicts(run) {
  const p = run.phases ?? {};
  const clean = (t, max) => Boolean(t) && t.loneSurrogates === 0 && !t.sentinel && t.replacementChars === 0 && (max === undefined || t.units <= max);
  const all = (list, max) => Array.isArray(list) && list.length > 0 && list.every((t) => clean(t, max));
  const judge = (phases, checks) => {
    if (phases.some((x) => !x || x.error)) return { verdict: "blocked", reason: phases.map((x) => x?.error ?? (x ? null : "phase not run")).find(Boolean) };
    const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name);
    return { verdict: failed.length === 0 ? "pass" : "fail", failed };
  };
  const { reject: r, stderr: s, verify: v } = p;
  const exportOk = (e) => Boolean(e) && e.savedByWebView2 && e.fileEqualsBlob && e.schema === "muse-desktop.diagnostics.v1" && !e.file.sentinel
    && e.file.escapedLoneSurrogates === 0 && e.file.rawLoneSurrogates === 0 && e.file.replacementChars === 0
    && clean(e.lastError, 501) && !e.native.sentinel && e.native.loneSurrogates === 0;
  const views = r ? [r.afterA, r.afterB, r.afterComposer] : [];
  return {
    forgedRejection: judge([r], r ? {
      inputsAsDesigned: r.forged.A.chars >= 5000 && r.forged.B.chars >= 5000 && r.forged.A.emojiAcrossUnit500 && r.forged.B.secretAcrossUnit500BeforeRedaction,
      noEngineReached: (r.sendCalls ?? []).length === 3 && r.sendCalls.every((c) => c.sessionRedirected && !c.ok),
      bannerBoundedReadableMasked: views.every((x) => x && all(x.banner, 600)) && r.afterA.banner[0].head.includes("M0-07 forged engine rejection"),
      unsentRowBoundedMasked: views.every((x) => x && all(x.pending, 600)),
      composerLineBoundedMasked: all(r.afterComposer?.composerBlocked, 600),
      noSecretInDom: views.every((x) => x && !x.domSentinel),
      noLoneSurrogateInConversation: views.every((x) => x && x.conversationLoneSurrogates === 0),
    } : {}),
    stderrFlood: judge([s], s ? {
      floodAsDesigned: Object.entries(s.payload).filter(([k]) => k.startsWith("emojiAcross")).every(([, ok]) => ok) && s.payload.stderrLines >= 400,
      bridgeTailBoundedMasked: s.bridgeError.tailUtf8Bytes <= 8003 && s.bridgeError.redactedMarks > 0 && clean(s.bridgeError),
      bridgeMatchesModel: s.bridgeError.equalsPrediction === true,
      noPanic: s.appAliveAfterFlood === true,
      noticeAndPillBoundedMasked: all(s.afterBootResume.notice, 220) && clean(s.afterBootResume.pillTitle, 220) && all(s.afterReconnect.notice, 220) && clean(s.afterReconnect.pillTitle, 220),
      recoveryPanelBoundedMasked: all(s.afterReconnect.panel, 4000),
      noSecretInDom: !s.afterBootResume.domSentinel && !s.afterReconnect.domSentinel,
      realEngineRestored: s.binary.restored === true,
    } : {}),
    exportAndStorage: judge([r, s, v], r && s && v ? {
      exportAfterRejection: exportOk(r.export),
      exportAfterFlood: exportOk(s.export),
      webStorageWhileUnsent: r.storage.localStorage.sentinelKeys.length === 0 && r.storage.sessionStorage.sentinelKeys.length === 0,
      nativeOutboxMirrorWhileUnsent: r.outboxMirror.hits.length === 0,
      webStorageAtEnd: v.webStorage.localStorage.sentinelKeys.length === 0 && v.webStorage.sessionStorage.sentinelKeys.length === 0,
      appDataFilesAtEnd: v.appFiles.hits.length === 0 && v.appFiles.unreadable === 0,
    } : {}),
  };
}

/** One line per criterion across the recorded builds, e.g. "fixed: pass; pre-fix: fail (...)". */
function summarize(doc) {
  const builds = Object.entries(doc.runs).sort(([a], [b]) => (a === "fixed" ? -1 : b === "fixed" ? 1 : a.localeCompare(b)));
  doc.summary = Object.fromEntries(["forgedRejection", "stderrFlood", "exportAndStorage"].map((criterion) => [criterion, builds
    .map(([build, run]) => {
      const v = run.verdicts?.[criterion];
      return v ? `${build}: ${v.verdict}${v.failed?.length ? ` (${v.failed.join(", ")})` : v.reason ? ` (${v.reason})` : ""}` : `${build}: not judged`;
    }).join("; ")]));
}

function record(run) {
  const scrub = (value) => JSON.parse(JSON.stringify(redactPaths(value)).replaceAll(SENTINEL, "<SENTINEL>"));
  const doc = readJson(OUT, {
    schema: "muse-desktop.m0-07-diagnostics.v1",
    ticket: "M0-07",
    platform: "Windows 11 (26200), debug build with embedded frontend, WebView2 over CDP",
    runs: {},
  });
  doc.date = new Date().toISOString().slice(0, 10);
  doc.commit = gitHead();
  doc.engine = engineVersion();
  doc.runs[BUILD] = scrub({ ...run, verdicts: verdicts(run) });
  doc.liveTurns = Object.values(doc.runs).reduce((n, r) => n + Object.values(r.phases ?? {}).reduce((m, p) => m + (p.liveTurns ?? 0), 0), 0);
  summarize(doc);
  writeFileSync(OUT, `${JSON.stringify(doc, null, 2)}\n`);
}

async function main() {
  mkdirSync(BASE, { recursive: true });
  if (PHASES.includes("verdict")) {
    // Recompute the verdicts of every recorded run without launching anything.
    const doc = readJson(OUT, null);
    if (!doc) throw new Error(`no record at ${OUT}`);
    for (const run of Object.values(doc.runs)) run.verdicts = verdicts(run);
    summarize(doc);
    writeFileSync(OUT, `${JSON.stringify(doc, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(doc.summary, null, 2)}\n`);
    return;
  }
  if (PHASES.includes("plan")) {
    const p = stderrPayload();
    process.stdout.write(`${JSON.stringify({ rejectA: rejectionFacts(rejectionA()), rejectB: rejectionFacts(rejectionB()), stderr: p.facts }, null, 2)}\n`);
    return;
  }
  saveState({ sentinels: [...new Set([...(state().sentinels ?? []), SENTINEL])] });
  const run = { build: BUILD, at: new Date().toISOString(), sentinelShape: "token=SYNTH-SECRET-<12 hex>", phases: {} };
  const table = { reject: rejectPhase, stderr: stderrPhase, verify: verifyPhase };
  for (const phase of PHASES) {
    if (!table[phase]) throw new Error(`unknown phase ${phase}`);
    try {
      run.phases[phase] = await table[phase]();
    } catch (error) {
      run.phases[phase] = { error: String(error?.message ?? error).slice(0, 400) };
      if (appPid !== null) run.phases[phase].stop = await stopApp(null);
      if (/^blocked/.test(run.phases[phase].error)) break;
    }
    record(run);
  }
  record(run);
  process.stdout.write(`${JSON.stringify(redactPaths(run), null, 2).replaceAll(SENTINEL, "<SENTINEL>")}\n`);
}

await main();
