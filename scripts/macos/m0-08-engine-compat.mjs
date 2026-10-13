#!/usr/bin/env node
/**
 * M0-08 on macOS: detect an engine incompatibility (handshake, schema
 * fingerprint), the macOS counterpart of cdp-m0-08-engine-run.mjs and of the
 * 25-26/09 incompatible-engine campaign.
 *
 *   handshake  no app, no billed turn. `initialize` of the pinned 1.4.2 and of
 *              the old 1.3.0-R3401.1 macOS binaries, called directly with
 *              MUSE_NO_AUTO_UPDATE=1 and the app's own flags, compared with the
 *              recorded fixtures (src-tauri/tests/fixtures/initialize-*.json)
 *              and with the app's validation rule; then an echo-provider turn
 *              (not billed) on 1.4.2 lists the notifications the client does
 *              not route.
 *   app        one live turn. An isolated instance on the pinned 1.4.2: a
 *              project conversation answers, collect_diagnostics names the
 *              engine and its fingerprint. Then the same data folder is
 *              relaunched on the fake engine (m0-07-08-fake-engine.mjs): the
 *              silent boot resume fails with a reason on the pill and the
 *              notice; each incompatible mode is met by an explicit Reconnect;
 *              finally the fake proxies the real engine and Reconnect reaches
 *              "Connected" with the notice cleared, in the same app.
 *
 *   node scripts/macos/m0-08-engine-compat.mjs --exe ~/muse-proofs/app/08b291d/muse-desktop
 *     [--port 9422] [--base $TMPDIR/muse-proofs-g2/m0-08] [--phases handshake,app]
 *     [--out docs/evidence/2026-10-13-macos-closure/m0-08-engine-compat.json]
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { argValue, redactor, sleep, waitFor } from "../cdp-harness.mjs";
import { connect as mspConnect, createHost, startSession, uuidv7 } from "../msp-probe.mjs";
import { DEFAULT_ENGINE, engineVersion, launch, processTree } from "./test-instance.mjs";
import { newProjectConversation, sendFirstMessage, transcript } from "./smoke-real-turn.mjs";

const EXE = resolve(argValue("--exe", join(homedir(), "muse-proofs", "app", "08b291d", "muse-desktop")));
const PORT = Number(argValue("--port", "9422"));
const BASE = resolve(argValue("--base", join(tmpdir(), "muse-proofs-g2", "m0-08")));
const PHASES = argValue("--phases", "handshake,app").split(",");
const OUT = argValue("--out", "docs/evidence/2026-10-13-macos-closure/m0-08-engine-compat.json");
const OLD_ENGINE = join(homedir(), ".local", "bin", "muse-bin-1.3.0-R3401.1");
const FAKE = fileURLToPath(new URL("./m0-07-08-fake-engine.mjs", import.meta.url));
const ID = Date.now().toString(36);
const RUN = join(BASE, `run-${ID}`);
const PROJECT = join(RUN, "project");
const DATA = join(RUN, "data");
const CONTROL = join(RUN, "fake-mode");
const FIXTURES = { "1.4.2": "src-tauri/tests/fixtures/initialize-1.4.2-R4684.1.json", "1.3.0": "src-tauri/tests/fixtures/initialize-1.3.0-R3401.1.json" };
const APP_FLAGS = ["serve", "--sandbox-network", "restricted", "--trust-workspace"];
const MODES = ["schema2", "nofingerprint", "badfingerprint", "wrongname", "noserverinfo", "exit", "garbage", "silent"];
const redact = redactor([[PROJECT, "<project>"], [RUN, "<run>"], [BASE, "<proof>"]].flatMap(([p, l]) => [[p, l], [`/private${p}`, l]]).concat([[homedir(), "~"]]));

/** The app's rule (main.rs validate_initialize_result), mirrored to label each answer. */
function appRule(result) {
  const s = result?.serverInfo;
  if (!s) return "no serverInfo";
  if (s.name !== "muse") return "wrong serverInfo.name";
  if (typeof s.version !== "string" || !s.version.trim()) return "no version";
  if (!result.schema) return "no schema";
  if (result.schema.version !== 1) return `unsupported schema ${result.schema.version}`;
  if (!/^sha256:.+/.test(result.schema.fingerprint ?? "")) return "bad fingerprint";
  return "accepted";
}

/** Methods the client routes: the match arms of route_notification_with_emit. */
function routedMethods() {
  const source = readFileSync(join("src-tauri", "src", "main.rs"), "utf8");
  const start = source.indexOf("fn route_notification_with_emit");
  const body = source.slice(start, source.indexOf("\n}\n", start));
  return [...new Set([...body.matchAll(/^\s*(?:\|\s*)?"([a-zA-Z]+\/[a-zA-Z/]+)"(?:\s*\|\s*"([a-zA-Z]+\/[a-zA-Z/]+)")*\s*(?:=>|\|)/gm)]
    .flatMap((m) => m[0].match(/"([^"]+)"/g).map((s) => s.slice(1, -1))))].sort();
}

async function handshake() {
  const out = { liveTurns: 0, engines: {} };
  const ws = join(RUN, "handshake");
  mkdirSync(ws, { recursive: true });
  for (const [label, binary] of [["1.4.2", DEFAULT_ENGINE], ["1.3.0", OLD_ENGINE]]) {
    const entry = { binary: binary.replace(homedir(), "~"), version: null, flags: APP_FLAGS };
    try { entry.version = engineVersion(binary); } catch (e) { entry.version = `failed: ${String(e.message).slice(0, 120)}`; }
    const host = createHost(binary, ws, [], APP_FLAGS);
    try {
      const init = await mspConnect(host);
      const fixture = JSON.parse(readFileSync(FIXTURES[label], "utf8"));
      const rec = fixture.result ?? fixture;
      entry.serverInfo = init?.serverInfo ?? null;
      entry.schema = init?.schema ?? null;
      entry.platformOs = init?.platformOs ?? null;
      entry.appRule = appRule(init);
      entry.fixture = { serverInfo: rec.serverInfo ?? null, schema: rec.schema ?? null, platformOs: rec.platformOs ?? null };
      entry.sameVersionAsFixture = init?.serverInfo?.version === rec.serverInfo?.version;
      entry.sameFingerprintAsFixture = init?.schema?.fingerprint === rec.schema?.fingerprint;
      entry.initializeKeys = Object.keys(init ?? {}).sort();
    } catch (e) {
      entry.failure = String(e?.message ?? e).slice(0, 200);
    } finally {
      await host.stop();
    }
    out.engines[label] = entry;
  }
  // Echo tap: not billed (provider echo); which notifications does a turn emit?
  const tap = { provider: "echo", billed: false };
  const host = createHost(DEFAULT_ENGINE, ws, ["--provider", "echo"], APP_FLAGS);
  try {
    const init = await mspConnect(host);
    tap.serverVersion = init?.serverInfo?.version ?? null;
    const { sessionId } = await startSession(host, ws);
    const mark = host.mark();
    await host.request("turn/start", { sessionId, commandId: uuidv7(), input: [{ type: "text", text: "echo tap" }] });
    await waitFor(() => host.since(mark).some((e) => e.method === "turn/completed"), 30_000, 200);
    await sleep(1_000);
    tap.terminal = host.since(mark).find((e) => e.method === "turn/completed")?.params?.terminal ?? null;
    tap.allMethods = host.methods();
  } catch (e) {
    tap.failure = String(e?.message ?? e).slice(0, 200);
  } finally {
    await host.stop();
  }
  tap.routedByClient = routedMethods();
  tap.ignoredByClient = (tap.allMethods ?? []).filter((m) => !tap.routedByClient.includes(m));
  out.echoTap = tap;
  return out;
}

const H = `
  const vis = (n) => n && n.offsetParent !== null;
  const q = (s, root) => [...(root || document).querySelectorAll(s)].filter(vis);
  const activeSid = () => document.querySelector('li.session-item.active')?.getAttribute('data-session-id') || null;
`;
const page = (body) => `(async () => { ${H} ${body} })()`;
const SURFACE = page(`
  const pill = document.querySelector('.connection-state');
  const text = (sel) => q(sel).map((n) => n.textContent.replace(/\\s+/g, ' ').trim()).filter(Boolean);
  const reconnect = q('button.workspace-button').find((b) => /^Reconnect/.test(b.innerText.trim()));
  return {
    activeSid: activeSid(),
    pill: pill ? { text: pill.textContent.trim(), title: pill.getAttribute('title') } : null,
    notice: text('.connection-notice'),
    panel: text('.sidecar-error-message'),
    banner: text('.error-banner'),
    reconnect: reconnect ? { text: reconnect.innerText.trim(), disabled: reconnect.disabled } : null,
  };
`);

const logLines = () => { try { return readFileSync(`${CONTROL}.log`, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };

async function appPhase() {
  const out = { liveTurns: 0 };
  mkdirSync(PROJECT, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: PROJECT });
  // 1. The real engine: one turn, then the diagnostics.
  let inst = await launch({ exe: EXE, port: PORT, data: DATA });
  out.engine = inst.engineVersion;
  out.isolation = inst.isolation;
  let sid = null;
  try {
    out.start = await newProjectConversation(inst.app, PROJECT);
    const marker = `COMPAT${ID.toUpperCase()}`;
    sid = await sendFirstMessage(inst.app, `Reply with exactly ${marker} and nothing else.`);
    out.liveTurns = 1;
    out.reply = Boolean(await waitFor(async () => (await transcript(inst.app, sid)).some((e) => e.role === "assistant" && String(e.text).includes(marker)), 180_000, 1_000));
    out.engineArgv = processTree(inst.pid).filter((p) => /muse-bin/.test(p.command)).map((p) => p.command.replace(/^\S*\//, ""));
    out.diagnostics = await inst.app.ev("window.__TAURI_INTERNALS__.invoke('collect_diagnostics')");
    out.pillAfterTurn = (await inst.app.ev(SURFACE)).pill;
    out.consoleErrorsRealEngine = inst.app.errors.slice(0, 10);
  } finally {
    out.stopReal = await inst.stop({ keepStore: true });
  }
  if (!sid) return out;
  // 2. The same data folder on the fake engine.
  writeFileSync(CONTROL, MODES[0]);
  inst = await launch({ exe: EXE, port: PORT, data: DATA, engine: ["node", FAKE, CONTROL, DEFAULT_ENGINE] });
  try {
    const app = inst.app;
    await waitFor(() => app.ev(page(`return Boolean(document.querySelector('li.session-item[data-session-id="${sid}"]'));`)), 30_000);
    if ((await app.ev(page("return activeSid();"))) !== sid) {
      await app.ev(page(`document.querySelector('li.session-item[data-session-id="${sid}"] button.session-select')?.click(); return true;`));
    }
    const t0 = Date.now();
    const boot = await waitFor(async () => { const s = await app.ev(SURFACE); return s.notice.length > 0 ? s : null; }, 90_000, 500);
    out.bootResume = { mode: MODES[0], msToNotice: boot ? Date.now() - t0 : null, surface: boot ?? (await app.ev(SURFACE)), spawns: logLines().length };
    out.reconnects = [];
    for (const mode of [...MODES, "proxy"]) {
      writeFileSync(CONTROL, mode);
      const spawnsBefore = logLines().length;
      const before = await app.ev(SURFACE);
      if (!before.reconnect || before.reconnect.disabled) await waitFor(async () => { const s = await app.ev(SURFACE); return s.reconnect && !s.reconnect.disabled; }, 30_000, 500);
      const t1 = Date.now();
      const clicked = await app.ev(page("const b = q('button.workspace-button').find((n) => /^Reconnect/.test(n.innerText.trim())); if (b && !b.disabled) { b.click(); return true; } return false;"));
      const spawned = await waitFor(() => logLines().length > spawnsBefore, 30_000, 200);
      // Settled: Reconnect is back (failure) or the pill says Connected (success).
      const settled = await waitFor(async () => {
        const s = await app.ev(SURFACE);
        if (s.pill?.text === "Connected") return s;
        return s.reconnect && s.reconnect.text === "Reconnect" && !s.reconnect.disabled && Date.now() - t1 > 1_500 ? s : null;
      }, 240_000, 500);
      await sleep(800);
      const surface = await app.ev(SURFACE);
      const fakes = processTree(inst.pid).filter((p) => p.command.includes("m0-07-08-fake-engine")).length;
      out.reconnects.push({ mode, clicked, spawned: Boolean(spawned), msToSettle: settled ? Date.now() - t1 : null, surface, fakeProcessesAlive: fakes, appAlive: inst.child.exitCode === null });
    }
    out.diagnosticsAfter = await app.ev("window.__TAURI_INTERNALS__.invoke('collect_diagnostics')");
    out.spawnLog = logLines().map((l) => ({ mode: l.mode, appArgs: l.appArgs.slice(1) }));
    out.consoleErrorsFake = app.errors.slice(0, 10);
  } finally {
    out.stopFake = await inst.stop();
  }
  return out;
}

function verdicts(rec) {
  const h = rec.phases.handshake;
  const a = rec.phases.app;
  const v = {};
  if (h) {
    v.handshake142MatchesFixture = h.engines["1.4.2"]?.appRule === "accepted" && h.engines["1.4.2"].sameVersionAsFixture && h.engines["1.4.2"].sameFingerprintAsFixture;
    v.handshake130MatchesFixture = h.engines["1.3.0"]?.appRule === "accepted" && h.engines["1.3.0"].sameVersionAsFixture && h.engines["1.3.0"].sameFingerprintAsFixture;
    v.echoTurnCompleted = h.echoTap?.terminal === "completed";
    v.ignoredAdditiveNotifications = h.echoTap?.ignoredByClient ?? null;
  }
  if (a) {
    const fp = h?.engines["1.4.2"]?.fixture?.schema?.fingerprint;
    const engines = a.diagnostics?.hostEngines ?? [];
    v.liveTurnCompleted = a.reply === true;
    v.diagnosticsName142 = engines.length > 0 && engines.every((e) => e.serverVersion === "1.4.2" && /^sha256:[0-9a-f]{64}$/.test(e.schemaFingerprint));
    v.fingerprintMatchesFixture = Boolean(fp) && engines.some((e) => e.schemaFingerprint === fp);
    v.noConsoleErrorOnRealEngine = (a.consoleErrorsRealEngine ?? []).length === 0;
    v.bootResumeReasonShown = Boolean(a.bootResume?.surface?.notice?.[0]) && Boolean(a.bootResume?.surface?.pill?.title);
    const fails = (a.reconnects ?? []).filter((r) => r.mode !== "proxy");
    v.everyIncompatibleModeRefused = fails.length === MODES.length && fails.every((r) => r.spawned && r.surface.pill?.text !== "Connected");
    v.everyRefusalExplained = fails.every((r) => (r.surface.notice[0] ?? "").length > 0);
    v.detectionBounded = fails.every((r) => r.msToSettle !== null);
    v.noCrash = (a.reconnects ?? []).every((r) => r.appAlive);
    const proxy = (a.reconnects ?? []).find((r) => r.mode === "proxy");
    v.recoveryConnectedNoticeCleared = proxy?.surface.pill?.text === "Connected" && proxy.surface.notice.length === 0;
    v.refusedEngineNotListed = (a.diagnosticsAfter?.hostEngines ?? []).every((e) => !/fake|9\.9\.9/.test(e.serverVersion));
    v.cleanStop = a.stopFake?.leftAfterQuit?.length === 0 && a.stopFake?.defaultStoresUnchangedAtEnd === true;
  }
  return v;
}

const record = {
  schema: "muse-desktop.m0-08-engine-compat-macos.v1",
  ticket: "M0-08",
  date: new Date().toISOString().slice(0, 10),
  commit: "08b291d",
  platform: `macOS ${execFileSync("sw_vers", ["-productVersion"], { encoding: "utf8" }).trim()} (${execFileSync("sw_vers", ["-buildVersion"], { encoding: "utf8" }).trim()}), ${process.arch}, debug build with embedded frontend, WKWebView through the test bridge`,
  engine: engineVersion(),
  harness: `scripts/macos/m0-08-engine-compat.mjs (+ scripts/macos/m0-07-08-fake-engine.mjs), port ${PORT}`,
  isolation: null,
  method: {
    handshake: "No app. initialize sent directly to the pinned 1.4.2 and to the old 1.3.0-R3401.1 macOS binaries (MUSE_NO_AUTO_UPDATE=1, never through the ~/.local/bin/muse launcher), with the app's own workspace flags; each answer is judged by a mirror of main.rs validate_initialize_result and compared with the recorded fixtures src-tauri/tests/fixtures/initialize-*.json (recorded on Windows). An echo-provider turn (not billed) on 1.4.2 lists the notifications the client does not route (main.rs route_notification_with_emit arms).",
    app: "Isolated test instance (scripts/macos/test-instance.mjs) on the pinned 1.4.2: a project created from the welcome screen, a first message typed and sent with a real Enter, the reply in the stored transcript, then collect_diagnostics. The same data folder relaunched with MUSE_DESKTOP_TEST_SIDECAR pointing at m0-07-08-fake-engine.mjs: the silent boot resume of the conversation meets mode schema2; then each incompatible mode is met by a click on the conversation's Reconnect button; finally mode proxy runs the real pinned engine behind the fake, and the same Reconnect must reach Connected and clear the notice, in the same app process.",
  },
  limits: [
    "Engine builds before 1.3.0 cannot be obtained: the macOS version matrix is 1.3.0-R3401.1 (handshake only, no app session on it) and 1.4.2-R4684.1 (handshake, app turn).",
    "The initialize fixtures were recorded on Windows (platformOs windows); the macOS binaries answer the same serverInfo.version and the same schema fingerprint, with platformOs macos.",
    "A silent engine (never answers initialize) is detected by the bridge's initialize timeout: about 121 s on this run, bounded but long; the other incompatible modes settle in about 2.5 s.",
    "The engine's session store is shared with the user (ADR 0003): the turn's conversation and the echo-tap session live there.",
  ],
  phases: {},
};
mkdirSync(RUN, { recursive: true });
for (const phase of PHASES) {
  try {
    record.phases[phase] = phase === "handshake" ? await handshake() : await appPhase();
  } catch (error) {
    record.phases[phase] = { error: String(error?.message ?? error).slice(0, 400), appOutput: error?.appOutput };
  }
}
record.liveTurns = Object.values(record.phases).reduce((n, p) => n + (p.liveTurns ?? 0), 0);
record.isolation = record.phases.app?.isolation
  ? { ...record.phases.app.isolation, stopReal: record.phases.app.stopReal, stopFake: record.phases.app.stopFake }
  : "no app phase";
record.verdicts = verdicts(record);
const final = redact(record);
mkdirSync(join(OUT, ".."), { recursive: true });
writeFileSync(OUT, `${JSON.stringify(final, null, 2)}\n`);
console.log(JSON.stringify(final.verdicts, null, 2));
