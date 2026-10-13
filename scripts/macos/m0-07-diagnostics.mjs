#!/usr/bin/env node
/**
 * M0-07 on macOS: errors and diagnostics stay bounded, readable and masked with
 * multibyte Unicode across every truncation bound, a long error, a synthetic
 * secret and a stderr flood; nothing panics. The macOS port of
 * scripts/cdp-m0-07-diagnostics.mjs (same payload model, same bounds, same
 * verdicts), on an isolated test instance (scripts/macos/test-instance.mjs).
 * No model turn.
 *
 * Three launches of one instance on one data folder:
 *   reject  pinned 1.4.2. A project conversation in <run>/project. Its first
 *           send_input, the Retry and a composer follow-up are answered with
 *           forged engine rejections (5,000+ chars, emoji/CJK/combining marks
 *           across the 500-unit bound, token=SYNTH-SECRET-<hex> before, across
 *           and after it), inside the bridge's own IPC error envelope: the
 *           request is re-pointed at a session id the bridge does not know, so
 *           no engine sees it. Banner, unsent rows, composer line, web storage,
 *           the app data folder and Settings > Export diagnostics are scanned.
 *   stderr  fake engine (m0-07-08-fake-engine.mjs, mode flood): 237 KB of
 *           stderr (Unicode, secrets, a 100 KB line), one non-JSON stdout line,
 *           exit after the first request. The silent boot resume and an
 *           explicit Reconnect fail through the real stderr tail; pill, notice,
 *           recovery panel and export are scanned.
 *   verify  pinned 1.4.2 again: the conversation reconnects; web storage, the
 *           app data folder and the test WKWebView store on disk are scanned
 *           for the sentinel, as UTF-8 and UTF-16LE.
 *
 * The export is read from the Blob the page builds (URL.createObjectURL); the
 * anchor click that would save it is swallowed, so nothing is written to
 * ~/Downloads (out of bounds for these proofs).
 *
 *   node scripts/macos/m0-07-diagnostics.mjs --exe ~/muse-proofs/app/08b291d/muse-desktop
 *     [--port 9421] [--base $TMPDIR/muse-proofs-g2/m0-07]
 *     [--out docs/evidence/2026-10-13-macos-closure/m0-07-diagnostics.json]
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { INSTALL_IPC_TRACE, argValue, redactor, sleep, waitFor } from "../cdp-harness.mjs";
import { redactDiagnostic } from "../../src/lib/diagnostics.ts";
import { DEFAULT_ENGINE, engineVersion, launch } from "./test-instance.mjs";
import { newProjectConversation } from "./smoke-real-turn.mjs";

const EXE = resolve(argValue("--exe", join(homedir(), "muse-proofs", "app", "08b291d", "muse-desktop")));
const PORT = Number(argValue("--port", "9421"));
const BASE = resolve(argValue("--base", join(tmpdir(), "muse-proofs-g2", "m0-07")));
const OUT = argValue("--out", "docs/evidence/2026-10-13-macos-closure/m0-07-diagnostics.json");
const FAKE = fileURLToPath(new URL("./m0-07-08-fake-engine.mjs", import.meta.url));
const RUN = join(BASE, `run-${Date.now().toString(36)}`);
const PROJECT = join(RUN, "project");
const DATA = join(RUN, "data");
const CONTROL = join(RUN, "fake-mode");
const SENTINEL = `SYNTH-SECRET-${randomBytes(6).toString("hex")}`;
const SECRET = `token=${SENTINEL}`;
const redactPaths = redactor([[PROJECT, "<test project>"], [DATA, "<test data>"], [RUN, "<run>"], [BASE, "<proof>"]]
  .flatMap(([p, l]) => [[p, l], [`/private${p}`, l]]).concat([[homedir(), "~"]]));

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


// ---- page side ------------------------------------------------------------

/**
 * IPC layer above the shared trace: forged send rejections, full
 * resume_session bodies, export blobs. WKWebView's IPC is ipc://localhost; the
 * anchor click of a diagnostics or recovery export is swallowed (no download).
 */
const INSTALL_M007 = `(() => {
  const s = window.__m007 = window.__m007 || { forge: [], forged: [], full: [], blobs: [], swallowed: [] };
  if (s.installed) return 'already';
  s.installed = true;
  const inner = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = String(typeof input === 'string' ? input : (input && input.url) || input);
    const match = url.match(/^(?:https?:\\/\\/ipc\\.localhost|ipc:\\/\\/localhost)\\/([^/?#]+)/);
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
  const click = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    if (this.download && /^muse-desktop-/.test(this.download)) { s.swallowed.push(this.download); return; }
    return click.call(this);
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
    replacementChars: text.split("�").length - 1,
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

const calls = (app, cmd) => app.ev(`window.__baselineIpc.calls.filter((c) => c.cmd === ${JSON.stringify(cmd)})`);

async function selectConversation(app, sid) {
  await app.ev(page(`const b = document.querySelector('li.session-item[data-session-id="${sid}"] button.session-select'); if (b) b.click(); return !!b;`));
  return waitFor(() => app.ev(page(`return activeSid() === ${JSON.stringify(sid)} && !document.querySelector('.settings-panel');`)), 15_000, 300);
}

/** Settings > Export diagnostics: the Blob the page built (the download itself is swallowed). */
async function exportDiagnostics(app, label, sid) {
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
  const text = await waitFor(async () => (await app.ev(`window.__m007.blobs.slice(${blobsBefore})`))[0] ?? null, 10_000);
  const swallowed = await app.ev("window.__m007.swallowed.slice(-1)[0] || null");
  const native = await app.ev("window.__TAURI_INTERNALS__.invoke('collect_diagnostics')").catch((e) => ({ error: String(e.message ?? e) }));
  await selectConversation(app, sid);
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
  const nativeText = JSON.stringify(native);
  return {
    label,
    behavior: "Blob captured from URL.createObjectURL; anchor click swallowed",
    downloadName: swallowed ? swallowed.replace(/\d{4}-\d{2}-\d{2}/, "<date>") : null,
    blobBytes: text === null ? 0 : Buffer.byteLength(text),
    schema: parsed?.schema ?? null,
    keys: parsed ? Object.keys(parsed) : [],
    file: text === null ? null : {
      sentinel: text.includes(SENTINEL),
      replacementChars: text.split("�").length - 1,
      escapedLoneSurrogates: (text.match(/\\ud[89ab][0-9a-f]{2}(?!\\ud[c-f][0-9a-f]{2})|(?<!\\ud[89ab][0-9a-f]{2})\\ud[c-f][0-9a-f]{2}/gi) ?? []).length,
      rawLoneSurrogates: loneSurrogates(text),
    },
    lastError: textFacts(parsed?.lastError ?? null, 501),
    native: { schema: native?.schema ?? null, hostEngines: native?.hostEngines ?? null, sentinel: nativeText.includes(SENTINEL), loneSurrogates: loneSurrogates(nativeText), error: native?.error ?? null },
  };
}

/** localStorage + sessionStorage: keys holding a sentinel, lone surrogates in values. */
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

/** Byte scan of the given roots for the sentinel, as UTF-8 and UTF-16LE (and -BE). */
function scanFiles(roots, sentinels) {
  const needles = sentinels.flatMap((s) => [Buffer.from(s, "utf8"), Buffer.from(s, "utf16le"), Buffer.from(s, "utf16le").swap16()]);
  const out = { files: 0, bytes: 0, unreadable: 0, hits: [] };
  const walk = (label, root, dir) => {
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) { walk(label, root, path); continue; }
      if (!entry.isFile()) continue;
      let data;
      try { if (statSync(path).size > 64 * 1024 * 1024) continue; data = readFileSync(path); } catch { out.unreadable++; continue; }
      out.files++;
      out.bytes += data.length;
      if (needles.some((n) => data.includes(n))) out.hits.push(`${label}/${relative(root, path)}`);
    }
  };
  for (const [label, root] of roots) if (existsSync(root)) walk(label, root, root);
  return out;
}

async function instance(engine) {
  const inst = await launch({ exe: EXE, port: PORT, data: DATA, engine });
  await waitFor(() => inst.app.ev("Boolean(document.querySelector('.primary-nav'))"), 30_000);
  await inst.app.ev(INSTALL_IPC_TRACE);
  await inst.app.ev(INSTALL_M007);
  return inst;
}

// ---- phases -------------------------------------------------------------------

const state = {};

async function rejectPhase() {
  const forgedA = rejectionA();
  const forgedB = rejectionB();
  const result = { liveTurns: 0, forged: { A: rejectionFacts(forgedA), B: rejectionFacts(forgedB) } };
  mkdirSync(PROJECT, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: PROJECT });
  const inst = await instance(DEFAULT_ENGINE);
  const app = inst.app;
  result.isolation = inst.isolation;
  try {
    result.project = await newProjectConversation(app, PROJECT);
    // newProjectConversation re-installs the trace; the forge layer sits above it.
    await app.ev(INSTALL_M007);
    await app.ev(`(window.__m007.forge.push(${JSON.stringify(forgedA)}, ${JSON.stringify(forgedB)}), window.__m007.forge.length)`);
    const text = "M0-07 diagnostics probe: this first message is answered by a forged engine rejection.";
    await app.send("Input.insertText", { text });
    await waitFor(() => app.ev(`(() => { const b = document.querySelector('button.welcome-send'); return document.activeElement?.value === ${JSON.stringify(text)} && b && !b.disabled; })()`), 10_000, 100);
    await app.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", text: "\r" });
    await app.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter" });
    const started = await waitFor(async () => { const list = await calls(app, "start_session"); return list.at(-1)?.result ? list.at(-1) : null; }, 90_000);
    state.sid = started?.ok ? JSON.parse(started.result).session_id : null;
    if (!state.sid) throw new Error(`start_session failed: ${JSON.stringify(started)?.slice(0, 300)}`);
    result.sessionStarted = true;
    result.startedInTestFolder = started.args?.workspacePath === PROJECT || started.args?.workspacePath === `/private${PROJECT}`;
    await waitFor(() => app.ev(page("return q('.pending-send-error').length > 0;")), 20_000);
    await sleep(1_500);
    const bounds = { banner: 600, pending: 600, composerBlocked: 600 };
    result.afterA = surfaceFacts(await app.ev(SURFACES), bounds);
    await app.ev(page("const b = q('.pending-send button').find((n) => n.innerText.trim() === 'Retry'); if (b) b.click(); return !!b;"));
    await waitFor(async () => (await app.ev("window.__m007.forged.length")) >= 2, 20_000);
    await sleep(1_500);
    result.afterB = surfaceFacts(await app.ev(SURFACES), bounds);
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
    result.outboxMirror = scanFiles([["data", DATA]], [SENTINEL]);
    result.export = await exportDiagnostics(app, "after forged rejection B", state.sid);
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
    result.stop = await inst.stop({ keepStore: true });
  }
  return result;
}

async function stderrPhase() {
  if (!state.sid) throw new Error("no test conversation: the reject phase did not start one");
  const sid = state.sid;
  const payload = stderrPayload();
  writeFileSync(`${CONTROL}.stderr`, payload.stderr);
  writeFileSync(`${CONTROL}.stdout`, payload.stdout);
  writeFileSync(CONTROL, "flood");
  const result = { liveTurns: 0, payload: payload.facts };
  const inst = await instance(["node", FAKE, CONTROL, DEFAULT_ENGINE]);
  const app = inst.app;
  try {
    await waitFor(() => app.ev(page("return Boolean(document.querySelector('li.session-item'));")), 20_000);
    if ((await app.ev(page("return activeSid();"))) !== sid) await selectConversation(app, sid);
    result.bootNotice = Boolean(await waitFor(() => app.ev(page("return q('.connection-notice').length > 0;")), 60_000));
    await sleep(1_000);
    result.afterBootResume = surfaceFacts(await app.ev(SURFACES), { notice: 220 });
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
    result.export = await exportDiagnostics(app, "after the failed Reconnect", sid);
    result.appAliveAfterFlood = inst.child.exitCode === null;
    result.fakeSpawns = readFileSync(`${CONTROL}.log`, "utf8").trim().split("\n").length;
    result.consoleErrors = app.errors.slice(0, 10);
  } finally {
    result.stop = await inst.stop({ keepStore: true });
  }
  return result;
}

async function verifyPhase() {
  const sid = state.sid;
  const result = { liveTurns: 0 };
  const inst = await instance(DEFAULT_ENGINE);
  const app = inst.app;
  let end;
  try {
    await waitFor(() => app.ev(page("return Boolean(document.querySelector('li.session-item'));")), 20_000);
    if (sid && (await app.ev(page("return activeSid();"))) !== sid) await selectConversation(app, sid);
    const pill = () => app.ev(page("return document.querySelector('.connection-state')?.textContent.trim() || null;"));
    let connected = await waitFor(async () => (await pill()) === "Connected", 30_000, 1_000);
    if (!connected) {
      // The boot resume after a failure may leave the Reconnect to the user.
      await app.ev(page("const b = q('button.workspace-button').find((n) => /^Reconnect/.test(n.innerText.trim())); if (b) b.click(); return !!b;"));
      result.reconnectClicked = true;
      connected = await waitFor(async () => (await pill()) === "Connected", 90_000, 1_000);
    }
    result.reconnected = Boolean(connected);
    result.afterReconnect = surfaceFacts(await app.ev(SURFACES), { notice: 220 });
    result.webStorage = await scanWebStorage(app, [SENTINEL]);
    result.consoleErrors = app.errors.slice(0, 10);
  } finally {
    end = await inst.stop({ keepStore: true });
  }
  await sleep(1_500);
  result.appFiles = scanFiles([["data", DATA], ["webkit-store", inst.store]], [SENTINEL]);
  rmSync(inst.store, { recursive: true, force: true });
  end.testStoreDeleted = !existsSync(inst.store);
  result.stop = end;
  return result;
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
  const exportOk = (e) => Boolean(e) && e.blobBytes > 0 && e.schema === "muse-desktop.diagnostics.v1" && !e.file.sentinel
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
    } : {}),
    exportAndStorage: judge([r, s, v], r && s && v ? {
      exportAfterRejection: exportOk(r.export),
      exportAfterFlood: exportOk(s.export),
      webStorageWhileUnsent: r.storage.localStorage.sentinelKeys.length === 0 && r.storage.sessionStorage.sentinelKeys.length === 0,
      nativeOutboxMirrorWhileUnsent: r.outboxMirror.hits.length === 0,
      realEngineReconnected: v.reconnected === true,
      webStorageAtEnd: v.webStorage.localStorage.sentinelKeys.length === 0 && v.webStorage.sessionStorage.sentinelKeys.length === 0,
      appDataAndStoreFilesAtEnd: v.appFiles.hits.length === 0 && v.appFiles.unreadable === 0,
    } : {}),
  };
}

const METHOD = {
  forgedRejection: "Pinned 1.4.2, no turn. A project conversation created from the welcome screen; its first message typed and sent with a real Enter. The first send_input, the Retry and a composer follow-up are answered with forged engine rejections: the page-side fetch layer (Tauri's IPC transport, ipc://localhost on WKWebView) re-points the request at a session id the bridge does not know, keeps the bridge's own error envelope and replaces only its body with the text msp.rs returns for an MSP error frame (RpcError Display). Message A: 5,316 chars, emoji/CJK/combining marks, an emoji pair across unit 500 of the renderer's bound, token=SYNTH-SECRET-<hex> before and after. Message B: 5,315 chars, the secret value itself across unit 500 before redaction.",
  stderrFlood: "The same data folder relaunched on scripts/macos/m0-07-08-fake-engine.mjs (mode flood): 237,616 bytes of stderr (420 lines, one of 105,448 bytes, 423 secrets), one non-JSON stdout line, the first request read, exit 3; the real bridge pump, push_stderr, the 20-line tail and the handshake error carry it. The silent boot resume and an explicit Reconnect fail through that path. Emoji placed across UTF-8 byte 1000 of a line and byte 8000 of the tail (bridge cuts), unit 216 of the notice, unit 499 of the exported error and unit 3999 of the recovery panel; the bridge's message is compared with the harness model.",
  exportAndStorage: "Settings > Export diagnostics after each scenario: the Blob the page builds is read through URL.createObjectURL; collect_diagnostics read directly. localStorage and sessionStorage scanned live; at the end, after a graceful quit, the test data folder and the test WKWebView store on disk byte-scanned as UTF-8, UTF-16LE and UTF-16BE for the sentinel.",
};
const LIMITS = [
  "The export's save to disk is not driven: the anchor click that would download the file is swallowed so that nothing is written to ~/Downloads (out of bounds for these proofs). The content checked is the Blob the page hands to that click.",
  "Not driven natively, as on Windows: the turn/completed failure card (unit-tested) and the skill lane detail.",
  "No model turn; the engine's session store is shared with the user (ADR 0003): the test conversation lives there, its unsent probes discarded.",
];

async function main() {
  mkdirSync(RUN, { recursive: true });
  const run = { at: new Date().toISOString(), sentinelShape: "token=SYNTH-SECRET-<12 hex>", phases: {} };
  for (const [name, fn] of [["reject", rejectPhase], ["stderr", stderrPhase], ["verify", verifyPhase]]) {
    try {
      run.phases[name] = await fn();
    } catch (error) {
      run.phases[name] = { error: String(error?.message ?? error).slice(0, 400), appOutput: (error?.appOutput ?? []).slice(-10) };
    }
  }
  run.verdicts = verdicts(run);
  const doc = {
    schema: "muse-desktop.m0-07-diagnostics-macos.v1",
    ticket: "M0-07",
    date: new Date().toISOString().slice(0, 10),
    commit: "08b291d",
    platform: `macOS ${execFileSync("sw_vers", ["-productVersion"], { encoding: "utf8" }).trim()} (${execFileSync("sw_vers", ["-buildVersion"], { encoding: "utf8" }).trim()}), ${process.arch}, debug build with embedded frontend, WKWebView through the test bridge`,
    engine: engineVersion(),
    liveTurns: 0,
    harness: `scripts/macos/m0-07-diagnostics.mjs (+ scripts/macos/m0-07-08-fake-engine.mjs, mode flood), port ${PORT}`,
    isolation: { ...(run.phases.reject?.isolation ?? {}), stops: Object.fromEntries(Object.entries(run.phases).map(([k, p]) => [k, p.stop ?? null])) },
    method: METHOD,
    verdicts: run.verdicts,
    limits: LIMITS,
    run,
  };
  doc.summary = Object.fromEntries(Object.entries(run.verdicts).map(([k, v]) => [k, `${v.verdict}${v.failed?.length ? ` (${v.failed.join(", ")})` : v.reason ? ` (${v.reason})` : ""}`]));
  const scrubbed = JSON.parse(JSON.stringify(redactPaths(doc)).replaceAll(SENTINEL, "<SENTINEL>"));
  mkdirSync(join(OUT, ".."), { recursive: true });
  writeFileSync(OUT, `${JSON.stringify(scrubbed, null, 2)}\n`);
  console.log(JSON.stringify(scrubbed.summary, null, 2));
}

await main();
