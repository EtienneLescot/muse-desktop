#!/usr/bin/env node
/**
 * M3-04 native macOS proof: discover SKILL.md skills on disk and in the
 * project, through Extensions > Skills > Scan workspace.
 *
 * Plan acceptance (docs/plans/2026-09-15-agent-implementation-plan.md §M3-04):
 * skills with the same name, a malformed file, a missing resource, project
 * scope and a change on disk; exact provenance. The Windows ☑ (26-27/09) rests
 * on one SKILL.md with a relative resource discovered by Scan workspace.
 *
 * The proof project (the default folder of the isolated instance) holds:
 *   SKILL.md                          root skill, project scope
 *   .agents/skills/g6-dup             "project" copy of g6-dup
 *   .muse/skills/g6-dup               "repo" copy of g6-dup (must lose)
 *   .muse/skills/g6-res               declares resources: notes.txt (present)
 *   .claude/skills/g6-missing-res     declares resources: absent.txt (missing)
 *   skills/g6-bad                     no description (malformed)
 *   .muse/skills/g6-nofm              no frontmatter (malformed)
 *   .muse/skills/g6-escape            resources: ../../outside.txt (refused)
 *   .muse/skills/g6-link              a symlink to a skill outside the project (ignored)
 * then, on disk: g6-res's description changes, the project copy of g6-dup is
 * deleted, g6-new appears; Scan workspace again.
 *
 *   node scripts/macos/m3-04-skills-discovery.mjs [--exe <muse-desktop>] [--port 9465]
 *     [--base $TMPDIR/muse-proofs-g6/m3-04] [--out docs/evidence/2026-10-13-macos-closure/m3-04-skills-discovery.json]
 *
 * No live turn.
 */
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { argValue } from "../cdp-harness.mjs";
import { launch } from "./test-instance.mjs";
import {
  EXE_DEFAULT, COMMIT, J, compareStamps, installTrace, ipcCalls, openExtensions, page, pickDefaultFolder, platform,
  processesMentioning, redactorFor, sleep, userEngineStamp, writeRecord,
} from "./m3-g6-common.mjs";

const EXE = resolve(argValue("--exe", EXE_DEFAULT));
const PORT = Number(argValue("--port", "9465"));
const ID = Date.now().toString(36);
const BASE = join(resolve(argValue("--base", join(tmpdir(), "muse-proofs-g6", "m3-04"))), ID);
const OUT = argValue("--out", "docs/evidence/2026-10-13-macos-closure/m3-04-skills-discovery.json");
const PROJECT = join(BASE, "project");
const OUTSIDE = join(BASE, "outside");
const redact = redactorFor(BASE);

const put = (path, text) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };
const skill = (name, description, body, extra = "") => `---\nname: ${name}\n${description === null ? "" : `description: ${description}\n`}${extra}---\n${body}\n`;
put(join(PROJECT, "SKILL.md"), skill("g6-root", "Root skill of the proof project.", "Say G6-ROOT."));
put(join(PROJECT, ".agents/skills/g6-dup/SKILL.md"), skill("g6-dup", "Project copy of g6-dup.", "Say G6-DUP-PROJECT."));
put(join(PROJECT, ".muse/skills/g6-dup/SKILL.md"), skill("g6-dup", "Repo copy of g6-dup.", "Say G6-DUP-REPO."));
put(join(PROJECT, ".muse/skills/g6-res/SKILL.md"), skill("g6-res", "Skill with a resource.", "Use notes.txt.", "resources: [notes.txt]\n"));
put(join(PROJECT, ".muse/skills/g6-res/notes.txt"), "G6 resource notes.\n");
put(join(PROJECT, ".claude/skills/g6-missing-res/SKILL.md"), skill("g6-missing-res", "Skill whose resource is missing.", "Use absent.txt.", "resources: [absent.txt]\n"));
put(join(PROJECT, "skills/g6-bad/SKILL.md"), skill("g6-bad", null, "No description here."));
put(join(PROJECT, ".muse/skills/g6-nofm/SKILL.md"), "# g6-nofm\nNo frontmatter at all.\n");
put(join(PROJECT, ".muse/skills/g6-escape/SKILL.md"), skill("g6-escape", "Skill reaching outside.", "Read it.", "resources: [../../outside.txt]\n"));
put(join(OUTSIDE, "g6-link/SKILL.md"), skill("g6-link", "A skill outside the project, linked in.", "Say G6-LINK."));
symlinkSync(join(OUTSIDE, "g6-link"), join(PROJECT, ".muse/skills/g6-link"));

/** Scan workspace, then the panel and the stored catalogue as a user and the composer see them. */
async function scan(app) {
  const before = (await ipcCalls(app, "skills_scan")).length;
  const shown = await app.ev(page(`
    nav('Extensions'); await pause(400);
    const panel = document.querySelector('[aria-label="Skills"]');
    const b = [...panel.querySelectorAll('button')].find((n) => /Scan workspace/.test(n.textContent));
    b.click();
    for (let i = 0; i < 100 && /Scanning/.test(b.textContent); i++) await pause(100);
    await pause(400);
    const result = panel.querySelector('.skill-scan-result');
    const rows = [...panel.querySelectorAll(':scope > ul.integration-list li.integration-row')].map((li) => ({
      label: text(li.querySelector('strong')), description: text(li.querySelector('.integration-main > small:not(.muted)')),
      path: li.querySelector('.skill-path')?.getAttribute('title') ?? null,
    })).filter((r) => /^\\/g6-/.test(r.label || ''));
    return { summary: text(result?.querySelector('small')), errors: [...(result?.querySelectorAll('.skill-scan-errors li') || [])].map((n) => text(n)), rows, banners: banners() };
  `));
  const call = (await ipcCalls(app, "skills_scan")).slice(before).at(-1) ?? null;
  let documents = null;
  try { documents = JSON.parse(call.result).documents.map((d) => ({ path: d.path, source: d.source })); } catch { documents = call?.result?.slice?.(0, 300) ?? null; }
  return { ...shown, native: { ok: call?.ok ?? null, documents } };
}

const record = {
  schema: "muse-desktop.macos-m3-04-skills-discovery.v1",
  ticket: "M3-04",
  date: new Date().toISOString().slice(0, 10),
  commit: COMMIT,
  platform: platform(),
  engine: null,
  liveTurns: 0,
  harness: "scripts/macos/m3-04-skills-discovery.mjs on scripts/macos/test-instance.mjs",
  criteria: "docs/plans/2026-09-15-agent-implementation-plan.md §M3-04 (skills with the same name, a malformed file, a missing resource, project scope and a change on disk; exact provenance) and docs/ROADMAP.md §M3-04 (roots .agents/skills, .muse/skills, .claude/skills and skills, frontmatter requiring name and description, strictly relative resources, outbound symlinks ignored, precedence project > repo > team > builtin, explicit reload)",
  isolation: null,
  method: [
    "One isolated instance of the debug build (ADR 0003 amendment); the proof project, in the proof folder, is the instance's default folder (Settings > Choose folder, the dialog answered by the IPC trace), which is the folder Scan workspace reads.",
    "Every scan is the panel's Scan workspace button; the record holds what the panel shows (summary, errors, each skill's label, description and path) and the native scan's document list (path and source) from the IPC trace.",
  ],
  phases: {},
  verdicts: {},
  limits: [],
};

const userBefore = userEngineStamp();
let inst = null;
let failure = null;
try {
  inst = await launch({ exe: EXE, port: PORT, data: join(BASE, "data") });
  const { app } = inst;
  record.engine = inst.engineVersion;
  record.isolation = inst.isolation;
  await installTrace(app);
  record.phases.setup = { defaultFolder: await pickDefaultFolder(app, PROJECT) };
  await openExtensions(app);

  const first = await scan(app);
  record.phases.firstScan = first;
  const row = (r, name) => r.rows.find((x) => x.label?.startsWith(`/${name} `)) ?? null;
  const errorFor = (r, rel) => r.errors.find((e) => e.startsWith(`${rel}:`)) ?? null;
  const nativePaths = (first.native.documents ?? []).map((d) => `${d.source}:${d.path}`).sort();
  record.verdicts.rootsAndScopes = J(nativePaths) === J([
    "project:.agents/skills/g6-dup/SKILL.md", "project:SKILL.md", "repo:.claude/skills/g6-missing-res/SKILL.md",
    "repo:.muse/skills/g6-dup/SKILL.md", "repo:.muse/skills/g6-escape/SKILL.md", "repo:.muse/skills/g6-nofm/SKILL.md",
    "repo:.muse/skills/g6-res/SKILL.md", "repo:skills/g6-bad/SKILL.md",
  ].sort());
  record.verdicts.symlinkOutsideIgnored = !nativePaths.some((p) => p.includes("g6-link")) && !row(first, "g6-link");
  record.verdicts.sameNameProjectWins = row(first, "g6-dup")?.label === "/g6-dup (project)" && row(first, "g6-dup")?.description === "Project copy of g6-dup."
    && row(first, "g6-dup")?.path === ".agents/skills/g6-dup/SKILL.md" && first.rows.filter((r) => r.label?.startsWith("/g6-dup ")).length === 1;
  record.verdicts.malformedReportedWithPath = /description is required/.test(errorFor(first, "skills/g6-bad/SKILL.md") ?? "")
    && /frontmatter/.test(errorFor(first, ".muse/skills/g6-nofm/SKILL.md") ?? "")
    && /resources must be relative/.test(errorFor(first, ".muse/skills/g6-escape/SKILL.md") ?? "")
    && !row(first, "g6-bad") && !row(first, "g6-nofm") && !row(first, "g6-escape");
  record.verdicts.projectScopeAndProvenance = row(first, "g6-root")?.label === "/g6-root (project)" && row(first, "g6-root")?.path === "SKILL.md"
    && row(first, "g6-res")?.label === "/g6-res (repo)" && row(first, "g6-res")?.path === ".muse/skills/g6-res/SKILL.md"
    && /^4 discovered · /.test(first.summary ?? "");
  // A missing resource is not read at scan time (resources are read just before sending, M3-05): the skill is listed.
  record.phases.missingResourceAtScan = { listed: Boolean(row(first, "g6-missing-res")), error: errorFor(first, ".claude/skills/g6-missing-res/SKILL.md") };

  // ---- change on disk, explicit reload ---------------------------------------------------------
  put(join(PROJECT, ".muse/skills/g6-res/SKILL.md"), skill("g6-res", "Skill with a resource, edited on disk.", "Use notes.txt.", "resources: [notes.txt]\n"));
  rmSync(join(PROJECT, ".agents/skills/g6-dup"), { recursive: true, force: true });
  put(join(PROJECT, ".agents/skills/g6-new/SKILL.md"), skill("g6-new", "Added after the first scan.", "Say G6-NEW."));
  const notYet = await app.ev(page("return [...document.querySelectorAll('[aria-label=\"Skills\"] li.integration-row strong')].map((n) => text(n)).filter((t) => /g6-new/.test(t));"));
  const second = await scan(app);
  record.phases.changeOnDisk = { beforeReload: { g6NewListed: notYet.length > 0 }, secondScan: second };
  record.verdicts.changeOnDiskAfterExplicitReload = notYet.length === 0
    && row(second, "g6-res")?.description === "Skill with a resource, edited on disk."
    && row(second, "g6-dup")?.label === "/g6-dup (repo)" && row(second, "g6-dup")?.path === ".muse/skills/g6-dup/SKILL.md" && row(second, "g6-dup")?.description === "Repo copy of g6-dup."
    && row(second, "g6-new")?.label === "/g6-new (project)" && row(second, "g6-new")?.path === ".agents/skills/g6-new/SKILL.md";

  // A skill deleted on disk then rescanned: does the list drop it?
  rmSync(join(PROJECT, ".agents/skills/g6-new"), { recursive: true, force: true });
  const third = await scan(app);
  record.phases.deletedOnDisk = { thirdScan: { summary: third.summary, rows: third.rows }, g6NewStillListed: Boolean(row(third, "g6-new")) };
  record.verdicts.deletedSkillDropped = !row(third, "g6-new");
  record.consoleErrors = app.errors.slice(0, 10);
} catch (error) {
  failure = String(error?.stack ?? error).slice(0, 1200);
} finally {
  if (inst) record.stop = await inst.stop();
}
await sleep(500);
record.leftoverProcesses = processesMentioning(BASE);
record.userEngineConfig = compareStamps(userBefore, userEngineStamp());
if (failure) record.failure = failure;
record.verdicts.cleanExit = Boolean(record.stop) && record.stop.leftAfterQuit.length === 0 && record.stop.defaultStoresUnchangedAtEnd && record.leftoverProcesses.length === 0;
record.verdicts.userEngineConfigUntouched = record.userEngineConfig.unchanged;
record.passed = !failure && Object.values(record.verdicts).every((x) => x === true);
record.limits.push(
  "A declared resource that is missing is not checked at scan time: the skill is listed, and the resource is read (and refused) just before sending, which is M3-05's proof.",
  "Scan workspace reads the default folder (Settings), not the active conversation's project. The host's own catalogue (skill/list, M3-05) is a separate source: 1.4.2 lists .agents/skills and .claude/skills project skills, not .muse/skills or skills/.",
);
const out = redact(record);
writeRecord(OUT, out);
console.log(J({ passed: out.passed, verdicts: out.verdicts, failure: out.failure ?? null, missingResourceAtScan: out.phases.missingResourceAtScan, leftover: out.leftoverProcesses }, null, 2));
process.exit(out.passed ? 0 : 1);
