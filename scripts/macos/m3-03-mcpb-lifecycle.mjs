#!/usr/bin/env node
/**
 * M3-03 native macOS proof: install, update, disable and remove an MCP Bundle
 * (.mcpb) through the Extensions page, registry and runtime kept consistent.
 *
 * Plan acceptance (docs/plans/2026-09-15-agent-implementation-plan.md §M3-03):
 * a failed install, an incompatible update, disabling during a call and
 * deletion; registry and runtime consistent. The Windows ☑ (27/09) rests on a
 * real .mcpb installed through the panel picker, probed, then removed.
 *
 * The bridge has no DOM.setFileInputFiles: the package is handed to the
 * panel's own <input type=file> as a File built in the page from the bytes on
 * disk (DataTransfer), then a change event, the path a user's pick takes from
 * there (ConnectorPanel onChange -> installMcpPackage).
 *
 *   install   v1.0.0 (manifest + the M3-01 fixture server): revision written
 *             under <data>/mcp-packages/<id>/1.0.0, probed, registered with its
 *             version and source; the server not started by the install.
 *   failed    not a zip; a manifest without semver; a missing entry point; an
 *             unsafe path (../); an unsupported runtime; a server that answers
 *             nothing: each refused with a message, nothing registered, no
 *             revision left on disk.
 *   update    v2.0.0 whose server exits at once (incompatible): refused, v1.0.0
 *             kept as it was, no v2 folder; the same v1.0.0 again: refused;
 *             v1.1.0 (valid): the entry moves to 1.1.0, both revisions on disk,
 *             Roll back restores 1.0.0.
 *   disable   Start server, a slow tools/call in flight (the app's own
 *             persistent-call command), the row's toggle switched off during
 *             the call: registry disabled, the process stopped, nothing left
 *             running; enabled again.
 *   delete    Start server, Remove: the entry gone, its process stopped, the
 *             active revision deleted (what stays on disk is recorded).
 *
 *   node scripts/macos/m3-03-mcpb-lifecycle.mjs [--exe <muse-desktop>] [--port 9464]
 *     [--base $TMPDIR/muse-proofs-g6/m3-03] [--out docs/evidence/2026-10-13-macos-closure/m3-03-mcpb-lifecycle.json]
 *
 * No live turn.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { argValue } from "../cdp-harness.mjs";
import { launch } from "./test-instance.mjs";
import {
  EXE_DEFAULT, COMMIT, J, compareStamps, installTrace, ipcCalls, openExtensions, page, pickDefaultFolder, platform,
  processesMentioning, redactorFor, sleep, userEngineStamp, waitFor, writeRecord,
} from "./m3-g6-common.mjs";

const EXE = resolve(argValue("--exe", EXE_DEFAULT));
const PORT = Number(argValue("--port", "9464"));
const ID = Date.now().toString(36);
const BASE = join(resolve(argValue("--base", join(tmpdir(), "muse-proofs-g6", "m3-03"))), ID);
const OUT = argValue("--out", "docs/evidence/2026-10-13-macos-closure/m3-03-mcpb-lifecycle.json");
const DATA = join(BASE, "data");
const STATE = join(BASE, "pkg-state");
const PROJECT = join(BASE, "project");
const PKG_NAME = `g6-pack-${ID}`;
const PKG_ID = `mcpb-${PKG_NAME}`;
const REVISIONS = join(DATA, "mcp-packages", PKG_ID);
const FIXTURE = readFileSync(fileURLToPath(new URL("./m3-01-mcp-fixture-server.mjs", import.meta.url)));
const redact = redactorFor(BASE);
mkdirSync(PROJECT, { recursive: true });
mkdirSync(STATE, { recursive: true });

// ---- a minimal zip writer (stored entries), so entry names are exactly the test's -------------
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function zip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content);
    const nameBuf = Buffer.from(name);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 6); local.writeUInt16LE(0, 8);
    local.writeUInt32LE(0, 10); local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26); local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0, 8); central.writeUInt16LE(0, 10);
    central.writeUInt32LE(0, 12); central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, data);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}
const manifest = (version, extra = {}) => J({ name: PKG_NAME, version, description: "M3-03 macOS proof package",
  server: { type: "node", entry_point: "server.mjs", args: ["--state", STATE, "--name", PKG_NAME, "--version", version] }, ...extra });
const goodPackage = (version) => zip({ "manifest.json": manifest(version), "server.mjs": FIXTURE });
const PACKAGES = {
  v100: ["g6-pack-1.0.0.mcpb", goodPackage("1.0.0")],
  notZip: ["not-a-zip.mcpb", Buffer.from("this is not a zip archive\n")],
  noSemver: ["no-semver.mcpb", zip({ "manifest.json": manifest("1.0"), "server.mjs": FIXTURE })],
  noEntry: ["no-entry.mcpb", zip({ "manifest.json": manifest("1.0.0") })],
  unsafePath: ["unsafe-path.mcpb", zip({ "manifest.json": manifest("1.0.0"), "server.mjs": FIXTURE, "../escape.txt": "outside\n" })],
  badRuntime: ["bad-runtime.mcpb", zip({ "manifest.json": J({ ...JSON.parse(manifest("1.0.0")), server: { type: "deno", entry_point: "server.mjs" } }), "server.mjs": FIXTURE })],
  v200dead: ["g6-pack-2.0.0.mcpb", zip({ "manifest.json": manifest("2.0.0"), "server.mjs": "process.exit(1);\n" })],
  v110: ["g6-pack-1.1.0.mcpb", goodPackage("1.1.0")],
};

const serverLog = () => { try { return readFileSync(join(STATE, "log.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const stateOf = (pid) => { try { return execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).trim() || null; } catch { return null; } };
const alive = (pid) => { const s = stateOf(pid); return s !== null && !s.startsWith("Z"); };
const revisions = () => { try { return readdirSync(REVISIONS).filter((n) => !n.startsWith(".stage")).sort(); } catch { return []; } };
const stages = () => { try { return readdirSync(REVISIONS).filter((n) => n.startsWith(".stage")).length; } catch { return 0; } };
const filesOf = (version) => { try { return readdirSync(join(REVISIONS, version)).sort(); } catch { return null; } };

/** Hand a package to the panel's file input, as the picker would, and wait for the install to settle. */
async function installThroughPicker(app, [fileName, bytes]) {
  const before = (await ipcCalls(app)).length;
  const result = await app.ev(page(`
    nav('Extensions'); await pause(400);
    const input = document.querySelector('label.package-picker input[type=file]');
    if (!input) return { picked: false };
    const before = banners().length;
    const bytes = Uint8Array.from(atob(${J(bytes.toString("base64"))}), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], ${J(fileName)}, { type: 'application/zip' }));
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await pause(200);
    for (let i = 0; i < 300 && /Installing package/.test(text(document.querySelector('label.package-picker span')) || ''); i++) await pause(100);
    await pause(400);
    const e = connectors().find((c) => c.id === ${J(PKG_ID)});
    return { picked: true, banners: banners(), entry: e ? { status: e.status, version: e.package?.version ?? null, sourceName: e.package?.sourceName ?? null, tools: e.tools.map((t) => t.name),
      commandHasRevision: e.package ? (e.command || '').includes('/mcp-packages/' + ${J(PKG_ID)} + '/' + e.package.version + '/server.mjs') : null,
      previousPackage: e.previousPackage?.version ?? null } : null,
      row: text(connectorRow(${J(PKG_NAME)})) };
  `));
  result.ipc = (await ipcCalls(app)).slice(before).filter((c) => /^mcp_/.test(c.cmd)).map((c) => ({ cmd: c.cmd, ok: c.ok, error: c.ok ? undefined : String(c.result).slice(0, 200) }));
  result.revisionsOnDisk = revisions();
  result.stagingLeft = stages();
  return result;
}
const clearBanners = (app) => app.ev(page("for (const b of document.querySelectorAll('.error-banner button')) if (/dismiss|close|×/i.test(b.getAttribute('aria-label') || b.textContent)) b.click(); return true;"));

const record = {
  schema: "muse-desktop.macos-m3-03-mcpb-lifecycle.v1",
  ticket: "M3-03",
  date: new Date().toISOString().slice(0, 10),
  commit: COMMIT,
  platform: platform(),
  engine: null,
  liveTurns: 0,
  harness: "scripts/macos/m3-03-mcpb-lifecycle.mjs on scripts/macos/test-instance.mjs; the package server is scripts/macos/m3-01-mcp-fixture-server.mjs, zipped by the script",
  criteria: "docs/plans/2026-09-15-agent-implementation-plan.md §M3-03 (a failed install, an incompatible update, disabling during a call and deletion; registry and runtime consistent) and docs/ROADMAP.md §M3-03 (validation of manifest.json, semver, runtime and entry point; immutable revisions under app_data/mcp-packages/<id>/<version> by staging and atomic rename; the server never executed during installation; provenance, version and source displayed; rollback)",
  isolation: null,
  method: [
    "One isolated instance of the debug build (ADR 0003 amendment): fresh data folder (the app data, so mcp-packages lives there), its own WKWebView store, the pinned engine, CDP through the test bridge.",
    "No DOM.setFileInputFiles on the bridge: each package is given to the panel's own file input as a File built in the page from the bytes on disk, through DataTransfer, then a change event. From the input on, the path is the user's (ConnectorPanel onChange -> installMcpPackage -> mcp_package_install -> probe).",
    "Packages are zipped by the script (stored entries) so the entry names are exactly the scenario's, including '../escape.txt'.",
    "The package server logs every request with its pid and its parent; processes are read with ps (a zombie, state Z, counts as gone).",
    "There is no per-row call button for an installed bundle: the call in flight during Disable is the app's own persistent-call command (mcp_local_call_persistent, what the panel's call uses), issued from the page and not awaited; Disable is the row's real toggle.",
  ],
  phases: {},
  verdicts: {},
  limits: [],
};

const userBefore = userEngineStamp();
let inst = null;
let failure = null;
try {
  inst = await launch({ exe: EXE, port: PORT, data: DATA });
  const { app } = inst;
  record.engine = inst.engineVersion;
  record.isolation = inst.isolation;
  await installTrace(app);
  await pickDefaultFolder(app, PROJECT);
  await openExtensions(app);

  // ---- install v1.0.0 ----------------------------------------------------------------
  const logMark = serverLog().length;
  const install = await installThroughPicker(app, PACKAGES.v100);
  const installLog = serverLog().slice(logMark);
  const installCall = install.ipc.findIndex((c) => c.cmd === "mcp_package_install");
  record.phases.install = { ...install, files: filesOf("1.0.0"), serverLog: installLog.map((e) => ({ parent: e.parent, event: e.event, method: e.method ?? undefined, server: e.server })),
    processesAfter: installLog.filter((e) => e.event === "start").map((e) => alive(e.pid)) };
  record.verdicts.installedThroughPicker = install.entry?.status === "installed" && install.entry.version === "1.0.0" && install.entry.sourceName === PACKAGES.v100[0]
    && install.entry.commandHasRevision === true && J(install.entry.tools) === J(["g6_echo", "g6_slow", "g6_crash"])
    && /MCP Bundle v1\.0\.0 · g6-pack-1\.0\.0\.mcpb/.test(install.row ?? "") && J(install.revisionsOnDisk) === J(["1.0.0"]) && J(filesOf("1.0.0")) === J(["manifest.json", "server.mjs"])
    && install.stagingLeft === 0;
  record.verdicts.installOrderInstallThenProbe = installCall === 0 && install.ipc[1]?.cmd === "mcp_local_probe"
    && installLog.filter((e) => e.event === "start").length === 1 && installLog.some((e) => e.method === "tools/list")
    && installLog.filter((e) => e.event === "start").every((e) => !alive(e.pid));

  // ---- failed installs ----------------------------------------------------------------------
  const failed = {};
  for (const key of ["notZip", "noSemver", "noEntry", "unsafePath", "badRuntime"]) {
    await clearBanners(app);
    failed[key] = await installThroughPicker(app, PACKAGES[key]);
  }
  record.phases.failed = failed;
  const untouched = (r) => r.entry?.version === "1.0.0" && r.entry?.status === "installed" && J(r.revisionsOnDisk) === J(["1.0.0"]) && r.stagingLeft === 0;
  record.verdicts.failedInstallsRefusedCleanly =
    failed.notZip.banners.some((b) => /not a valid zip archive/.test(b)) && failed.notZip.ipc.length === 0 && untouched(failed.notZip)
    && failed.noSemver.banners.some((b) => /semver/.test(b)) && failed.noSemver.ipc.length === 0 && untouched(failed.noSemver)
    && failed.noEntry.banners.some((b) => /entry point is missing/.test(b)) && failed.noEntry.ipc.length === 0 && untouched(failed.noEntry)
    && failed.unsafePath.banners.some((b) => /unsafe path|relative path/.test(b)) && failed.unsafePath.ipc.length === 0 && untouched(failed.unsafePath)
    && failed.badRuntime.banners.some((b) => /node or python/.test(b)) && failed.badRuntime.ipc.length === 0 && untouched(failed.badRuntime)
    && !existsSync(join(DATA, "mcp-packages", "escape.txt")) && !existsSync(join(DATA, "escape.txt"));

  // ---- incompatible update, same version again, valid update, rollback ------------------------------
  await clearBanners(app);
  const dead = await installThroughPicker(app, PACKAGES.v200dead);
  await clearBanners(app);
  const again = await installThroughPicker(app, PACKAGES.v100);
  await clearBanners(app);
  const v110 = await installThroughPicker(app, PACKAGES.v110);
  const rollback = await app.ev(page(`
    const li = connectorRow(${J(PKG_NAME)});
    const b = button('Roll back', li);
    if (!b) return { clicked: false };
    b.click();
    await pause(500);
    const e = connectors().find((c) => c.id === ${J(PKG_ID)});
    return { clicked: true, feedback: text(connectorRow(${J(PKG_NAME)})?.querySelector('.integration-refresh-feedback')), version: e?.package?.version ?? null,
      commandHasRevision: (e?.command || '').includes('/mcp-packages/' + ${J(PKG_ID)} + '/1.0.0/server.mjs'), row: text(connectorRow(${J(PKG_NAME)})) };
  `));
  record.phases.update = { incompatible: dead, sameVersionAgain: again, valid: v110, rollback, revisionsAfterRollback: revisions() };
  record.verdicts.incompatibleUpdateRefusedOldKept = dead.banners.some((b) => /did not return any tools; nothing was registered/.test(b))
    && dead.ipc.some((c) => c.cmd === "mcp_package_install" && c.ok) && dead.ipc.some((c) => c.cmd === "mcp_package_remove")
    && untouched(dead) && dead.entry?.commandHasRevision === true;
  record.verdicts.sameVersionRefused = again.banners.some((b) => /already installed/.test(b)) && untouched(again);
  record.verdicts.validUpdateThenRollback = v110.entry?.version === "1.1.0" && v110.entry.previousPackage === "1.0.0" && v110.entry.commandHasRevision === true
    && J(v110.revisionsOnDisk) === J(["1.0.0", "1.1.0"]) && /MCP Bundle v1\.1\.0/.test(v110.row ?? "")
    && rollback.clicked && rollback.version === "1.0.0" && rollback.commandHasRevision && /Previous MCP Bundle revision restored/.test(rollback.feedback ?? "");

  // ---- disable during a call ------------------------------------------------------------------------
  let mark = serverLog().length;
  const started = await app.ev(page(`
    button('Start server', connectorRow(${J(PKG_NAME)}))?.click();
    for (let i = 0; i < 100 && !button('Stop server', connectorRow(${J(PKG_NAME)})); i++) await pause(100);
    return { feedback: text(connectorRow(${J(PKG_NAME)})?.querySelector('.integration-refresh-feedback')) };
  `));
  const runPid = serverLog().slice(mark).find((e) => e.event === "start")?.pid ?? null;
  const runServer = serverLog().slice(mark).find((e) => e.event === "start")?.server ?? null;
  await app.ev(`(window.__g6call = window.__TAURI_INTERNALS__.invoke('mcp_local_call_persistent', { connectorId: ${J(PKG_ID)}, toolName: 'g6_slow', arguments: { ms: 8000 } })
    .then((r) => ({ ok: true, isError: r?.isError ?? null, text: JSON.stringify(r?.result ?? null).slice(0, 200) }), (e) => ({ ok: false, error: String(e).slice(0, 200) })), window.__g6callStarted = Date.now(), true)`);
  const inFlight = await waitFor(() => serverLog().slice(mark).find((e) => e.event === "call" && e.tool === "g6_slow") ?? null, 5_000, 100);
  await sleep(1_000);
  const disabled = await app.ev(page(`
    const li = connectorRow(${J(PKG_NAME)});
    const box = li && [...li.querySelectorAll('label.integration-toggle')].find((l) => /Disable|Enable/.test(l.title))?.querySelector('input');
    if (!box) return { clicked: false };
    const t0 = Date.now();
    box.click();
    await pause(300);
    const e = connectors().find((c) => c.id === ${J(PKG_ID)});
    return { clicked: true, atCallMs: t0 - window.__g6callStarted, statusAfter: e?.status ?? null, row: text(connectorRow(${J(PKG_NAME)})) };
  `));
  const callOutcome = await app.ev("window.__g6call");
  const gone = await waitFor(() => !alive(runPid), 15_000, 200);
  await sleep(1_000);
  const afterDisable = await app.ev(page(`
    const e = connectors().find((c) => c.id === ${J(PKG_ID)});
    const li = connectorRow(${J(PKG_NAME)});
    return { status: e?.status ?? null, row: text(li), buttons: li ? [...li.querySelectorAll('button')].map((b) => b.innerText.trim()) : [], useInMuseDisabled: [...(li?.querySelectorAll('label.integration-toggle input') || [])].map((i) => i.disabled), banners: banners() };
  `));
  const stopCall = (await ipcCalls(app, "mcp_local_stop")).at(-1) ?? null;
  const reenabled = await app.ev(page(`
    const li = connectorRow(${J(PKG_NAME)});
    const box = li && [...li.querySelectorAll('label.integration-toggle')].find((l) => /Disable|Enable/.test(l.title))?.querySelector('input');
    box?.click();
    await pause(400);
    return { status: connectors().find((c) => c.id === ${J(PKG_ID)})?.status ?? null };
  `));
  record.phases.disable = { started, runningServer: runServer, inFlight: Boolean(inFlight), disabled, callOutcome, processStoppedMs: gone ? "within 15 s" : null, afterDisable,
    stopCall: stopCall && { ok: stopCall.ok, result: stopCall.result }, serverLog: serverLog().slice(mark).map((e) => ({ event: e.event, tool: e.tool ?? undefined })), reenabled };
  record.verdicts.disableDuringCallConsistent = Boolean(runPid) && Boolean(inFlight) && disabled.clicked && disabled.atCallMs < 8_000 && disabled.statusAfter === "disabled"
    && Boolean(gone) && afterDisable.status === "disabled" && /disabled/.test(afterDisable.row ?? "") && stopCall?.ok === true
    && reenabled.status === "installed";

  // ---- delete ------------------------------------------------------------------------------------------
  mark = serverLog().length;
  await app.ev(page(`
    button('Start server', connectorRow(${J(PKG_NAME)}))?.click();
    for (let i = 0; i < 100 && !button('Stop server', connectorRow(${J(PKG_NAME)})); i++) await pause(100);
    return true;
  `));
  const delPid = serverLog().slice(mark).find((e) => e.event === "start")?.pid ?? null;
  const revisionsBeforeDelete = revisions();
  const removed = await app.ev(page(`
    button('Remove', connectorRow(${J(PKG_NAME)}))?.click();
    for (let i = 0; i < 50 && connectors().some((c) => c.id === ${J(PKG_ID)}); i++) await pause(100);
    await pause(800);
    return { entryGone: !connectors().some((c) => c.id === ${J(PKG_ID)}), rowGone: !connectorRow(${J(PKG_NAME)}), banners: banners() };
  `));
  const delGone = await waitFor(() => !alive(delPid), 10_000, 200);
  const removeCalls = (await ipcCalls(app)).filter((c) => c.cmd === "mcp_package_remove" || c.cmd === "mcp_local_stop").slice(-2).map((c) => ({ cmd: c.cmd, ok: c.ok, version: c.args?.version ?? undefined }));
  record.phases.delete = { processWasRunning: Boolean(delPid), revisionsBeforeDelete, removed, processStopped: Boolean(delGone), removeCalls, revisionsAfterDelete: revisions() };
  record.verdicts.deleteConsistent = Boolean(delPid) && removed.entryGone && removed.rowGone && Boolean(delGone)
    && removeCalls.some((c) => c.cmd === "mcp_package_remove" && c.ok && c.version === "1.0.0") && !revisions().includes("1.0.0");
  if (revisions().length > 0) {
    record.limits.push(`After Remove, the revision(s) ${J(revisions())} stay under <data>/mcp-packages/<id>/: Remove deletes the active revision only (useMuseSessions.ts uninstallConnectorById); the rolled-away revision is no longer referenced by the registry.`);
  }
  record.consoleErrors = app.errors.slice(0, 10);
} catch (error) {
  failure = String(error?.stack ?? error).slice(0, 1200);
} finally {
  if (inst) record.stop = await inst.stop();
}
await sleep(1_000);
record.leftoverProcesses = processesMentioning(BASE);
record.userEngineConfig = compareStamps(userBefore, userEngineStamp());
if (failure) record.failure = failure;
record.verdicts.cleanExit = Boolean(record.stop) && record.stop.leftAfterQuit.length === 0 && record.stop.defaultStoresUnchangedAtEnd && record.leftoverProcesses.length === 0;
record.verdicts.userEngineConfigUntouched = record.userEngineConfig.unchanged;
record.passed = !failure && Object.values(record.verdicts).every((x) => x === true);
record.limits.push(
  "The package is handed to the file input by the page (DataTransfer), not by the macOS open panel: the bridge serves no DOM.setFileInputFiles and the harness does not drive NSOpenPanel.",
  "The host's view of the bundle's tools (Use in Muse) is the M3-01 path (same injection of a local command); it is not replayed here.",
);
const out = redact(record);
writeRecord(OUT, out);
console.log(J({ passed: out.passed, verdicts: out.verdicts, failure: out.failure ?? null, leftover: out.leftoverProcesses, limits: out.limits }, null, 2));
process.exit(out.passed ? 0 : 1);
