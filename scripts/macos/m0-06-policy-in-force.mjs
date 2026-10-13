#!/usr/bin/env node
/**
 * M0-06 on macOS: the policy the app shows is the one really in force. The
 * macOS counterpart of m0-06-policy-in-force.json, m0-06-project-follows-global
 * .json and the 1.4.2 verdict matrix, on the pinned engine in isolated test
 * instances (scripts/macos/test-instance.mjs).
 *
 *   scope   no turn. Five projects (three follow Settings, one restricts its
 *           network, one is read only). For each Isolation level of Settings a
 *           conversation with no message is started from a project's row; the
 *           start_session posture and the engine argv the OS runs (ps) are read.
 *           A project's running engine asked for another level is refused.
 *           Then the posture menu is cycled with conversations connected
 *           (set_approval_mode on the wire, the host's effective mode), and
 *           after a relaunch the resumed conversation answers the saved mode.
 *   matrix  3 turns, posture YOLO (no card). One project per Isolation level;
 *           the model only runs `sh probe.sh`, a script the harness left in the
 *           folder: writes inside the folder (relative and absolute), outside
 *           it in a temp folder and in a home folder, a read outside, plain HTTP
 *           and HTTPS. Writes are checked on disk, the rest in the tool output.
 *   middle  1 turn, posture "Ask only for more access" (onRequest), Workspace
 *           only: the same probe; whether the engine asks, every card answered
 *           Allow once, the same outcomes.
 *   texts   no turn. Settings' posture and Isolation sentences read on macOS
 *           and set against the macOS cells of this record.
 *
 * The outside targets are a sibling folder of the projects under $TMPDIR and
 * ~/muse-proofs/g2-outside-<run> (created and deleted by this script), never a
 * TCC-protected folder.
 *
 *   node scripts/macos/m0-06-policy-in-force.mjs --exe ~/muse-proofs/app/08b291d/muse-desktop
 *     [--port 9426] [--base $TMPDIR/muse-proofs-g2/m0-06] [--phases scope,matrix,middle,texts]
 *     [--out docs/evidence/2026-10-13-macos-closure/m0-06-policy-in-force.json]
 *     [--build-commit 08b291d] [--seed-from <record.json>]
 *
 * --seed-from starts a new record (when --out does not exist yet) from an
 * earlier one: its phases not run now are carried over, marked carriedFrom,
 * and their turns are not counted as this run's. E.g. a text-only change of
 * Settings replayed with --phases texts on the cells measured before.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { argValue, sleep, waitFor } from "../cdp-harness.mjs";
import { engineVersion, launch } from "./test-instance.mjs";
import {
  addProject, engines, fullLog, installTraces, ipc, labelOf, macPlatform, mouseOn, approvalButton, openSettings, page, pending,
  runRedactor, select, setIsolation, setOverride, setPosture, startBare, startIn,
} from "./m0-05-06-common.mjs";

const EXE = resolve(argValue("--exe", join(homedir(), "muse-proofs", "app", "08b291d", "muse-desktop")));
const PORT = Number(argValue("--port", "9426"));
const BASE = resolve(argValue("--base", join(tmpdir(), "muse-proofs-g2", "m0-06")));
const PHASES = argValue("--phases", "scope,matrix,middle,temp,texts").split(",");
const OUT = argValue("--out", "docs/evidence/2026-10-13-macos-closure/m0-06-policy-in-force.json");
const BUILD = argValue("--build-commit", "08b291d");
const SEED = argValue("--seed-from", null);
// Settings' macOS sentence added in 3196ce2 (SettingsPanel.tsx, Isolation note).
const MAC_NOTE = /On macOS with Muse 1\.4\.2, Workspace only also lets commands write in the system's temporary folders \(\$TMPDIR, \/tmp\); other writes outside the folder are refused, and names do not resolve\./;
const ID = Date.now().toString(36);
const RUN = join(BASE, `run-${ID}`);
const OUT_TMP = join(RUN, "outside");
const OUT_HOME = join(homedir(), "muse-proofs", `g2-outside-${ID}`);
const redact = runRedactor([[OUT_TMP, "<outside temp>"], [OUT_HOME, "<outside home>"], [RUN, "<run>"], [BASE, "<proof>"], [tmpdir(), "<TMPDIR>"]]);
const LEVEL = { workspace: "Workspace only", network: "Workspace and network", elevated: "Elevated access" };
const FLAG = { workspace: "--sandbox-network restricted", network: "--sandbox-network enabled", elevated: "--disable-sandbox --sandbox-network enabled" };

function readJson(path, fallback) { try { return JSON.parse(readFileSync(path, "utf8")); } catch { return fallback; } }

async function freshInstance(name, projects) {
  const data = join(RUN, name, "data");
  const folders = {};
  for (const key of Object.keys(projects)) {
    folders[key] = join(RUN, name, projects[key]);
    mkdirSync(folders[key], { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: folders[key] });
  }
  const inst = await launch({ exe: EXE, port: PORT, data });
  await waitFor(() => inst.app.ev(page("return q('.primary-nav button[aria-label=\"New conversation\"]').length > 0;")), 60_000);
  await installTraces(inst.app);
  const ids = {};
  const names = {};
  for (const key of Object.keys(projects)) {
    names[key] = `m06-${name}-${key.toLowerCase()}`;
    ids[key] = await addProject(inst.app, names[key], folders[key]);
    if (!ids[key]) throw new Error(`project ${key} not created`);
  }
  return { inst, data, folders, ids, names };
}

// ---- scope ------------------------------------------------------------------------

async function scopePhase() {
  const projects = { F1: "f1", F2: "f2", F3: "f3", N: "n", R: "r" };
  const { inst, data, names } = await freshInstance("scope", projects);
  let app = inst.app;
  const r = { liveTurns: 0, isolation: inst.isolation, cases: [] };
  let second = null;
  let f1Sid = null;
  try {
    r.overrideN = await setOverride(app, names.N, { label: "Project network", value: "deny" });
    r.overrideR = await setOverride(app, names.R, { label: "Project isolation", value: "read-only" });
    for (const [level, key] of [["workspace", "F1"], ["network", "F2"], ["elevated", "F3"], ["elevated", "N"], ["elevated", "R"]]) {
      const set = await setIsolation(app, LEVEL[level]);
      const started = await startBare(app, names[key], inst.pid);
      if (key === "F1") f1Sid = started.sessionId;
      r.cases.push({ settings: LEVEL[level], project: key, stored: set.stored, status: set.status, ...started });
    }
    // F1's engine runs Workspace only; Settings now says Elevated access.
    r.change = { settings: LEVEL.elevated, project: "F1 (follows Settings, engine running)", ...(await startBare(app, names.F1, inst.pid)) };
    // Postures on the wire, conversations connected.
    const before = (await ipc(app, "set_approval_mode")).length;
    if (f1Sid) await select(app, f1Sid);
    r.postures = [];
    for (const mode of ["workspace", "yolo", "ask", "yolo"]) {
      const set = await setPosture(app, mode);
      await sleep(1_500);
      r.postures.push({ mode, via: set.via, stored: set.stored });
    }
    r.setApprovalMode = (await ipc(app, "set_approval_mode")).slice(before).map((c) => {
      let res = null; try { res = JSON.parse(c.result); } catch { /* error text */ }
      return { mode: c.args?.mode, ok: c.ok, effectiveMode: res?.effectiveMode?.mode ?? null, error: c.ok ? undefined : String(c.result ?? "").slice(0, 200) };
    });
    r.enginesAtEnd = Object.values(engines(inst.pid));
    r.consoleErrors = app.errors.slice(0, 10);
  } finally {
    r.stopFirst = await inst.stop({ keepStore: true });
  }
  try {
    second = await launch({ exe: EXE, port: PORT, data });
    app = second.app;
    await installTraces(app);
    r.relaunchPosture = await app.ev("localStorage.getItem('muse-desktop.authorization-mode.v1')");
    if (f1Sid) {
      await waitFor(() => app.ev(page(`return Boolean(document.querySelector('li.session-item[data-session-id="${f1Sid}"]'));`)), 30_000);
      await select(app, f1Sid);
      const connected = await waitFor(() => app.ev(page("return document.querySelector('.connection-state')?.textContent.trim() === 'Connected';")), 30_000, 1_000);
      if (!connected) {
        await app.ev(page("const b = q('button.workspace-button').find((n) => /^Reconnect/.test(n.innerText.trim())); if (b) b.click(); return !!b;"));
        await waitFor(() => app.ev(page("return document.querySelector('.connection-state')?.textContent.trim() === 'Connected';")), 60_000, 1_000);
      }
      await sleep(1_500);
      r.resume = (await ipc(app, "resume_session")).map((c) => { let res = null; try { res = JSON.parse(c.result); } catch { /* */ } return { ok: c.ok, sandboxMode: c.args?.sandboxMode ?? null, authorizationMode: c.args?.authorizationMode ?? null, hostApprovalMode: res?.approval_mode ?? null }; });
      r.setApprovalModeAfterRelaunch = (await ipc(app, "set_approval_mode")).map((c) => { let res = null; try { res = JSON.parse(c.result); } catch { /* */ } return { mode: c.args?.mode, ok: c.ok, effectiveMode: res?.effectiveMode?.mode ?? null }; });
      r.enginesAfterRelaunch = Object.values(engines(second.pid));
    }
    // Back to the default posture before the store goes.
    r.restoredAsk = await setPosture(app, "ask");
  } finally {
    if (second) r.stop = await second.stop();
  }
  const c = (key) => r.cases.find((x) => x.project === key);
  const argvHas = (x, level) => typeof x?.engine === "string" && x.engine.startsWith(`serve ${FLAG[level]}`) && x.engine.includes("--trust-workspace");
  const modes = (r.setApprovalMode ?? []).filter((x) => x.ok).map((x) => `${x.mode}->${x.effectiveMode}`);
  r.verdict = {
    workspaceArgv: c("F1")?.requested.sandboxMode === "workspace" && argvHas(c("F1"), "workspace"),
    networkArgv: c("F2")?.requested.sandboxMode === "network" && argvHas(c("F2"), "network"),
    elevatedArgv: c("F3")?.requested.sandboxMode === "elevated" && argvHas(c("F3"), "elevated"),
    noNetworkProjectStaysWorkspace: c("N")?.requested.sandboxMode === "workspace" && argvHas(c("N"), "workspace"),
    readOnlyProjectFlags: c("R")?.requested.sandboxMode === "workspace" && /--disable-write/.test(c("R")?.engine ?? "") && /--disable-shell/.test(c("R")?.engine ?? ""),
    runningEngineKeepsItsPosture: r.change?.ok === false && /restart it to apply/.test(r.change.error ?? ""),
    postureChangeWithoutRestart: ["workspace->onRequest", "yolo->allowAll", "ask->promptUnmatched"].every((m) => modes.includes(m)),
    // The boot resume runs before the harness's trace is installed; the posture the app then re-applies
    // to the resumed conversation, and the host's answer to it, are on the wire.
    posturePersistsAcrossRelaunch: r.relaunchPosture === "yolo" && ((r.resume ?? []).some((x) => x.ok && x.hostApprovalMode === "allowAll")
      || (r.setApprovalModeAfterRelaunch ?? []).some((x) => x.ok && x.mode === "yolo" && x.effectiveMode === "allowAll")),
    relaunchedEngineFollowsCurrentSettings: (r.enginesAfterRelaunch ?? []).length === 1 && r.enginesAfterRelaunch[0].startsWith(`serve ${FLAG.elevated}`),
  };
  return r;
}

// ---- matrix ---------------------------------------------------------------------------

function probeScript(tag) {
  return `#!/bin/sh
# M0-06 macOS probe (scripts/macos/m0-06-policy-in-force.mjs): each line says one outcome.
w() { if ( printf '%s\\n' "${tag}" > "$2" ) 2>/dev/null; then echo "probe $1=ok"; else echo "probe $1=fail"; fi; }
w write-inside-relative inside-rel-${tag}.txt
w write-inside-absolute "$(pwd)/inside-abs-${tag}.txt"
w write-outside-temp "${OUT_TMP}/out-${tag}.txt"
w write-outside-home "${OUT_HOME}/out-${tag}.txt"
if cat "${OUT_HOME}/read-me.txt" >/dev/null 2>&1; then echo "probe read-outside-home=ok"; else echo "probe read-outside-home=fail"; fi
for u in http://example.com https://example.com; do
  code=$(curl -sS -o /dev/null -w '%{http_code}' --connect-timeout 10 --max-time 20 "$u" 2>/dev/null); rc=$?
  echo "probe net-$(echo "$u" | cut -d: -f1)=exit$rc:$code"
done
echo "probe done"
`;
}
const PROBE_PROMPT = "Use your shell tool to run exactly this command in the workspace, unchanged, once: sh probe.sh  Then reply with the probe lines it printed, verbatim, and nothing else. Do not run anything else.";

function diskOutcomes(folder, tag) {
  const at = (p) => (existsSync(p) && readFileSync(p, "utf8").trim() === tag ? "ok" : "fail");
  return {
    "write-inside-relative": at(join(folder, `inside-rel-${tag}.txt`)),
    "write-inside-absolute": at(join(folder, `inside-abs-${tag}.txt`)),
    "write-outside-temp": at(join(OUT_TMP, `out-${tag}.txt`)),
    "write-outside-home": at(join(OUT_HOME, `out-${tag}.txt`)),
  };
}

function printed(log) {
  const text = log.filter((e) => e.role !== "user").map((e) => e.text).join("\n");
  const out = {};
  for (const m of text.matchAll(/probe ([a-z-]+)=([^\s"\\]+)/g)) if (!(m[1] in out)) out[m[1]] = m[2];
  return out;
}

/** One probe turn in a project of the given Isolation; cards (if any) answered Allow once. */
async function probeTurn(app, appPid, { id, folder, level, posture }) {
  const tag = `${level}-${posture}-${ID}`;
  writeFileSync(join(folder, "probe.sh"), probeScript(tag));
  const cell = { level: LEVEL[level], posture };
  cell.setIsolation = await setIsolation(app, LEVEL[level]);
  cell.setPosture = await setPosture(app, posture);
  const running = engines(appPid);
  const { sid, startSession } = await startIn(app, id, PROBE_PROMPT);
  cell.startSession = startSession;
  await sleep(500);
  cell.engine = Object.entries(engines(appPid)).filter(([pid]) => !(pid in running)).map(([, argv]) => argv).join(" | ") || "reused a running engine";
  cell.cards = [];
  const t0 = Date.now();
  let sawRunning = false;
  while (Date.now() - t0 < 240_000) {
    const s = await app.ev(page(`return { ...view(), running: running(${JSON.stringify(sid)}) };`));
    if (s.running === "true") sawRunning = true;
    const snap = await pending(app, sid);
    if (snap.approvals.length > 0 && s.cards.length > 0) {
      const req = JSON.stringify(snap.approvals[0].requirement);
      cell.cards.push({ tool: snap.approvals[0].toolName, command: s.cards[0].command, choices: snap.approvals[0].choices.map((c) => c.choiceId) });
      await mouseOn(app, approvalButton(labelOf(snap, true)));
      await waitFor(async () => { const n = await pending(app, sid); return n.approvals.length === 0 || JSON.stringify(n.approvals[0].requirement) !== req; }, 30_000, 400);
      await sleep(1_500);
      continue;
    }
    if (sawRunning && s.running === "false" && s.cards.length === 0 && !/working|resuming|waiting/i.test(s.health ?? "")) break;
    await sleep(800);
  }
  cell.turnEnded = Date.now() - t0 < 240_000;
  const log = await fullLog(app, sid);
  cell.printed = printed(log);
  cell.disk = diskOutcomes(folder, tag);
  cell.reply = log.filter((e) => e.role === "assistant").map((e) => e.text).join(" ").slice(0, 600);
  return cell;
}

async function matrixPhase(posture = "yolo", levels = ["workspace", "network", "elevated"], name = "matrix") {
  mkdirSync(OUT_TMP, { recursive: true });
  mkdirSync(OUT_HOME, { recursive: true });
  writeFileSync(join(OUT_HOME, "read-me.txt"), "m06 read probe\n");
  const projects = Object.fromEntries(levels.map((l) => [l, l]));
  const { inst, folders, ids } = await freshInstance(name, projects);
  const app = inst.app;
  const r = { liveTurns: levels.length, isolation: inst.isolation, cells: [] };
  try {
    for (const level of levels) r.cells.push(await probeTurn(app, inst.pid, { id: ids[level], folder: folders[level], level, posture }));
    r.consoleErrors = app.errors.slice(0, 10);
    r.restoredAsk = await setPosture(app, "ask");
    r.restoredWorkspace = await setIsolation(app, LEVEL.workspace);
  } finally {
    r.stop = await inst.stop();
  }
  return r;
}

/**
 * Where the Workspace-only sandbox lets a write outside the folder land: the
 * user's temp folder ($TMPDIR, which also holds the projects here), the
 * system /tmp, and the home folder. One turn, YOLO.
 */
async function tempPhase() {
  const OTHER_TMP = join("/private/tmp", `muse-proofs-g2-${ID}`);
  const TMPDIR_ROOT = join(tmpdir(), `muse-proofs-g2-direct-${ID}`);
  mkdirSync(OTHER_TMP, { recursive: true });
  mkdirSync(TMPDIR_ROOT, { recursive: true });
  mkdirSync(OUT_HOME, { recursive: true });
  const { inst, folders, ids } = await freshInstance("temp", { W: "w" });
  const app = inst.app;
  const r = { liveTurns: 1, isolation: inst.isolation };
  const tag = `temp-${ID}`;
  const targets = { "write-tmpdir-sibling": join(OUT_TMP, `t-${tag}.txt`), "write-tmpdir-other-tree": join(TMPDIR_ROOT, `t-${tag}.txt`),
    "write-private-tmp": join(OTHER_TMP, `t-${tag}.txt`), "write-home": join(OUT_HOME, `t-${tag}.txt`) };
  mkdirSync(OUT_TMP, { recursive: true });
  try {
    writeFileSync(join(folders.W, "probe.sh"), `#!/bin/sh\nw() { if ( printf '%s\\n' "${tag}" > "$2" ) 2>/dev/null; then echo "probe $1=ok"; else echo "probe $1=fail"; fi; }\n` +
      Object.entries(targets).map(([k, v]) => `w ${k} "${v}"`).join("\n") + "\necho \"probe tmpdir-env=$TMPDIR\"\necho \"probe done\"\n");
    r.setIsolation = await setIsolation(app, LEVEL.workspace);
    r.setPosture = await setPosture(app, "yolo");
    const { sid, startSession } = await startIn(app, ids.W, PROBE_PROMPT);
    r.startSession = startSession;
    r.engine = Object.values(engines(inst.pid));
    await waitFor(async () => (await fullLog(app, sid)).some((e) => e.role === "assistant" && /probe done/.test(e.text)), 180_000, 1_000);
    const log = await fullLog(app, sid);
    r.printed = printed(log);
    r.disk = Object.fromEntries(Object.entries(targets).map(([k, v]) => [k, existsSync(v) && readFileSync(v, "utf8").trim() === tag ? "ok" : "fail"]));
    r.restoredAsk = await setPosture(app, "ask");
    r.consoleErrors = app.errors.slice(0, 10);
  } finally {
    r.stop = await inst.stop();
    rmSync(OTHER_TMP, { recursive: true, force: true });
    rmSync(TMPDIR_ROOT, { recursive: true, force: true });
  }
  return r;
}

async function middlePhase() {
  const r = await matrixPhase("workspace", ["workspace"], "middle");
  return r;
}

// ---- texts ------------------------------------------------------------------------------

async function textsPhase(record) {
  const data = join(RUN, "texts", "data");
  const inst = await launch({ exe: EXE, port: PORT, data });
  const app = inst.app;
  const r = { liveTurns: 0 };
  try {
    await openSettings(app);
    r.settings = await app.ev(page(`
      const group = (h) => [...document.querySelectorAll('.settings-panel .settings-group')].find((g) => g.querySelector('h3')?.innerText.trim() === h);
      const rows = (g, label) => g ? [...g.querySelectorAll('[role="radiogroup"][aria-label="' + label + '"] label')].map((l) => ({ label: l.querySelector('strong')?.innerText.trim(), detail: l.querySelector('.authorization-mode-copy > span')?.innerText.trim() })) : [];
      const iso = group('Isolation');
      const posture = [...document.querySelectorAll('.settings-panel .settings-group')].find((g) => g.querySelector('[aria-label="Global authorization mode"]'));
      return { isolationNote: iso?.querySelector('.settings-note')?.innerText.replace(/\\s+/g, ' ').trim() ?? null,
        isolation: rows(iso, 'Isolation'), postures: rows(posture, 'Global authorization mode') };
    `));
  } finally {
    r.stop = await inst.stop();
  }
  const cells = [...(record.phases.matrix?.cells ?? []), ...(record.phases.middle?.cells ?? [])];
  const cell = (level, posture) => cells.find((c) => c.level === LEVEL[level] && c.posture === posture);
  const ok = (c, k) => (k.startsWith("write") ? c?.disk?.[k] : c?.printed?.[k]) === "ok";
  const net = (c, scheme) => /^exit0:(200|30\d)$/.test(c?.printed?.[`net-${scheme}`] ?? "");
  const w = cell("workspace", "yolo");
  const n = cell("network", "yolo");
  const e = cell("elevated", "yolo");
  const m = cell("workspace", "workspace");
  const sentence = (label) => r.settings?.isolation.find((x) => x.label === label)?.detail ?? r.settings?.postures.find((x) => x.label === label)?.detail ?? null;
  const t = record.phases.temp?.disk ?? null;
  r.macosNoteShown = MAC_NOTE.test(r.settings?.isolationNote ?? "");
  const writeCells = { inside: [w?.disk?.["write-inside-relative"], w?.disk?.["write-inside-absolute"]], outsideHome: w?.disk?.["write-outside-home"], outsideTemp: w?.disk?.["write-outside-temp"], tempPhase: t };
  const insideOnly = ok(w, "write-inside-relative") && ok(w, "write-inside-absolute") && !ok(w, "write-outside-home");
  r.claims = [
    r.macosNoteShown
      // With the macOS note, the Workspace only sentence is read with the exception the note states.
      ? { sentence: `${sentence("Workspace only")} + note: ${r.settings.isolationNote.match(MAC_NOTE)[0]}`, claim: "writes stay inside the folder, except the system temp folders ($TMPDIR, /tmp); other writes outside are refused",
        holds: insideOnly && t?.["write-tmpdir-sibling"] === "ok" && t?.["write-tmpdir-other-tree"] === "ok" && t?.["write-private-tmp"] === "ok" && t?.["write-home"] === "fail",
        cells: writeCells }
      : { sentence: sentence("Workspace only"), claim: "writes stay inside the folder", holds: insideOnly && !ok(w, "write-outside-temp"), cells: writeCells },
    ...(r.macosNoteShown ? [{ sentence: r.settings.isolationNote.match(MAC_NOTE)[0], claim: "names do not resolve under Workspace only", holds: /^exit6:/.test(w?.printed?.["net-http"] ?? "") && /^exit6:/.test(w?.printed?.["net-https"] ?? ""), cells: { http: w?.printed?.["net-http"], https: w?.printed?.["net-https"] } }] : []),
    { sentence: sentence("Workspace only"), claim: "commands cannot connect out", holds: Boolean(w) && !net(w, "http") && !net(w, "https"), cells: { http: w?.printed?.["net-http"], https: w?.printed?.["net-https"] } },
    { sentence: sentence("Workspace only"), claim: "reads can reach other folders", holds: ok(w, "read-outside-home"), cells: { read: w?.printed?.["read-outside-home"] } },
    { sentence: sentence("Workspace and network"), claim: "also lets commands connect out", holds: net(n, "http") && net(n, "https") && !ok(n, "write-outside-home"), cells: { http: n?.printed?.["net-http"], https: n?.printed?.["net-https"], outsideHome: n?.disk?.["write-outside-home"] } },
    { sentence: sentence("Elevated access"), claim: "adds files and commands outside the folder", holds: ok(e, "write-outside-home") && ok(e, "write-outside-temp") && net(e, "https"), cells: { outsideHome: e?.disk?.["write-outside-home"], outsideTemp: e?.disk?.["write-outside-temp"], https: e?.printed?.["net-https"] } },
    { sentence: sentence("YOLO"), claim: "never asks; Isolation still limits", holds: [w, n, e].every((c) => c && c.cards.length === 0) && !ok(w, "write-outside-home"), cells: { cards: [w, n, e].map((c) => c?.cards.length ?? null) } },
    { sentence: sentence("Ask only for more access"), claim: "the engine's sandbox decides when Muse asks (macOS cell recorded)", holds: Boolean(m?.turnEnded), cells: { cards: m?.cards.length ?? null, tools: (m?.cards ?? []).map((x) => x.tool), outsideHome: m?.disk?.["write-outside-home"], http: m?.printed?.["net-http"] } },
  ];
  r.windowsOnlyNoteAbsent = !/Windows|PowerShell/.test(r.settings?.isolationNote ?? "");
  r.verdict = { everyClaimHolds: r.claims.every((x) => x.holds), windowsOnlyNoteAbsent: r.windowsOnlyNoteAbsent, ...(BUILD === "08b291d" ? {} : { macosNoteShown: r.macosNoteShown }) };
  return r;
}

async function main() {
  mkdirSync(RUN, { recursive: true });
  const seed = SEED ? readJson(SEED, null) : null;
  const carried = (p) => Boolean(p?.carriedFrom);
  const record = readJson(OUT, null) ?? (seed ? {
    ...seed,
    harness: `scripts/macos/m0-06-policy-in-force.mjs (+ scripts/macos/m0-05-06-common.mjs), port ${PORT}`,
    phases: Object.fromEntries(Object.entries(seed.phases).filter(([k]) => !PHASES.includes(k)).map(([k, p]) => [k, { ...p, carriedFrom: `${SEED} (${seed.commit}, ${seed.date})` }])),
  } : {
    schema: "muse-desktop.m0-06-policy-in-force-macos.v1",
    ticket: "M0-06",
    commit: BUILD,
    platform: macPlatform(),
    harness: `scripts/macos/m0-06-policy-in-force.mjs (+ scripts/macos/m0-05-06-common.mjs), port ${PORT}`,
    phases: {},
  });
  record.commit = BUILD;
  if (seed) {
    record.previousRun = {
      file: SEED, commit: seed.commit,
      defectThen: "texts.everyClaimHolds false: Settings' 'Writes stay inside the conversation's folder' over-claimed on macOS, where Workspace only let commands write in $TMPDIR and /private/tmp (home folder refused).",
      expectationNow: `Replay on ${BUILD}: the Isolation note shows the macOS sentence (macosNoteShown), and the Workspace only claim is judged with the exception it states against the cells of ${seed.commit} (carried phases: the engine, its argv and the cells are unchanged by a text-only fix), so everyClaimHolds is expected true. Only the texts phase runs; no turn.`,
    };
  }
  record.date = new Date().toISOString().slice(0, 10);
  record.engine = engineVersion();
  record.isolation = "One isolated test instance per phase (scripts/macos/test-instance.mjs): fresh data folder and WKWebView store under the run folder, projects in folders under the run folder ($TMPDIR) created through the Projects panel, the pinned engine with MUSE_NO_AUTO_UPDATE=1; each stop records the default stores unchanged and no process left. Outside-the-folder write targets: a sibling under $TMPDIR, another $TMPDIR tree, /private/tmp/muse-proofs-g2-<run> and ~/muse-proofs/g2-outside-<run>, all created and deleted by the script. The engine's session store is shared with the user (ADR 0003).";
  record.method = "scope: conversations with no message started from each project's row (Projects panel > New conversation here) under each Isolation level of Settings; the requested posture is read from start_session on the page's IPC trace, the engine argv from ps under the app's pid; the posture menu cycled with five engines running (set_approval_mode, host effectiveMode), then a graceful relaunch. matrix/middle/temp: real 1.4.2 turns whose only action is `sh probe.sh`, a script the harness wrote in the project folder; writes are judged on disk, the read and the network from the probe lines in the stored transcript (curl exit code and HTTP status). texts: Settings' sentences read on macOS and set against those cells."
    + (seed ? ` Replay on ${BUILD}, texts phase only (no turn): the scope, matrix, middle and temp phases are carried from ${seed.commit} (carriedFrom), the fix being a Settings sentence; the Isolation note is read in a fresh instance of ${BUILD} and the Workspace only claim judged with the macOS exception it now states.` : "");
  record.limits = [
    BUILD === "08b291d"
      ? "macOS engine 1.4.2 (Seatbelt): under Workspace only, writes outside the folder are refused in the home folder but succeed in the user's temp folder ($TMPDIR) and in /private/tmp; Settings' 'Writes stay inside the conversation's folder' over-claims on macOS for those two folders. Names do not resolve under Workspace only (curl exit 6), where Windows resolved them and refused the connect."
      : `macOS engine 1.4.2 (Seatbelt): under Workspace only, writes outside the folder are refused in the home folder but succeed in the user's temp folder ($TMPDIR) and in /private/tmp, and names do not resolve (curl exit 6); measured on 08b291d (carried cells) and, since ${BUILD}, stated by Settings' Isolation note on macOS. The 'Workspace only' row itself still reads 'Writes stay inside the conversation's folder'; the exception is in the note above the rows.`,
    "Under 'Ask only for more access' (onRequest) the macOS engine ran `sh probe.sh` without asking (0 cards); the sentence's Windows clause ('On Windows it asks for shell commands') says nothing about macOS.",
    "A relaunch resumes a conversation on an engine started with the current Settings level when the project follows Settings (F1 started under Workspace only came back under Elevated access), as Settings' note says ('Applied when a new engine starts').",
    "The boot resume runs before the harness installs its IPC trace: the relaunch is judged on the posture the app re-applies and the host's answer to it.",
  ];
  try {
    for (const phase of PHASES) {
      let result;
      try {
        result = phase === "scope" ? await scopePhase() : phase === "matrix" ? await matrixPhase() : phase === "middle" ? await middlePhase()
          : phase === "temp" ? await tempPhase() : await textsPhase(record);
      } catch (error) {
        result = { error: String(error?.message ?? error).slice(0, 400), appOutput: (error?.appOutput ?? []).slice(-10) };
      }
      record.phases[phase] = redact({ at: new Date().toISOString(), ...result });
      record.liveTurns = Object.values(record.phases).filter((p) => !carried(p)).reduce((n, p) => n + (p.liveTurns ?? 0), 0);
      const carriedTurns = Object.values(record.phases).filter(carried).reduce((n, p) => n + (p.liveTurns ?? 0), 0);
      if (carriedTurns > 0) record.liveTurnsInCarriedPhases = carriedTurns;
      record.verdicts = Object.fromEntries(Object.entries(record.phases).map(([k, p]) => [k, p.verdict ?? (p.error ? { error: p.error } : "recorded (cells judged by texts)")]));
      mkdirSync(join(OUT, ".."), { recursive: true });
      writeFileSync(OUT, `${JSON.stringify(record, null, 2)}\n`);
      console.log(phase, JSON.stringify(record.verdicts[phase]));
    }
  } finally {
    rmSync(OUT_HOME, { recursive: true, force: true });
  }
}

await main();
