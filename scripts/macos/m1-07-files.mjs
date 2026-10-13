#!/usr/bin/env node
/**
 * M1-07 on macOS: the files half of the Windows record
 * (scripts/cdp-m1-files-fork.mjs, docs/evidence/2026-09-26-m1-closure/
 * m1-07-09-files-fork.json) replayed in one isolated test instance
 * (scripts/macos/test-instance.mjs) on the pinned engine, in a scratch
 * workspace under --base (itself under /var/folders, a symlinked root on
 * macOS: /var -> /private/var).
 *
 *   - a text file previews from disk; Add to prompt puts the preview in the
 *     composer with its provenance (path, size);
 *   - an office file stays out of the text preview;
 *   - a 550-entry folder lists the first 200 with the explicit note;
 *     and which 200 they are (the first 200 by name or not);
 *   - an on-disk rename appears after Refresh: replayed inside the 550-entry
 *     folder as on Windows, and in a folder under the bound;
 *   - deleting the browsed folder on disk yields a bounded error, and Up
 *     recovers;
 *   - beyond the Windows record (ticket text): the native watcher (FSEvents
 *     here) flags the view stale after an outside write, and a symlink
 *     leaving the workspace is listed but not opened.
 *
 *   node scripts/macos/m1-07-files.mjs --exe ~/muse-proofs/app/08b291d/muse-desktop \
 *     [--port 9432] [--base $TMPDIR/muse-proofs-g3] [--out-dir docs/evidence/2026-10-13-macos-closure]
 *     [--out-file m1-07-files.json] [--build-commit 08b291d]
 *
 * One live turn (the conversation is created by its first message).
 */
import { mkdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { argValue, redactor, sleep, waitFor } from "../cdp-harness.mjs";
import { launch, processTree } from "./test-instance.mjs";
import { newProjectConversation, sendFirstMessage, transcript } from "./smoke-real-turn.mjs";
import { writeEvidence } from "./m1-01-08-evidence.mjs";

const EXE = resolve(argValue("--exe", "src-tauri/target/debug/muse-desktop"));
const PORT = Number(argValue("--port", "9432"));
const BASE = resolve(argValue("--base", join(tmpdir(), "muse-proofs-g3")));
const OUT_DIR = argValue("--out-dir", null);
const OUT_FILE = argValue("--out-file", "m1-07-files.json");
const BUILD = argValue("--build-commit", "08b291d");
const FIXED_BUILD = BUILD !== "08b291d";
const ID = Date.now().toString(36);
const ROOT = join(BASE, `m1-files-${ID}`);
const WS = join(ROOT, "workspace");
const OUTSIDE = join(ROOT, "outside");

mkdirSync(WS, { recursive: true });
mkdirSync(OUTSIDE, { recursive: true });
writeFileSync(join(OUTSIDE, "secret.txt"), "outside the workspace\n");
writeFileSync(join(WS, "main.rs"), ["fn main() {", '    println!("files on macOS");', ...Array.from({ length: 12 }, (_, i) => `    // filler line ${i + 1}`), "}\n"].join("\n"));
writeFileSync(join(WS, "fake.docx"), Buffer.concat([Buffer.from("PK\x03\x04"), Buffer.alloc(2048)]));
symlinkSync(OUTSIDE, join(WS, "zz-outside-link"));
symlinkSync(join(WS, "main.rs"), join(WS, "zz-inside-link.rs"));

const record = { schema: "muse-desktop.m1-07-files-macos.v1", ticket: "M1-07", date: new Date().toISOString().slice(0, 10), liveTurns: 0, steps: {}, verdict: {} };
const step = (name, data) => { record.steps[name] = data; console.error(`- ${name}: ${JSON.stringify(data).slice(0, 260)}`); return data; };

const inst = await launch({ exe: EXE, port: PORT, data: join(ROOT, "data") });
const { app } = inst;
record.engine = inst.engineVersion;
record.isolation = inst.isolation;
const ev = (expr) => app.ev(expr);
const must = async (label, probe, ms = 30_000, every = 500) => {
  const value = await waitFor(probe, ms, every);
  if (!value) throw new Error(`timeout: ${label}`);
  return value;
};
const rows = () => ev(`[...document.querySelectorAll(".files-list .file-row")].map((r) => ({ name: r.querySelector(".file-name")?.textContent ?? "", disabled: r.disabled, title: r.title }))`);
const clickRow = (name) => ev(`(() => { const r = [...document.querySelectorAll(".files-list .file-row")].find((x) => (x.querySelector(".file-name")?.textContent ?? "").startsWith(${JSON.stringify(name)})); if (!r || r.disabled) return false; r.click(); return true; })()`);
const filesButton = (label) => ev(`(() => { const b = [...document.querySelectorAll('[aria-label="Workspace files"] button')].find((x) => x.textContent.trim() === ${JSON.stringify(label)}); if (!b || b.disabled) return false; b.click(); return true; })()`);

try {
  step("project", { start: await newProjectConversation(app, WS) });
  const sid = await sendFirstMessage(app, "Reply with exactly FILES-READY and nothing else.");
  if (!sid) throw new Error("no session started");
  record.sid = sid;
  record.liveTurns += 1;
  await must("first turn", async () => (await transcript(app, sid)).some((e) => e.role === "assistant" && String(e.text).includes("FILES-READY")), 180_000, 1_000);

  await ev(`(() => { if (!document.querySelector("nav.work-tabs")) document.querySelector('button[aria-label="Show work panel"]')?.click(); })()`);
  await sleep(600);
  await ev(`[...document.querySelectorAll("nav.work-tabs button")].find((b) => b.textContent.trim() === "Files")?.click()`);
  await must("files listed", async () => (await rows()).length > 0, 30_000);
  step("root-listing", { rows: await rows() });

  // text preview + Add to prompt with provenance
  await clickRow("main.rs");
  const preview = step("text-preview", await must("main.rs preview", () => ev(`(() => {
    const head = document.querySelector(".file-preview-head strong")?.textContent ?? "";
    const code = document.querySelector(".file-preview-code")?.textContent ?? "";
    return head === "main.rs" && code.includes("files on macOS") ? { head, size: document.querySelector(".file-preview-actions span")?.textContent ?? "", firstLine: code.split("\\n")[0] } : null;
  })()`), 20_000));
  await ev(`[...document.querySelectorAll(".file-preview button")].find((x) => x.textContent.trim() === "Add to prompt")?.click()`);
  const composed = await must("composer filled", async () => { const v = await ev(`document.querySelector('textarea[aria-label="Message Muse"]')?.value ?? ""`); return v.includes("fn main") ? v : null; }, 10_000, 300);
  step("add-to-prompt", { composerExcerpt: composed.slice(0, 260), length: composed.length });
  record.verdict.textPreviewAndPrompt = preview.head === "main.rs" && composed.includes("main.rs") && composed.includes('println!("files on macOS")');
  record.verdict.promptCarriesProvenance = /main\.rs/.test(composed.split("fn main")[0]);
  await ev(`(() => { const a = document.querySelector('textarea[aria-label="Message Muse"]'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(a, ""); a.dispatchEvent(new Event("input", { bubbles: true })); })()`);

  // office file guarded
  await clickRow("fake.docx");
  const office = step("office-preview", await must("office preview", () => ev(`(() => {
    const head = document.querySelector(".file-preview-head strong")?.textContent ?? "";
    if (head !== "fake.docx") return null;
    const text = document.querySelector(".file-preview")?.textContent ?? "";
    return { guarded: /could not be safely previewed|Binary content is not rendered|no inline preview/.test(text), textPreview: !!document.querySelector(".file-preview-code") };
  })()`), 20_000));
  record.verdict.officeGuarded = office.guarded && !office.textPreview;

  // symlinks: inside target opens, outside target is listed but disabled
  const linkRows = (await rows()).filter((r) => r.name.startsWith("zz-"));
  const outsideOpened = await clickRow("zz-outside-link");
  await sleep(1200);
  const afterOutside = await ev(`({ path: document.querySelector(".files-meta")?.textContent ?? "", preview: document.querySelector(".file-preview-head strong")?.textContent ?? "", error: document.querySelector(".files-error")?.textContent ?? null })`);
  step("symlink-guard", { linkRows, outsideClickable: outsideOpened, afterOutside });
  record.verdict.symlinkLeavingWorkspaceNotOpened = linkRows.some((r) => r.name.startsWith("zz-outside-link") && r.disabled) && !outsideOpened && !/secret/.test(JSON.stringify(afterOutside));

  // native watcher: an outside write flags the view stale
  writeFileSync(join(WS, "watched.txt"), "written outside the app\n");
  const stale = await waitFor(() => ev(`document.querySelector(".files-stale")?.textContent ?? null`), 15_000, 500);
  step("watcher-stale", { banner: stale });
  record.verdict.watcherFlagsStale = Boolean(stale && /changed on disk/.test(stale));

  // 550 entries -> first 200 with the note
  const bulk = join(WS, "bulk");
  mkdirSync(bulk, { recursive: true });
  for (let i = 0; i < 550; i += 1) writeFileSync(join(bulk, `f-${String(i).padStart(4, "0")}.txt`), `${i}\n`);
  await filesButton("Refresh");
  await sleep(1200);
  await clickRow("bulk");
  const bounded = step("bounded-listing", await must("bulk listed", async () => {
    const r = await rows();
    return r.length >= 100 ? { rows: r.length, note: await ev(`document.querySelector(".files-note")?.textContent ?? ""`), path: await ev(`document.querySelector(".files-meta")?.textContent ?? ""`) } : null;
  }, 25_000));
  record.verdict.boundedListing = bounded.rows === 200 && /first 200 entries/.test(bounded.note);
  // which 200? the note says "the first 200": compare with the first 200 by name
  const shown = (await rows()).map((r) => r.name);
  const firstByName = Array.from({ length: 200 }, (_, i) => `f-${String(i).padStart(4, "0")}.txt`);
  const shownInFirst = shown.filter((n) => firstByName.includes(n)).length;
  step("bounded-listing-which-200", { shownFirst5: shown.slice(0, 5), shownLast: shown.at(-1), shownAmongFirst200ByName: shownInFirst });
  record.verdict.boundedListingIsFirst200ByName = shownInFirst === 200;

  // Windows replay: rename inside the truncated folder (f-0000 -> aaa-renamed sorts first)
  renameSync(join(bulk, "f-0000.txt"), join(bulk, "aaa-renamed.txt"));
  await sleep(300);
  await filesButton("Refresh");
  const truncatedRename = await waitFor(async () => {
    const names = (await rows()).map((r) => r.name);
    return names.includes("aaa-renamed.txt") ? { hasRenamed: true, hasOld: names.includes("f-0000.txt") } : null;
  }, 10_000, 500);
  const namesAfter = (await rows()).map((r) => r.name);
  step("rename-in-truncated-folder", truncatedRename ?? { hasRenamed: false, hasOld: namesAfter.includes("f-0000.txt"), rows: namesAfter.length, shownFirst3: namesAfter.slice(0, 3) });
  record.verdict.renameReflectedInTruncatedFolder = Boolean(truncatedRename?.hasRenamed && !truncatedRename.hasOld);

  // the criterion itself, in a folder under the bound: rename on disk, Refresh
  const small = join(WS, "small");
  mkdirSync(small, { recursive: true });
  for (const n of ["one.txt", "two.txt", "three.txt"]) writeFileSync(join(small, n), `${n}\n`);
  await filesButton("Up");
  await must("back at root", async () => (await rows()).some((r) => r.name === "main.rs"), 20_000);
  await filesButton("Refresh");
  await must("small listed", async () => (await rows()).some((r) => r.name === "small/"), 20_000);
  await clickRow("small");
  await must("small open", async () => (await rows()).some((r) => r.name === "two.txt"), 20_000);
  renameSync(join(small, "two.txt"), join(small, "two-renamed.txt"));
  await sleep(300);
  await filesButton("Refresh");
  const renamed = step("rename-reflected", await must("rename visible", async () => {
    const names = (await rows()).map((r) => r.name);
    return names.includes("two-renamed.txt") ? { hasRenamed: true, hasOld: names.includes("two.txt"), names } : null;
  }, 20_000));
  record.verdict.renameReflected = renamed.hasRenamed && !renamed.hasOld;
  await filesButton("Up");
  await must("back at root", async () => (await rows()).some((r) => r.name === "main.rs"), 20_000);
  await clickRow("bulk");
  await must("bulk reopened", async () => (await rows()).length >= 100, 20_000);

  // deleted browsed folder -> bounded error; Up recovers
  rmSync(bulk, { recursive: true, force: true });
  await filesButton("Refresh");
  const err = await must("deleted folder error", () => ev(`document.querySelector(".files-error")?.textContent || null`), 25_000);
  step("deleted-folder", { error: err.slice(0, 200) });
  record.verdict.deletedFolderBoundedError = err.length > 0 && err.length < 400;
  await filesButton("Up");
  const recovered = await must("Up recovers", async () => { const r = await rows(); return r.some((x) => x.name === "main.rs") ? r.map((x) => x.name) : null; }, 20_000);
  step("recovered-up", { rows: recovered, errorGone: !(await ev(`document.querySelector(".files-error")?.textContent || null`)) });
  record.verdict.appSurvivesAndUpRecovers = recovered.includes("main.rs");
  record.processes = processTree(inst.pid).map((p) => p.command.replace(/^.*\//, "").slice(0, 120));
} catch (error) {
  record.failure = String(error?.message ?? error);
} finally {
  record.consoleErrors = app.errors.slice(0, 20);
  record.stop = await inst.stop();
}

// The Windows criteria; the rename is judged in a folder under the bound, the
// truncated-folder replay is reported apart (boundedListingIsFirst200ByName,
// renameReflectedInTruncatedFolder) because it depends on the listing defect.
const required = ["textPreviewAndPrompt", "promptCarriesProvenance", "officeGuarded", "boundedListing", "renameReflected", "deletedFolderBoundedError", "appSurvivesAndUpRecovers"];
record.verdict.allWindowsCriteria = !record.failure && required.every((k) => record.verdict[k] === true);
record.passed = record.verdict.allWindowsCriteria && record.stop.leftAfterQuit.length === 0 && record.stop.defaultStoresUnchangedAtEnd;
const out = redactor([[realpathSync(BASE), "<g3>"], [BASE, "<g3>"], [homedir(), "~"]])(record);
if (OUT_DIR) {
  const v = record.verdict;
  const firstRunDefect = "macOS defect holding the ticket at ◐: ";
  writeEvidence({ dir: OUT_DIR, exe: EXE, base: BASE, record, commit: BUILD, harness: `node scripts/macos/m1-07-files.mjs --exe <exe> --port ${PORT} --base <tmp> --out-dir <dir>${FIXED_BUILD ? ` --out-file ${OUT_FILE} --build-commit ${BUILD}` : ""} (scripts/macos/test-instance.mjs launch(), scripts/cdp-harness.mjs)`, entries: [{
    file: OUT_FILE, ticket: "M1-07", windowsReference: "docs/evidence/2026-09-26-m1-closure/m1-07-09-files-fork.json (M1-07 half)",
    method: "One isolated instance, one conversation created from the welcome screen on a scratch workspace under the run's temp folder (itself below /var/folders, a symlinked root on macOS). The Files tab was driven in the page (element.click() on rows and buttons, as in the Windows record); files were created, renamed and deleted on disk by the harness with Node's fs, never through the app."
      + (FIXED_BUILD ? ` Replay on ${BUILD} (files::list sorts in display order, folders then names, before the bound): boundedListingIsFirst200ByName and renameReflectedInTruncatedFolder, false on 08b291d, are now expected true, and ticketMacos ☑.` : ""),
    checks: record.steps,
    verdicts: { ...v, ticketMacos: v.allWindowsCriteria && v.boundedListingIsFirst200ByName ? "☑" : "◐" },
    ...(FIXED_BUILD ? { previousRun: { file: "docs/evidence/2026-10-13-macos-closure/m1-07-files.json", commit: "08b291d", defectThen: "a 550-entry folder showed 200 entries taken in APFS read_dir (hash) order and then sorted, under the note 'the first 200 entries': 75 of the 200 shown were among the first 200 by name, and f-0000.txt renamed to aaa-renamed.txt on disk never appeared after Refresh (boundedListingIsFirst200ByName and renameReflectedInTruncatedFolder false, ticketMacos ◐)." } } : {}),
    limits: [...(FIXED_BUILD ? [] : [firstRunDefect + "a folder over the 200-entry bound lists 200 entries taken in read_dir order and only then sorted (src-tauri/src/files.rs, list: the loop stops pushing at max_entries before entries.sort_by). NTFS returns names in order, so on Windows these are the first 200 by name; APFS returns them in hash order, so on macOS the view shows an arbitrary 200, sorted, under a note that says 'the first 200 entries' (measured: 75 of the 200 shown are among the first 200 by name), and an entry renamed on disk may never appear after Refresh (the Windows replay of the rename inside the 550-entry folder fails; the same rename in a folder under the bound appears). Not data loss, not security. Fix direction (not applied): collect the names, sort, then truncate."]), "Open in app (the system default handler, LaunchServices here) was not clicked: it would open an app on the user's desktop; the Windows record did not click it either.", "The watcher and symlink checks go beyond the Windows record (ticket text); they are recorded, not closing criteria."],
  }] });
}
console.log(JSON.stringify(out, null, 2));
process.exit(record.passed ? 0 : 1);
