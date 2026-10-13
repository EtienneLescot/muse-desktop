#!/usr/bin/env node
/**
 * M0-09 on macOS: keep data with no silent failure.
 *
 * The Windows proofs of 25-26/09/2026 (m0-09-corruption-sweep,
 * m0-09-recovery-roundtrip, m0-09-external-import-migration) replayed in one
 * isolated instance on the pinned engine, after one live turn so that
 * projects, conversations and a transcript exist:
 *
 *   export      Settings > Export recovery snapshot, clicked with a trusted
 *               mouse event. The status line, the snapshot the page built
 *               (read from the Blob handed to URL.createObjectURL), and
 *               whether a file reached the disk (~/Downloads listed by name,
 *               the data folder). WKWebView downloads only through a
 *               download delegate; Tauri sets one only for an on_download
 *               handler.
 *   roundTrip   the page's snapshot imported back through the Settings file
 *               input (set by DataTransfer: the open panel is native and
 *               cannot be driven), preview, one damaged entry selected and
 *               restored, value checked after the reload.
 *   checksum    the same snapshot with one value changed and the checksum
 *               kept: refused, nothing restored.
 *   external    a CLI-style JSON config given to Library > Import config
 *               through its file input; then the same JSON typed in the
 *               paste box, recorded as an observation (macOS text
 *               substitution).
 *   legacy      a legacy muse.workspace alias, Settings > Migrate legacy data.
 *   corruption  nine keys, one at a time: 'not-json-M09', reload, read at
 *               +6 s, then the original value put back. Then two keys
 *               corrupted and Settings read for its warning.
 *   quota       (variant) localStorage filled to WebKit's quota, then a
 *               draft typed: the app must say the draft is not saved.
 *
 *   node scripts/macos/m0-09-data-no-silent-failure.mjs [--exe <muse-desktop>] [--port 9415]
 *
 * One live turn. Writes docs/evidence/2026-10-13-macos-closure/m0-09-data-no-silent-failure.json.
 */
import { mkdirSync, readdirSync, renameSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { argValue } from "../cdp-harness.mjs";
import { launch } from "./test-instance.mjs";
import { newProjectConversation, sendFirstMessage } from "./smoke-real-turn.mjs";
import { BASE, COMMIT, EXE, J, assistantHas, clickSelector, now, openSession, platform, sidebar, sleep, typeInComposer, view, waitFor, writeRecord } from "./m0-g1-helpers.mjs";

const PORT = Number(argValue("--port", "9415"));
const ID = Date.now().toString(36).toUpperCase();
const ROOT = join(BASE, "m0-09", ID);
const PROJECT = join(ROOT, "project");
const DATA = join(ROOT, "data");
const DOWNLOADS = join(homedir(), "Downloads");
mkdirSync(PROJECT, { recursive: true });

const record = {
  schema: "muse-desktop.m0-09-data-no-silent-failure.v1",
  ticket: "M0-09",
  date: now().slice(0, 10),
  commit: COMMIT,
  platform: platform(),
  engine: null,
  liveTurns: 1,
  harness: `scripts/macos/m0-09-data-no-silent-failure.mjs on scripts/macos/test-instance.mjs (launch), bridge port ${PORT}`,
  isolation: null,
  method: "One isolated instance on the pinned engine; a project conversation with one live turn. Buttons clicked with trusted AppKit mouse events, text typed with Input.insertText, reloads with Page.reload. The snapshot file is fed to the app's own hidden file inputs through a DataTransfer and a change event (the native open panel cannot be driven); everything after that is the app's code. ~/Downloads is only listed (names and times), never written by the harness.",
  scenarios: {},
  checks: {},
  verdicts: {},
  limits: [
    "The export lands in ~/Downloads (WebKit's download destination for the app); the harness moves the new file to the proof folder right after, so the user's Downloads is left as found.",
    "The file inputs are fed by DataTransfer, not through the native open panel (NSOpenPanel through wry's runOpenPanel): picking the file by hand stays unproven on macOS.",
    "The engine's session store (~/.local/share/muse/sessions) is the user's, shared by the test instance (ADR 0003).",
    "Debug build in test mode, not the release build.",
  ],
};

const inst = await launch({ exe: EXE, port: PORT, data: DATA });
record.engine = inst.engineVersion;
record.isolation = inst.isolation;
const { app } = inst;
let sid = null;

const ready = () => waitFor(() => app.ev("location.protocol === 'tauri:' && document.readyState === 'complete' && Boolean(document.querySelector('.primary-nav'))").catch(() => false), 30_000, 250);
const reload = async () => { await app.send("Page.reload", {}); await sleep(800); return Boolean(await ready()); };
const nav = async (label) => { await clickSelector(app, `.primary-nav button[aria-label="${label}"], button[aria-label="${label}"]`); await sleep(800); };
const get = (key) => app.ev(`localStorage.getItem(${J(key)})`);
const set = (key, value) => app.ev(value === null ? `(localStorage.removeItem(${J(key)}), true)` : `(localStorage.setItem(${J(key)}, ${J(value)}), true)`);
const status = () => app.ev(`[...document.querySelectorAll('.settings-panel p[role="status"]')].map((p) => p.innerText.trim())`);
const recoveryFiles = () => { try { return readdirSync(DOWNLOADS).filter((n) => n.startsWith("muse-desktop-recovery-")).map((n) => ({ name: n, mtimeMs: statSync(join(DOWNLOADS, n)).mtimeMs })); } catch (e) { return `unreadable: ${e.code}`; } };
const filesUnder = (dir) => { const out = []; const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) walk(p); else out.push(p.slice(dir.length + 1)); } }; try { walk(dir); } catch { /* none */ } return out; };
/** Feeds `text` as a JSON file to the file input matching `selector` (the app's own onChange runs). */
const feedFile = (selector, name, text) => app.ev(`(() => {
  const input = document.querySelector(${J(selector)});
  if (!input) return false;
  const dt = new DataTransfer();
  dt.items.add(new File([${J(text)}], ${J(name)}, { type: 'application/json' }));
  input.files = dt.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
})()`);
/** Trusted click on the first element under `scope` whose text is `text`. */
let tag = 0;
const clickByText = async (scope, text) => {
  const id = `m09-${++tag}`;
  const found = await app.ev(`(() => { const n = [...document.querySelectorAll(${J(scope)})].find((x) => x.innerText.trim() === ${J(text)}); if (!n) return false; n.setAttribute('data-m09', ${J(id)}); return true; })()`);
  return found && clickSelector(app, `[data-m09="${id}"]`);
};
const settingsWarning = () => app.ev(`(() => { const w = document.querySelector('.settings-storage-warning'); return w ? { title: w.querySelector('strong')?.innerText ?? null, items: [...w.querySelectorAll('li')].map((li) => li.innerText.trim()) } : null; })()`);

try {
  record.start = await newProjectConversation(app, PROJECT);
  sid = await sendFirstMessage(app, `Reply with exactly DATA-${ID} and nothing else.`);
  record.firstTurn = Boolean(await waitFor(async () => (await assistantHas(app, sid, `DATA-${ID}`)) && !(await sidebar(app)).find((r) => r.sid === sid)?.running, 180_000, 500));
  await waitFor(async () => (await view(app)).connection === "Connected", 30_000, 250);

  // export ------------------------------------------------------------------------
  {
    const s = record.scenarios.export = {};
    await nav("Settings");
    await app.ev(`(() => {
      const original = URL.createObjectURL.bind(URL);
      window.__m09 = { blobs: [], anchors: [] };
      URL.createObjectURL = (obj) => { const url = original(obj); if (obj instanceof Blob) obj.text().then((t) => window.__m09.blobs.push({ url, type: obj.type, text: t })); return url; };
      const click = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function () { window.__m09.anchors.push({ download: this.download, href: this.href.slice(0, 40) }); return click.call(this); };
      return true;
    })()`);
    const downloadsBefore = recoveryFiles();
    const dataBefore = filesUnder(DATA);
    const t0 = Date.now();
    s.clicked = await clickByText(".settings-panel button", "Export recovery snapshot");
    await sleep(6_000);
    s.status = await status();
    s.anchor = await app.ev(`window.__m09.anchors`);
    const blob = await app.ev(`window.__m09.blobs.at(-1) || null`);
    let snapshot = null;
    try { snapshot = JSON.parse(blob?.text ?? "null"); } catch { snapshot = null; }
    s.snapshotBuiltByPage = snapshot ? { bytes: blob.text.length, format: snapshot.format ?? null, version: snapshot.version ?? null, checksum: String(snapshot.checksum ?? "").slice(0, 20), entries: Object.keys(snapshot.entries ?? {}).length } : null;
    const downloadsAfter = recoveryFiles();
    s.newFilesInDownloads = Array.isArray(downloadsAfter) && Array.isArray(downloadsBefore) ? downloadsAfter.filter((f) => !downloadsBefore.some((b) => b.name === f.name) || f.mtimeMs >= t0) : downloadsAfter;
    // The file is the app's, written by WebKit to the user's Downloads: moved to the proof folder so Downloads is left as found.
    s.movedToProofFolder = Array.isArray(s.newFilesInDownloads) ? s.newFilesInDownloads.map((f) => { try { renameSync(join(DOWNLOADS, f.name), join(ROOT, f.name)); return f.name; } catch (e) { return `not moved: ${e.code}`; } }) : [];
    s.newFilesInDataFolder = filesUnder(DATA).filter((f) => !dataBefore.includes(f) && /recovery/i.test(f));
    s.pageStillTheApp = await app.ev(`location.protocol === 'tauri:' && Boolean(document.querySelector('.primary-nav'))`);
    s.appOutputAboutDownload = inst.output.filter((l) => /download/i.test(l)).slice(-5);
    record.checks.exportStatusClaimsDownload = s.status.some((t) => t.startsWith("Recovery snapshot downloaded"));
    record.checks.exportFileReachedDisk = (Array.isArray(s.newFilesInDownloads) && s.newFilesInDownloads.length > 0) || s.newFilesInDataFolder.length > 0;
    record.checks.exportSnapshotBuilt = Boolean(s.snapshotBuiltByPage && s.snapshotBuiltByPage.entries > 0);
    record.snapshotText = blob?.text ?? null; // removed before writing
  }

  // roundTrip ---------------------------------------------------------------------
  {
    const s = record.scenarios.roundTrip = {};
    const original = await get("muse-desktop.projects.v1");
    const damaged = JSON.stringify(JSON.parse(original).map((p) => ({ ...p, name: `DAMAGED-${ID}` })));
    await set("muse-desktop.projects.v1", damaged);
    s.damaged = (await get("muse-desktop.projects.v1")) === damaged;
    s.fed = await feedFile('.settings-panel input[type=file][accept*="json"]', "muse-desktop-recovery.json", record.snapshotText);
    s.preview = await waitFor(() => app.ev(`(() => { const g = document.querySelector('.settings-recovery'); if (!g) return null; return { title: g.querySelector('#settings-recovery-title')?.innerText ?? null, count: g.querySelector('.settings-recovery-head .muted')?.innerText ?? null, rows: [...g.querySelectorAll('.settings-recovery-item')].length, projectsRow: [...g.querySelectorAll('.settings-recovery-item')].find((r) => r.innerText.includes('muse-desktop.projects.v1'))?.innerText.replace(/\\s+/g, ' ') ?? null, checkedByDefault: [...g.querySelectorAll('.settings-recovery-item input:checked')].length }; })()`), 10_000, 250);
    // Only the damaged entry: every ticked box unticked, then projects.v1 ticked, with trusted clicks.
    for (let i = 0; i < 50; i++) {
      const id = `m09-box-${i}`;
      const more = await app.ev(`(() => { const box = document.querySelector('.settings-recovery-item input:checked'); if (!box) return false; box.setAttribute('data-m09', ${J(id)}); return true; })()`);
      if (!more) break;
      await clickSelector(app, `[data-m09="${id}"]`);
      await sleep(300);
    }
    await app.ev(`(() => { const row = [...document.querySelectorAll('.settings-recovery-item')].find((r) => r.querySelector('code')?.innerText === 'muse-desktop.projects.v1'); row?.querySelector('input')?.setAttribute('data-m09', 'projects-box'); return Boolean(row); })()`);
    s.tickedProjects = await clickSelector(app, '[data-m09="projects-box"]');
    await sleep(500); // the trusted click reaches the page through the event loop
    s.selected = await app.ev(`[...document.querySelectorAll('.settings-recovery-item')].filter((r) => r.querySelector('input').checked).map((r) => r.querySelector('code').innerText)`);
    s.restoreClicked = await clickByText(".settings-recovery-actions button", "Restore selected");
    await sleep(1_500);
    await ready();
    await sleep(1_500);
    const after = await get("muse-desktop.projects.v1");
    s.restored = after === original;
    s.projectNameAfter = (() => { try { return JSON.parse(after).map((p) => p.name); } catch { return "unreadable"; } })();
    record.checks.recoveryRoundTrip = Boolean(s.damaged && s.fed && s.preview && J(s.selected) === J(["muse-desktop.projects.v1"]) && s.restored);
  }

  // checksum ----------------------------------------------------------------------
  {
    const s = record.scenarios.checksum = {};
    await nav("Settings");
    const tampered = JSON.parse(record.snapshotText);
    tampered.entries["muse-desktop.projects.v1"] = tampered.entries["muse-desktop.projects.v1"].map((p) => ({ ...p, name: `TAMPERED-${ID}` }));
    const before = await get("muse-desktop.projects.v1");
    s.fed = await feedFile('.settings-panel input[type=file][accept*="json"]', "tampered.json", JSON.stringify(tampered));
    await sleep(2_000);
    s.status = await status();
    s.previewShown = await app.ev(`Boolean(document.querySelector('.settings-recovery'))`);
    s.unchanged = (await get("muse-desktop.projects.v1")) === before;
    record.checks.checksumRefused = s.fed && s.status.some((t) => t.includes("checksum mismatch")) && !s.previewShown && s.unchanged;
  }

  // external ----------------------------------------------------------------------
  {
    const s = record.scenarios.external = {};
    await nav("Library");
    const config = JSON.stringify({ sessions: [{ session_id: `m09-cli-${ID}-1`, title: "CLI session one", workspace: "/tmp/m09", lastActive: "2026-10-13T08:00:00Z" }, { id: `m09-cli-${ID}-2`, title: "CLI session two" }] });
    const PANEL = 'section[aria-label="Import CLI/IDE config"]';
    s.panel = await app.ev(`Boolean(document.querySelector('${PANEL} textarea'))`);
    // The config chosen as a file (the panel's "Choose a file…" input): the import criterion.
    s.fed = await feedFile(`${PANEL} input[type=file]`, "config.json", config);
    await sleep(1_500);
    const stored = await get("muse-desktop.import.v1");
    s.stored = (() => { try { return JSON.parse(stored).map((x) => ({ id: x.id, title: x.title })); } catch { return stored; } })();
    s.rows = await app.ev(`[...document.querySelectorAll('${PANEL} .collab-row span:first-child')].map((x) => x.innerText)`);
    s.notes = await app.ev(`[...document.querySelectorAll('${PANEL} li.muted')].map((x) => x.innerText).slice(0, 5)`);
    record.checks.externalImport = Array.isArray(s.stored) && [[`m09-cli-${ID}-1`, "CLI session one"], [`m09-cli-${ID}-2`, "CLI session two"]].every(([id, title]) => s.stored.some((x) => x.id === id && x.title === title));
    // Observation, not a criterion: the same JSON typed into the paste box
    // (Input.insertText, as keystrokes) goes through macOS automatic quote
    // substitution, which can turn a straight quote into a curly one.
    await app.ev(`(document.querySelector('${PANEL} textarea').focus(), true)`);
    const typed = config.replaceAll(`${ID}-`, `${ID}-T`);
    await app.send("Input.insertText", { text: typed });
    await waitFor(() => app.ev(`document.querySelector('${PANEL} textarea').value.length > 0`), 5_000, 100);
    const value = await app.ev(`document.querySelector('${PANEL} textarea').value`);
    const at = [...typed].findIndex((ch, i) => value[i] !== ch);
    s.typedObservation = { valueIdentical: value === typed, firstDifference: at < 0 ? null : { sent: typed.slice(Math.max(0, at - 6), at + 6), got: value.slice(Math.max(0, at - 6), at + 6) } };
    await clickByText(`${PANEL} button`, "Import text");
    await sleep(1_500);
    s.typedObservation.notes = await app.ev(`[...document.querySelectorAll('${PANEL} li.muted')].map((x) => x.innerText).slice(-1)`);
  }

  // legacy ------------------------------------------------------------------------
  {
    const s = record.scenarios.legacy = {};
    const legacyValue = JSON.stringify(PROJECT);
    s.currentBefore = await get("muse-desktop.workspace.v1");
    await set("muse-desktop.workspace.v1", null);
    await set("muse.workspace", legacyValue);
    await nav("Settings");
    s.clicked = await clickByText(".settings-panel button", "Migrate legacy data");
    await sleep(300);
    s.status = await status();
    await sleep(1_500);
    await ready();
    s.migrated = (await get("muse-desktop.workspace.v1")) === legacyValue;
    s.legacyKept = (await get("muse.workspace")) === legacyValue;
    record.checks.legacyMigration = s.clicked && s.migrated && s.legacyKept && s.status.some((t) => t.startsWith("Migrated 1 legacy entry"));
    await set("muse.workspace", null);
    if (s.currentBefore !== null) await set("muse-desktop.workspace.v1", s.currentBefore);
  }

  // corruption --------------------------------------------------------------------
  {
    const s = record.scenarios.corruption = { keys: [] };
    const KEYS = ["projects.v1", "sessions.v1", "schedule-runs.v1", "review-queue.v1", "queued-turns.v1", "connectors.v1", "memory.v1", "thread-projects.v1", "settings.v1"].map((k) => `muse-desktop.${k}`);
    for (const key of KEYS) {
      const original = await get(key);
      await set(key, "not-json-M09");
      const alive = await reload();
      await sleep(6_000);
      const value = await get(key);
      let outcome;
      if (value === "not-json-M09") outcome = "corrupted value kept (never overwritten)";
      else if (value === null) outcome = "removed";
      else { try { const parsed = JSON.parse(value); outcome = Array.isArray(parsed) && parsed.length === 0 ? "reset to []" : `replaced by valid JSON (${value.length} B)`; } catch { outcome = "replaced by other invalid value"; } }
      const conversationsShown = await app.ev(`document.querySelectorAll('.session-item[data-session-id]').length`);
      s.keys.push({ key, originalBytes: original?.length ?? null, appAlive: alive && (await app.ev("Boolean(document.querySelector('.primary-nav'))")), outcome, conversationsShown });
      await set(key, original);
      await reload();
    }
    // Reporting: two keys corrupted, Settings read.
    const p0 = await get("muse-desktop.projects.v1");
    const m0 = await get("muse-desktop.memory.v1");
    await set("muse-desktop.projects.v1", "not-json-M09");
    await set("muse-desktop.memory.v1", "not-json-M09");
    await reload();
    await sleep(2_000);
    await nav("Settings");
    s.settingsWarning = await settingsWarning();
    await set("muse-desktop.projects.v1", p0);
    await set("muse-desktop.memory.v1", m0);
    await reload();
    await sleep(1_500);
    s.restoredAfterwards = (await get("muse-desktop.projects.v1")) === p0;
    record.checks.corruptionNoCrash = s.keys.every((k) => k.appAlive);
    record.checks.projectsNeverOverwritten = s.keys.find((k) => k.key === "muse-desktop.projects.v1")?.outcome.startsWith("corrupted value kept");
    record.checks.corruptionReported = Boolean(s.settingsWarning?.title === "Local data needs attention" && s.settingsWarning.items.some((t) => t.includes("Corrupted data") && t.includes("muse-desktop.projects.v1")));
  }

  // quota (variant) ---------------------------------------------------------------
  {
    const s = record.scenarios.quota = {};
    s.filled = await app.ev(`(() => {
      // Ever smaller chunks until not one more byte fits.
      let n = 0, error = null;
      for (const size of [256 * 1024, 16 * 1024, 1024, 64, 8, 1]) {
        const chunk = 'x'.repeat(size);
        try { for (let i = 0; i < 100000; i++, n++) localStorage.setItem('m09-fill-' + n, chunk); } catch (e) { error = String(e.name || e); }
      }
      return { keys: n, error };
    })()`);
    await openSession(app, sid);
    await typeInComposer(app, `QUOTA-DRAFT-${ID}`, { enter: false });
    await sleep(1_500);
    s.draftWarning = await app.ev(`document.querySelector('.composer-draft-warning')?.innerText ?? null`);
    s.draftStored = (await get(`muse-desktop.draft.${sid}`)) === `QUOTA-DRAFT-${ID}`;
    await nav("Settings");
    s.settingsWarning = await settingsWarning();
    await app.ev(`(() => { for (const k of Object.keys(localStorage).filter((k) => k.startsWith('m09-fill-'))) localStorage.removeItem(k); return true; })()`);
    record.checks.quotaVariantSaysSo = Boolean(s.filled?.error) && !s.draftStored && (Boolean(s.draftWarning) || Boolean(s.settingsWarning?.items?.some((t) => t.includes("Storage quota reached"))));
  }
  record.consoleErrors = app.errors.slice(0, 20);
} catch (error) {
  record.failure = String(error?.message ?? error);
} finally {
  record.stop = await inst.stop();
}
delete record.snapshotText;
const c = record.checks;
c.nothingLeft = record.stop.leftAfterQuit.length === 0 && record.stop.groupLeftAfterQuit.length === 0 && record.stop.defaultStoresUnchangedAtEnd === true;
record.verdicts = {
  rescueExportReachesDisk: Boolean(c.exportFileReachedDisk),
  exportNeverClaimsWhatDidNotHappen: Boolean(c.exportFileReachedDisk || !c.exportStatusClaimsDownload),
  recoveryRoundTripWithPreview: Boolean(c.recoveryRoundTrip),
  checksumVerifiedBeforeRestore: Boolean(c.checksumRefused),
  externalFormatImport: Boolean(c.externalImport),
  legacyAliasMigration: Boolean(c.legacyMigration),
  corruptionNoCrashNoSilentErasure: Boolean(c.corruptionNoCrash && c.projectsNeverOverwritten && c.corruptionReported),
  quotaVariant: Boolean(c.quotaVariantSaysSo),
  nothingLeft: Boolean(c.nothingLeft),
};
record.passed = !record.failure && Object.values(record.verdicts).every(Boolean);
console.log(JSON.stringify(writeRecord("m0-09-data-no-silent-failure.json", record), null, 2));
process.exit(record.passed ? 0 : 1);
