#!/usr/bin/env node

/**
 * M0-04 native acceptance: Stop from the UI, with a call trace.
 *
 * The host contract is proven (`turn/completed` arrives ~36 ms after a
 * `turn/interrupt` that carries a `turnId` — see
 * docs/evidence/2026-09-27-qualif-native/session-log-expique-tout.md). What
 * remained unexplained was the UI observation: a `Stopping…` that never
 * resolves. This scenario reproduces the stop **from the webview** and records
 * exactly what the renderer asked the bridge to do:
 *
 *   1. start a conversation with a deliberately long turn;
 *   2. wrap `__TAURI_INTERNALS__.invoke` to record every command + argument;
 *   3. press the UI Stop control;
 *   4. observe until the stopping state resolves (or the bound expires);
 *   5. prove the session still works afterwards (the "reprendre" half).
 *
 * Requires the dev build with
 * `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222`.
 *
 * Usage:
 *   node scripts/cdp-stop-terminal.mjs [--prompt "..."] [--observe-ms 30000]
 *   MUSE_CDP_PORT overrides the CDP port (default 9222).
 */
import { argv, exit } from "node:process";
import { pathToFileURL } from "node:url";
import { mkdir, writeFile } from "node:fs/promises";

const PORT = Number(process.env.MUSE_CDP_PORT ?? 9222);
const PROMPT = readFlag("--prompt")
  ?? "Write a very long, detailed 3000-word science fiction story. Do not stop early; write the full length.";
const FOLLOWUP = readFlag("--followup") ?? "Reply with exactly the word: READY";
const OBSERVE_MS = Number(readFlag("--observe-ms") ?? 30_000);
const SHOT_DIR = readFlag("--shots") ?? "docs/evidence/2026-09-27-qualif-native/shots";
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function readFlag(name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

export async function pageTarget() {
  const response = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  const targets = await response.json();
  const page = targets.find((t) => t.type === "page" && typeof t.webSocketDebuggerUrl === "string");
  if (!page) throw new Error(`no CDP page target on ${PORT}`);
  return page;
}

export function connect(url) {
  const socket = new WebSocket(url);
  let nextId = 1;
  const pending = new Map();
  const ready = new Promise((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("CDP socket error")), { once: true });
  });
  socket.addEventListener("message", (event) => {
    let frame;
    try { frame = JSON.parse(typeof event.data === "string" ? event.data : ""); } catch { return; }
    if (frame.id === undefined) return;
    const entry = pending.get(frame.id);
    if (!entry) return;
    pending.delete(frame.id);
    clearTimeout(entry.timer);
    if (frame.error) entry.reject(new Error(`${frame.method}: ${frame.error.message}`));
    else entry.resolve(frame.result);
  });
  return {
    ready,
    send(method, params = {}) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method}: timed out`)); }, 30_000);
        pending.set(id, { resolve, reject, method, timer });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    close() { try { socket.close(); } catch { /* closed */ } },
  };
}

async function evaluate(client, expression) {
  const wrapped = `(() => { try { return JSON.stringify(${expression}); }
    catch (error) { return JSON.stringify({ __error: String(error && error.message || error) }); } })()`;
  const result = await client.send("Runtime.evaluate", {
    expression: wrapped, returnByValue: true, awaitPromise: true,
  });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? "eval failed");
  const text = result.result?.value;
  if (typeof text !== "string") return null;
  const parsed = JSON.parse(text);
  if (parsed && typeof parsed === "object" && "__error" in parsed) throw new Error(parsed.__error);
  return parsed;
}

async function shot(client, name) {
  await mkdir(SHOT_DIR, { recursive: true });
  const capture = await client.send("Page.captureScreenshot", { format: "png" });
  const file = `${SHOT_DIR}/${name}.png`;
  await writeFile(file, Buffer.from(capture.data, "base64"));
  return file;
}

const PAGE = `
  const byText = (label, role) => [...document.querySelectorAll(role || 'button, a, [role="button"], summary')]
    .filter((node) => (node.innerText || '').trim().toLowerCase().includes(label.toLowerCase()))
    .filter((node) => node.offsetParent !== null);
  const byLabel = (label) => [...document.querySelectorAll('button')]
    .filter((node) => ((node.getAttribute('aria-label') || node.getAttribute('title') || '')).toLowerCase().includes(label.toLowerCase()))
    .filter((node) => node.offsetParent !== null);
  const composer = () => document.querySelector('textarea')
    || document.querySelector('[contenteditable="true"]');
  const uiState = () => {
    const text = (document.body.innerText || '').replace(/\\s+/g, ' ');
    const field = composer();
    const health = document.querySelector('.stream-health');
    return {
      stopping: /stopping/i.test(text),
      stoppingBanner: /waiting for the desktop host/i.test(text),
      stale: /no recent host update/i.test(text),
      // "working" is read from the liveness row itself: an earlier regex or a
      // title-based probe matched stale subagent lanes ("stop it first") and
      // reported false positives.
      working: health ? /is working|starting/i.test(health.innerText) : false,
      healthClass: health ? health.className : null,
      healthText: health ? health.innerText.replace(/\\s+/g, ' ').slice(0, 160) : null,
      ready: /\\bready\\b/i.test(text),
      composerDisabled: field ? field.disabled === true : null,
      buttons: byText('', 'button').map((n) => (n.innerText || '').trim()).filter(Boolean).slice(0, 30),
      labelled: [...document.querySelectorAll('button')].filter((b) => b.offsetParent !== null)
        .map((b) => b.getAttribute('aria-label') || '').filter(Boolean).slice(0, 30),
    };
  };
`;

async function main() {
  const target = await pageTarget();
  const client = connect(target.webSocketDebuggerUrl);
  await client.ready;

  const report = { schema: "muse-desktop.cdp-stop-terminal.v1", steps: [] };

  // Install the IPC trace BEFORE any scenario action. Measured on this build:
  // `__TAURI_INTERNALS__` is a Proxy that rejects monkey-patching of `invoke`,
  // `chrome.webview.postMessage` is bypassed (0 frames), and the real IPC
  // transport is **`window.fetch`** (153 calls / 65 s of ordinary traffic).
  // Every invoke is a fetch whose URL carries the command and whose body
  // carries the arguments.
  const install = await evaluate(client, `(() => {
    if (window.__museIpcTraceV === 2) return { installed: 'already' };
    if (typeof window.fetch !== 'function') return { installed: false };
    window.__museIpcTrace = { out: [], polls: 0 };
    const t0 = Date.now();
    const original = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const url = String(typeof input === 'string' ? input : (input && input.url) || input);
      let cmd = null; let payload = null; let raw = null;
      try {
        const body = (init && init.body) || (input && typeof input === 'object' && 'body' in input ? input.body : null);
        if (typeof body === 'string' && body.length < 200_000) {
          raw = body.slice(0, 400);
          const frame = JSON.parse(body);
          if (frame && typeof frame === 'object' && !('since' in frame)) payload = frame;
        }
      } catch { /* not JSON */ }
      // Tauri v2 custom-protocol IPC carries the command in the URL path:
      // "http://ipc.localhost/{cmd}/{callback}/{error}" with the args as body.
      const match = url.match(/^https?:\\/\\/ipc\\.localhost\\/([^/?#]+)/);
      if (match) cmd = decodeURIComponent(match[1]);
      const isPoll = payload && typeof payload === 'object' && 'since' in payload;
      if (isPoll) {
        window.__museIpcTrace.polls += 1;
        return original(input, init);
      }
      const entry = { atMs: Date.now() - t0, cmd, url: url.slice(0, 120), payload, raw: cmd ? null : raw };
      window.__museIpcTrace.out.push(entry);
      const response = await original(input, init);
      try {
        entry.result = (await response.clone().text()).slice(0, 400);
      } catch { /* unreadable response */ }
      return response;
    };
    window.__museIpcTraceV = 2;
    return { installed: true };
  })()`);
  report.install = install;

  // 1. Fresh conversation, then fill and send.
  await evaluate(client, `(() => { ${PAGE}
    const node = byText('new conversation')[0];
    if (node) node.click();
    return { clicked: !!node };
  })()`);
  await sleep(1_000);
  const filled = await evaluate(client, `(() => {
    ${PAGE}
    const field = composer();
    if (!field) return { filled: false };
    const proto = field.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(field, ${JSON.stringify(PROMPT)});
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.focus();
    return { filled: true };
  })()`);
  const startClick = await evaluate(client, `(() => {
    ${PAGE}
    const start = byText('start conversation')[0];
    const send = document.querySelector('button.send');
    const node = start || send;
    if (!node) return { clicked: false, buttons: uiState().buttons };
    node.click();
    return { clicked: true, label: (node.getAttribute('aria-label') || node.innerText || '').trim() };
  })()`);
  report.steps.push({ step: "conversation started", filled, ...startClick });

  // 2. Wait until a turn is live on the wire.
  let turnId = null;
  let observedSend = null;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const probe = await evaluate(client, `(() => {
      ${PAGE}
      const trace = window.__museIpcTrace || { out: [], in: [] };
      const findTurnId = (value, depth) => {
        if (value === null || value === undefined || depth > 5) return null;
        if (typeof value === 'string') {
          const match = value.match(/"turnId"\\s*:\\s*"([^"]+)"/);
          return match ? match[1] : null;
        }
        if (typeof value !== 'object') return null;
        if (typeof value.turnId === 'string' && value.turnId) return value.turnId;
        for (const key of Object.keys(value)) {
          const found = findTurnId(value[key], depth + 1);
          if (found) return found;
        }
        return null;
      };
      const interesting = trace.out.filter((e) => e.cmd && /send|start_session|turn/i.test(e.cmd));
      return {
        ui: uiState(),
        turnId: findTurnId(interesting.map((e) => e.payload), 0) || findTurnId(interesting.map((e) => e.result), 0),
        interesting,
      };
    })()`);
    if (probe.turnId) { turnId = probe.turnId; observedSend = probe.interesting; break; }
    if (probe.interesting.length && !observedSend) observedSend = probe.interesting;
    await sleep(500);
  }
  report.steps.push({ step: "turn observed", turnId, wireCalls: observedSend });
  report.uiBeforeStop = await evaluate(client, `(() => { ${PAGE} return uiState(); })()`);
  report.shotBeforeStop = await shot(client, "m0-04-1-before-stop");

  // Optional delay so the stop can be aimed at a specific phase — e.g. wait
  // for a long-running tool to start before pressing Stop ("during a tool").
  const STOP_AFTER_MS = Number(process.env.MUSE_STOP_AFTER_MS ?? 0);
  if (STOP_AFTER_MS > 0) await sleep(STOP_AFTER_MS);

  // 3. Press Stop from the UI. The turn-level control is `button.quiet`
  // labelled "Stop"; other "Stop" candidates are subagent lanes
  // (`title="subagent/stop"`) and the sidecar panel — and one disabled button
  // whose title merely contains "stop it first" fooled an earlier selector.
  // The turn-level button renders only once the working state does, which can
  // lag the `send_input` acknowledgement by a few seconds (measured: absent at
  // +2.4 s), so poll until it appears.
  let stopClick = { clicked: false };
  const stopDeadline = Date.now() + 20_000;
  while (Date.now() < stopDeadline) {
    stopClick = await evaluate(client, `(() => {
      ${PAGE}
      const candidates = [...document.querySelectorAll('button')]
        .filter((b) => /^stop/i.test((b.innerText || '').trim()) && b.disabled !== true);
      // Measured DOM: the turn-level control is the enabled "Stop" of the
      // composer working row — title "Stop the current turn" (it used to read
      // the misleading "Stop the running sidecar", kept here as a fallback so
      // older builds stay replayable). Subagent lanes carry title
      // "subagent/stop" and are excluded. A previous selector rejected the
      // real button BECAUSE of its "sidecar" title — do not repeat.
      const node = candidates.find((b) => /stop the (current turn|running sidecar)/i.test(b.getAttribute('title') || ''))
        || candidates.find((b) => b.classList.contains('quiet'))
        || candidates.find((b) => !/subagent\\/stop/i.test(b.getAttribute('title') || ''));
      if (!node) return { clicked: false, candidates: candidates.map((b) => (b.getAttribute('title') || b.innerText || '').trim()) };
      node.click();
      return { clicked: true, label: (node.getAttribute('aria-label') || node.innerText || '').trim(), title: node.getAttribute('title'), cls: node.className };
    })()`);
    if (stopClick.clicked) break;
    await sleep(500);
  }
  report.uiAtStop = await evaluate(client, `(() => { ${PAGE} return uiState(); })()`);
  const stoppedAt = Date.now();
  report.steps.push({ step: "stop clicked", ...stopClick });

  // 4. Observe until the stopping state resolves.
  let resolvedAt = null;
  const observations = [];
  const end = Date.now() + OBSERVE_MS;
  while (Date.now() < end) {
    const state = await evaluate(client, `(() => { ${PAGE} return uiState(); })()`);
    observations.push({ atMs: Date.now() - stoppedAt, ...state });
    if (stopClick.clicked && !state.stopping && !state.stoppingBanner && !state.working) {
      resolvedAt = Date.now() - stoppedAt;
      break;
    }
    await sleep(1_000);
  }
  report.steps.push({ step: "stop resolution", resolvedAtMs: resolvedAt, observeMs: OBSERVE_MS });
  report.uiAfterStop = observations[observations.length - 1] ?? null;
  report.uiObservations = observations;
  report.shotAfterStop = await shot(client, "m0-04-2-after-stop");

  // 5. The session must still accept a turn afterwards ("reprendre").
  await evaluate(client, `(() => {
    ${PAGE}
    const field = composer();
    if (!field) return { filled: false };
    const proto = field.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(field, ${JSON.stringify(FOLLOWUP)});
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.focus();
    return { filled: true };
  })()`);
  const followClick = await evaluate(client, `(() => {
    ${PAGE}
    const node = document.querySelector('button.send') || byLabel('send')[0];
    if (!node) return { clicked: false, ...uiState() };
    node.click();
    return { clicked: true, label: (node.getAttribute('aria-label') || node.innerText || '').trim() };
  })()`);
  report.steps.push({ step: "follow-up sent", ...followClick });
  await sleep(6_000);
  report.uiAfterFollowup = await evaluate(client, `(() => { ${PAGE} return uiState(); })()`);

  // 6. The full wire trace.
  const raw = await evaluate(client, `window.__museIpcTrace || { out: [], in: [] }`);
  report.traceOut = raw.out;
  report.traceTerminal = (raw.out ?? []).filter(
    (e) => typeof e.result === "string" && /turn\/completed|"terminal"/.test(e.result),
  ).slice(-10);

  // Decisive fact for M0-04: did the renderer transmit a turnId to the bridge?
  const cancels = (raw.out ?? []).filter((e) => e.cmd === "cancel_session");
  report.cancelCalls = cancels;
  report.verdict = {
    turnIdObservedOnWire: turnId !== null,
    stopClicked: stopClick.clicked === true,
    cancelSessionCalls: cancels.length,
    cancelCarriedTurnId: cancels.map((c) => {
      const text = JSON.stringify(c.payload ?? {});
      return /"turn_id"\s*:\s*"[^"]+"/.test(text) || /"turnId"\s*:\s*"[^"]+"/.test(text);
    }),
    stoppingResolved: resolvedAt !== null,
    resolvedAtMs: resolvedAt,
  };

  console.log(JSON.stringify(report, null, 2));
  client.close();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    exit(1);
  });
}
