#!/usr/bin/env node
/**
 * M4-09 on macOS: the produced DMG, installed over 0.3.0 on this Mac, with
 * the user's own data (Étienne's go of 13/10/2026: "tu peux écraser"; a copy
 * of the data was kept under ~/muse-proofs/backup-*).
 *
 *   1. gatekeeper  spctl on both DMGs (signed, notarised), codesign and spctl
 *                  on each installed app;
 *   2. 0.3.0       installed (already in place, or --install-old), launched
 *                  through LaunchServices, left running, closed;
 *   3. update      0.4.0 dragged over it (the app bundle replaced), launched,
 *                  closed: the user's data must be there, unchanged;
 *   4. uninstall   the app moved to the Bin: the data stays; reinstalled from
 *                  the DMG and launched: still there.
 *
 * "Data" is every file of ~/Library/Application Support/com.muse.desktop
 * (SHA-256) and every localStorage entry of the app's WKWebView store
 * (~/Library/WebKit/com.muse.desktop, read from a copy of the database).
 * Values the app rewrites at each launch are reported, not hidden.
 *
 * The app is launched with MUSE_NO_AUTO_UPDATE=1 (`open --env`), so the
 * engine launcher it calls keeps the pinned 1.4.2. No UI is driven here: a
 * real turn in the installed app is Étienne's (session list, step 7).
 *
 *   node scripts/macos/m4-09-dmg-smoke.mjs --old <0.3.0.dmg> --new <0.4.0.dmg>
 *     --new-commit <sha> [--out <record>]
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { argValue, sleep, waitFor } from "../cdp-harness.mjs";

const OLD = resolve(argValue("--old", ""));
const NEW = resolve(argValue("--new", ""));
const NEW_COMMIT = argValue("--new-commit", "unknown");
const OUT = argValue("--out", "docs/evidence/2026-10-13-macos-closure/m4-09-dmg-smoke-macos.json");
const APP = "/Applications/Muse-Desktop.app";
const DATA = join(homedir(), "Library", "Application Support", "com.muse.desktop");
const WEBKIT = join(homedir(), "Library", "WebKit", "com.muse.desktop");
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: "utf8", ...opts }).trim();
const shAll = (cmd, args) => { try { return sh(cmd, args, { stdio: ["ignore", "pipe", "pipe"] }); } catch (e) { return `${e.stdout ?? ""}${e.stderr ?? ""}`.trim(); } };
const sha = (buf) => createHash("sha256").update(buf).digest("hex");
const redact = (text) => String(text).replaceAll(homedir(), "~");

function gatekeeper(target, kind) {
  // spctl writes its verdict on stderr.
  const run = spawnSync("spctl", kind === "dmg" ? ["-a", "-t", "open", "--context", "context:primary-signature", "-vv", target] : ["-a", "-vv", target], { encoding: "utf8" });
  const out = `${run.stdout}${run.stderr}`;
  return { accepted: /: accepted/.test(out), source: out.match(/source=(.*)/)?.[1] ?? null, origin: out.match(/origin=(.*)/)?.[1] ?? null };
}

function install(dmg) {
  const attach = sh("hdiutil", ["attach", "-nobrowse", "-readonly", dmg]);
  const volume = attach.split("\n").at(-1).split("\t").at(-1).trim();
  try {
    rmSync(APP, { recursive: true, force: true });
    sh("cp", ["-R", join(volume, "Muse-Desktop.app"), "/Applications/"]);
  } finally {
    sh("hdiutil", ["detach", "-quiet", volume]);
  }
  return {
    version: sh("defaults", ["read", join(APP, "Contents", "Info.plist"), "CFBundleShortVersionString"]),
    codesign: shAll("codesign", ["--verify", "--deep", "--strict", APP]) === "" ? "valid" : "invalid",
    gatekeeper: gatekeeper(APP, "app"),
  };
}

/** Every Application Support file by hash, every localStorage entry by hash. */
function snapshot() {
  const files = {};
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else files[path.slice(DATA.length + 1)] = sha(readFileSync(path));
    }
  };
  if (existsSync(DATA)) walk(DATA);
  const storage = {};
  const dbs = [];
  const find = (dir) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) find(path);
      else if (entry.name === "localstorage.sqlite3") dbs.push(path);
    }
  };
  find(WEBKIT);
  for (const db of dbs) {
    // A copy with its WAL: the app's own file is never opened.
    const copy = mkdtempSync(join(tmpdir(), "muse-ls-"));
    for (const suffix of ["", "-wal", "-shm"]) if (existsSync(db + suffix)) cpSync(db + suffix, join(copy, `localstorage.sqlite3${suffix}`));
    const rows = sh("sqlite3", ["-readonly", "-separator", "\t", join(copy, "localstorage.sqlite3"), "SELECT key, hex(value) FROM ItemTable ORDER BY key;"], { maxBuffer: 512 << 20 });
    for (const line of rows.split("\n").filter(Boolean)) {
      const [key, hex] = line.split("\t");
      storage[key] = sha(Buffer.from(hex ?? "", "hex"));
    }
    rmSync(copy, { recursive: true, force: true });
  }
  return { files, storage, storageDatabases: dbs.length };
}

function compare(before, after) {
  const diff = (a, b) => ({
    missing: Object.keys(a).filter((k) => !(k in b)),
    changed: Object.keys(a).filter((k) => k in b && a[k] !== b[k]),
    added: Object.keys(b).filter((k) => !(k in a)),
  });
  return { files: diff(before.files, after.files), storage: diff(before.storage, after.storage) };
}

const appPids = () => shAll("pgrep", ["-f", `${APP}/Contents/MacOS/`]).split("\n").filter(Boolean).map(Number);

/** Launch through LaunchServices as a user would, let it settle, then close it. */
async function run(label) {
  const crashesBefore = new Set(readdirSync(join(homedir(), "Library", "Logs", "DiagnosticReports")).filter((f) => /muse/i.test(f)));
  sh("open", ["--env", "MUSE_NO_AUTO_UPDATE=1", "-a", APP]);
  const pid = await waitFor(() => appPids()[0] ?? null, 20_000, 250);
  await sleep(15_000);
  const alive = pid !== null && appPids().includes(pid);
  const children = pid ? shAll("pgrep", ["-lP", String(pid)]).split("\n").filter(Boolean).map((l) => l.replace(/^\d+\s+/, "")) : [];
  if (pid) { try { process.kill(pid, "SIGTERM"); } catch { /* gone */ } }
  const closed = await waitFor(() => appPids().length === 0, 20_000, 250);
  if (!closed) for (const p of appPids()) { try { process.kill(p, "SIGKILL"); } catch { /* gone */ } }
  const crashes = readdirSync(join(homedir(), "Library", "Logs", "DiagnosticReports")).filter((f) => /muse/i.test(f) && !crashesBefore.has(f));
  return { label, launched: pid !== null, aliveAfter15s: alive, children, closedOnSigterm: Boolean(closed), newCrashReports: crashes };
}

const report = {
  schema: "muse-desktop.m4-09-dmg-smoke-macos.v1",
  ticket: "M4-09",
  date: new Date().toISOString().slice(0, 10),
  commit: NEW_COMMIT,
  platform: `macOS ${sh("sw_vers", ["-productVersion"])} (${sh("sw_vers", ["-buildVersion"])}), ${process.arch}, Apple Silicon`,
  harness: "scripts/macos/m4-09-dmg-smoke.mjs",
  // The versioned binary the launcher runs, never the launcher itself.
  engine: (() => {
    const version = readFileSync(join(homedir(), ".local", "bin", ".muse-version"), "utf8").trim();
    return shAll("env", ["MUSE_NO_AUTO_UPDATE=1", join(homedir(), ".local", "bin", `muse-bin-${version}`), "--version"]);
  })(),
  liveTurns: 0,
  dmgs: {
    old: { file: OLD.split("/").pop(), sha256: sha(readFileSync(OLD)), gatekeeper: gatekeeper(OLD, "dmg") },
    new: { file: NEW.split("/").pop(), sha256: sha(readFileSync(NEW)), gatekeeper: gatekeeper(NEW, "dmg") },
  },
  steps: {},
  verdicts: {},
};

if (process.argv.includes("--install-old")) report.steps.installOld = install(OLD);
report.steps.installedBefore = sh("defaults", ["read", join(APP, "Contents", "Info.plist"), "CFBundleShortVersionString"]);
report.steps.runOld = await run("0.3.0");
const s1 = snapshot();
report.steps.dataAfterOld = { files: Object.keys(s1.files).length, storageEntries: Object.keys(s1.storage).length, storageDatabases: s1.storageDatabases };

report.steps.installNew = install(NEW);
const s2 = snapshot();
report.steps.installTouchedNoData = compare(s1, s2);
report.steps.runNew = await run("0.4.0");
const s3 = snapshot();
report.steps.updateComparedWithOld = compare(s1, s3);

const trash = join(homedir(), ".Trash", `Muse-Desktop-${Date.now()}.app`);
renameSync(APP, trash);
const s4 = snapshot();
report.steps.uninstall = { movedToBin: !existsSync(APP) && existsSync(trash), dataKept: compare(s3, s4) };
report.steps.reinstall = install(NEW);
report.steps.runReinstalled = await run("0.4.0 reinstalled");
const s5 = snapshot();
report.steps.reinstallComparedWithUpdate = compare(s3, s5);
rmSync(trash, { recursive: true, force: true });
report.steps.binCopyRemoved = !existsSync(trash);

const none = (d) => d.missing.length === 0 && d.changed.length === 0;
const clean = (r) => r.launched && r.aliveAfter15s && r.newCrashReports.length === 0;
report.verdicts = {
  bothDmgsNotarised: report.dmgs.old.gatekeeper.accepted && report.dmgs.new.gatekeeper.accepted && /Notarized Developer ID/.test(report.dmgs.new.gatekeeper.source ?? ""),
  installedAppAccepted: report.steps.installNew.gatekeeper.accepted && report.steps.installNew.codesign === "valid" && report.steps.installNew.version === "0.4.0",
  oldLaunches: clean(report.steps.runOld),
  newLaunchesOverOld: clean(report.steps.runNew),
  installTouchesNoData: none(report.steps.installTouchedNoData.files) && none(report.steps.installTouchedNoData.storage),
  updateKeepsEveryFile: report.steps.updateComparedWithOld.files.missing.length === 0,
  updateKeepsEveryStorageEntry: report.steps.updateComparedWithOld.storage.missing.length === 0,
  uninstallKeepsData: report.steps.uninstall.movedToBin && none(report.steps.uninstall.dataKept.files) && none(report.steps.uninstall.dataKept.storage),
  reinstallLaunchesWithData: clean(report.steps.runReinstalled) && report.steps.reinstallComparedWithUpdate.files.missing.length === 0 && report.steps.reinstallComparedWithUpdate.storage.missing.length === 0,
};
report.limits = [
  "No UI was driven in the installed app (the agent was not granted control of it): the real turn in the packaged app, the two-project scenario of M0-01 and the Gatekeeper box of a quarantined download are Étienne's (docs/plans/2026-10-13-macos-sessions-with-etienne.md, step 7).",
  "The DMGs were downloaded with the GitHub CLI, which sets no quarantine attribute: spctl checks the signature and the notarisation, not the first-open dialog.",
  "Entries the app rewrites at launch are listed under `changed`; an entry or a file is lost only if it is under `missing`.",
];
report.passed = Object.values(report.verdicts).every(Boolean);
writeFileSync(OUT, `${redact(JSON.stringify(report, null, 2))}\n`);
console.log(JSON.stringify({ passed: report.passed, verdicts: report.verdicts }, null, 2));
process.exit(report.passed ? 0 : 1);
