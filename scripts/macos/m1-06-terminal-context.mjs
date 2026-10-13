#!/usr/bin/env node
/**
 * M1-06 native macOS proof: have the engine read the terminal output.
 *
 * The plan's acceptance (a failing build command, the output available to the
 * right agent; terminal B not reachable through a target mix-up; non-blocking
 * capture), plus the two Windows pieces (Add output to prompt bounded to the
 * 12,000-character fallback; Run in Muse through the host's userShell), in one
 * isolated instance on the pinned engine. Two live turns.
 *
 * Two projects A and B, one conversation each, created from the welcome screen
 * with their first message refused by the harness IPC guard (no turn). Then:
 *  1. B's terminal prints SECRET-B-<id>.
 *  2. A's terminal runs a failing build (exit 2, BUILD-FAIL-<id> on stderr),
 *     then a ticker; Add output to prompt is clicked while the ticker runs.
 *  3. B's composer stays free of A's output; Add output in B carries B only.
 *  4. Turn 1 in A: the composer (A's terminal block + a question) is sent; the
 *     model must answer with A's token and exit code, never B's.
 *  5. A 2,500-line output: the block stays within 12,001 characters, tail kept.
 *  6. Run in Muse in A (a command echoing RUN-IN-MUSE-<id>): the userShell item
 *     and its output show in the thread; turn 2 asks the model for the token.
 *
 *   node scripts/macos/m1-06-terminal-context.mjs --exe ~/muse-proofs/app/08b291d/muse-desktop
 *     [--port 9443] [--base $TMPDIR/muse-proofs-g4/m1-06] [--out docs/evidence/2026-10-13-macos-closure/m1-06-terminal-context-macos.json]
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { argValue, sleep, waitFor } from "../cdp-harness.mjs";
import { newProjectConversation, sendFirstMessage, transcript } from "./smoke-real-turn.mjs";
import { launch } from "./test-instance.mjs";
import { INSTALL_TERMINAL_TAPS, descendants, platform, redactPaths, sameAlive, terminalDriver } from "./m1-05-terminal-lib.mjs";

const EXE = resolve(argValue("--exe", "src-tauri/target/debug/muse-desktop"));
const PORT = Number(argValue("--port", "9443"));
const ID = Date.now().toString(36).toUpperCase();
const BASE = resolve(argValue("--base", join(tmpdir(), "muse-proofs-g4", `m1-06-${ID.toLowerCase()}`)));
const OUT = argValue("--out", null);
const A = join(BASE, "project-a");
const B = join(BASE, "project-b");
const ZDOT = join(BASE, "zdotdir");
const PROMPT_MARK = "[m1p ";
const FAIL = `BUILD-FAIL-${ID}`;
const SECRET = `SECRET-B-${ID}`;
const RIM = `RUN-IN-MUSE-${ID}`;

function fixtures() {
  for (const dir of [A, B]) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "README.md"), "M1-06 proof project\n");
  }
  writeFileSync(join(A, "build.sh"), [
    "# M1-06 proof: a failing build (stdout, then an error on stderr, exit 2).",
    "echo compiling main.c",
    "echo main.c:12: error: BUILD-FAIL-$1 undefined symbol frobnicate >&2",
    "exit 2",
    "",
  ].join("\n"));
  writeFileSync(join(A, "tick.py"), "# M1-06 proof: a ticker.\nimport time\nfor i in range(1, 151):\n    print(f'tick {i}', flush=True)\n    time.sleep(0.2)\n");
  writeFileSync(join(A, "big.py"), "# M1-06 proof: a large output.\nfor i in range(1, 2501):\n    print(f'LIGNE-{i}-M1-06')\n");
  for (const dir of [A, B]) {
    execFileSync("git", ["init", "-q"], { cwd: dir });
    execFileSync("git", ["add", "-A"], { cwd: dir });
    execFileSync("git", ["-c", "user.name=proof", "-c", "user.email=proof@example.invalid", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "M1-06 proof"], { cwd: dir });
  }
  mkdirSync(ZDOT, { recursive: true });
  writeFileSync(join(ZDOT, ".zshrc"), "PROMPT='[m1p %/]%# '\n");
}

const record = {
  schema: "muse-desktop.m1-06-terminal-context-macos.v1",
  ticket: "M1-06",
  date: new Date().toISOString().slice(0, 10),
  commit: "08b291d",
  platform: platform(),
  engine: null,
  liveTurns: 0,
  harness: `scripts/macos/m1-06-terminal-context.mjs (+ m1-05-terminal-lib.mjs) on scripts/macos/test-instance.mjs, bridge port ${PORT}`,
  isolation: null,
  method: "One isolated instance on the pinned engine. Projects A and B under the proof's temp folder, one conversation each from the welcome screen, first message refused by the harness IPC guard (no turn). Terminal input through the panel's field (CDP Input.insertText of a whole line, real Enter; Ctrl+C as an AppKit key event). Add output to prompt and Run in Muse are clicked in the page. The composer question is inserted after the terminal block and sent with a real Enter. Replies are read from the stored transcript (muse-desktop.log.v1.<sid>) and the screen. The shell's ZDOTDIR points at a proof folder (one-line prompt), so the user's zsh files are not touched.",
  checks: {},
  verdicts: {},
  findings: [
    "Engine side, macOS: Run in Muse reaches the host (session/userShell accepted, the item and its text shown in the thread), but the command never runs: 'managed shell sandbox is unavailable'. m1-06-usershell-probe-macos.json reproduces it without the app, on the pinned 1.4.2 engine started from node with the app's flags: the Workspace and Network postures fail, only --disable-sandbox (the Elevated posture) runs the command. So it is not the app's spawn context. The 27/09 Windows reading of scripts/msp-user-shell-items.mjs ('markerEchoed: true') counts the marker inside the command text itself, so it cannot tell a run from a failure.",
  ],
  limits: [
    "Run in Muse output and a turn reading it are not proved on macOS (engine sandbox, above); the ticket's labelled-insertion path (Add output to prompt) carries the engine-reads-output criterion, as on Windows.",
    "Terminal input inserted as whole lines (no smart-quote substitution; see M1-05 typed-quotes).",
  ],
};
const check = (name, data) => {
  record.checks[name] = data;
  console.error(`- ${name}: ${JSON.stringify(data).slice(0, 320)}`);
};

fixtures();
const redact = redactPaths([[A, "<project-a>"], [B, "<project-b>"], [ZDOT, "<zdotdir>"], [BASE, "<proof>"]]);
const inst = await launch({ exe: EXE, port: PORT, data: join(BASE, "data"), env: { ZDOTDIR: ZDOT } });
record.engine = inst.engineVersion;
record.isolation = inst.isolation;
const { app } = inst;
const t = terminalDriver(app);
const watched = [];

const composer = () => app.ev("document.querySelector('textarea[aria-label=\"Message Muse\"]')?.value ?? null");
const setComposer = (text) => app.ev(`(() => { const a = document.querySelector('textarea[aria-label="Message Muse"]'); const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; set.call(a, ${JSON.stringify(text)}); a.dispatchEvent(new Event('input', { bubbles: true })); return a.value.length; })()`);
const select = async (sid) => {
  await app.ev(`(document.querySelector('li.session-item[data-session-id="${sid}"] button.session-select')?.click(), true)`);
  return waitFor(() => app.ev(`document.querySelector('li.session-item.active')?.getAttribute('data-session-id') === ${JSON.stringify(sid)} && Boolean(document.querySelector('textarea[aria-label="Message Muse"]'))`), 10_000, 200);
};
const running = () => app.ev("document.querySelector('.task-metadata .dot')?.getAttribute('data-running') === 'true'");
const blockBlock = (text) => {
  const raw = String(text).split("<terminal-output>").pop()?.split("</terminal-output>")[0] ?? "";
  return raw.replace(/^\n/, "").replace(/\n$/, "");
};

/** A conversation in `folder` whose first message the harness refuses. */
async function conversation(folder, label) {
  const ready = await newProjectConversation(app, folder);
  if (ready !== "ready") throw new Error(`welcome flow (${label}): ${ready}`);
  await app.ev("(window.__baselineIpc.block = ['send_input'], true)");
  const sid = await sendFirstMessage(app, `M1-06 macOS proof, conversation ${label}. The harness refuses this message.`);
  if (!sid) throw new Error(`start_session failed (${label})`);
  await waitFor(() => app.ev("document.querySelectorAll('.pending-send').length > 0"), 20_000, 300);
  for (let i = 0; i < 4; i++) {
    const discarded = await app.ev("(() => { const b = [...document.querySelectorAll('.pending-send button')].find((n) => n.innerText.trim() === 'Discard'); if (b) b.click(); return !!b; })()");
    if (!discarded) break;
    await sleep(800);
  }
  await app.ev("(window.__baselineIpc.block = [], true)");
  await app.ev(INSTALL_TERMINAL_TAPS);
  return sid;
}

/** Appends `question` to the composer and sends with a real Enter; waits for the reply holding `expect`. */
async function ask(sid, question, expect) {
  await app.ev("(() => { const a = document.querySelector('textarea[aria-label=\"Message Muse\"]'); a.focus(); a.setSelectionRange(a.value.length, a.value.length); return true; })()");
  await app.send("Input.insertText", { text: question });
  await waitFor(async () => (await composer())?.endsWith(question), 5_000, 100);
  const sent = await composer();
  const before = (await transcript(app, sid)).length;
  await app.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", text: "\r" });
  await app.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter" });
  record.liveTurns += 1;
  const reply = await waitFor(async () => {
    const log = await transcript(app, sid);
    const hit = log.slice(before).find((e) => e.role === "assistant" && String(e.text).includes(expect));
    return hit && !(await running()) ? hit : null;
  }, 240_000, 1_000);
  const log = (await transcript(app, sid)).slice(before);
  return {
    sentChars: sent?.length ?? 0,
    userEntryHasBlock: log.some((e) => e.role === "user" && String(e.text).includes("<terminal-output>")),
    reply: reply ? String(reply.text).slice(0, 300) : null,
    assistantTexts: log.filter((e) => e.role === "assistant").map((e) => String(e.text).slice(0, 200)),
  };
}

try {
  const sidA = await conversation(A, "A");
  const sidB = await conversation(B, "B");
  check("conversations", { a: Boolean(sidA), b: Boolean(sidB), distinct: sidA !== sidB });

  // ---- 1. B's terminal holds B's token ---------------------------------------
  const openedB = await t.attach(sidB);
  await t.until(0, (a) => a.includes(PROMPT_MARK), 15_000);
  const echoB = await t.run(`echo ${SECRET}`, (a) => new RegExp(`\\n${SECRET}\\n`).test(a), 8_000);
  const termB = t.current;
  check("terminal-b", { opened: Boolean(openedB?.terminalId), cwdIsB: openedB?.cwd?.endsWith("project-b"), printed: echoB.ok });

  // ---- 2. A: failing build, then a ticker; capture while it runs -------------
  if (!(await select(sidA))) throw new Error("could not select A");
  const openedA = await t.attach(sidA);
  await t.until(0, (a) => a.includes(PROMPT_MARK), 15_000);
  const termA = t.current;
  const build = await t.run(`sh build.sh ${ID}; echo exit=$?`, (a) => /exit=\d+/.test(a), 10_000);
  const exitCode = Number(build.added.match(/exit=(\d+)/)?.[1] ?? NaN);
  await setComposer("DRAFT-TYPED-BEFORE-ADD-OUTPUT");
  const tickFrom = await t.rawLength();
  await t.typeLine("python3 tick.py");
  await t.until(tickFrom, (a) => /tick 5\n/.test(a), 8_000);
  const ticker = descendants(inst.pid).find((p) => /tick\.py/.test(p.command)) ?? null;
  watched.push(ticker);
  const ticksBefore = Math.max(0, ...[...(await t.rawSince(tickFrom)).matchAll(/tick (\d+)/g)].map((m) => Number(m[1])));
  const clickMs = await app.ev(`(async () => {
    const t0 = performance.now();
    document.querySelector('button.terminal-context').click();
    const area = () => document.querySelector('textarea[aria-label="Message Muse"]');
    for (let i = 0; i < 100 && !(area()?.value || '').includes(${JSON.stringify(FAIL)}); i++) await new Promise((r) => setTimeout(r, 20));
    return { filledAfterMs: Math.round(performance.now() - t0), filled: (area()?.value || '').includes(${JSON.stringify(FAIL)}) };
  })()`);
  await sleep(1_500);
  const ticksAfter = Math.max(0, ...[...(await t.rawSince(tickFrom)).matchAll(/tick (\d+)/g)].map((m) => Number(m[1])));
  const tickerAlive = sameAlive(ticker);
  const cFrom = await t.rawLength();
  await t.ctrl("c");
  await t.until(cFrom, (a) => a.includes(PROMPT_MARK), 5_000);
  const composedA = await composer();
  const blockA = blockBlock(composedA);
  check("capture-a", {
    terminalOpenedInA: openedA?.cwd?.endsWith("project-a"), distinctTerminals: termA !== termB,
    buildFailed: build.ok, exitCode, stderrShown: build.added.includes(`main.c:12: error: ${FAIL}`),
    addOutput: clickMs, ticksBeforeClick: ticksBefore, ticksAfterClick: ticksAfter, tickerAliveAfterClick: tickerAlive,
    composerChars: composedA?.length ?? 0,
    provenanceHeader: (composedA ?? "").split("\n").find((l) => l.startsWith("[Terminal output ·")) ?? null,
    blockHasFailure: blockA.includes(FAIL), blockHasExitCode: blockA.includes("exit=2"), blockHasB: (composedA ?? "").includes(SECRET),
    draftTypedBeforeKept: (composedA ?? "").includes("DRAFT-TYPED-BEFORE-ADD-OUTPUT"),
    rawEscapesInBlock: (blockA.match(/\x1b\[/g) || []).length,
  });
  record.verdicts.failingBuildCaptured = Boolean(build.ok && exitCode === 2 && blockA.includes(FAIL) && blockA.includes("exit=2"));
  record.verdicts.captureNonBlocking = Boolean(clickMs.filled && clickMs.filledAfterMs < 1_000 && ticksAfter > ticksBefore && tickerAlive);

  // ---- 3. B is not reachable from A, and A's block does not leak into B ------
  if (!(await select(sidB))) throw new Error("could not select B");
  await sleep(800);
  const composerBBefore = await composer();
  await t.workTab("Terminal");
  await waitFor(() => app.ev("Boolean(document.querySelector('button.terminal-context'))"), 8_000, 200);
  await app.ev("(document.querySelector('button.terminal-context').click(), true)");
  await waitFor(async () => (await composer())?.includes(SECRET), 5_000, 100);
  const composedB = await composer();
  await setComposer("");
  check("no-target-mixup", {
    composerBBeforeHasA: (composerBBefore ?? "").includes(FAIL),
    addOutputInBHasB: (composedB ?? "").includes(SECRET), addOutputInBHasA: (composedB ?? "").includes(FAIL),
    headerB: (composedB ?? "").split("\n").find((l) => l.startsWith("[Terminal output ·")) ?? null,
  });
  if (!(await select(sidA))) throw new Error("could not select A again");
  await sleep(800);
  const composerABack = await composer();
  record.checks["no-target-mixup"].composerAKeptItsBlock = (composerABack ?? "").includes(FAIL);
  if (!(composerABack ?? "").includes(FAIL)) {
    // The draft did not survive the switch: add A's output again.
    await t.workTab("Terminal");
    await waitFor(() => app.ev("Boolean(document.querySelector('button.terminal-context'))"), 8_000, 200);
    await app.ev("(document.querySelector('button.terminal-context').click(), true)");
    await waitFor(async () => (await composer())?.includes(FAIL), 5_000, 100);
  }
  record.verdicts.noTargetMixup = Boolean(!(composerBBefore ?? "").includes(FAIL) && (composedB ?? "").includes(SECRET) && !(composedB ?? "").includes(FAIL) && !(composedA ?? "").includes(SECRET));

  // ---- 4. turn 1: the model reads A's terminal block ---------------------------
  const turn1 = await ask(sidA, "\n\nThe block above is output from my terminal. Reply with only two things separated by one space: the BUILD-FAIL token exactly as printed, then the exit code.", FAIL);
  check("turn-1-engine-reads-a", { ...turn1, replyHasExitCode: /\b2\b/.test(turn1.reply ?? ""), replyHasB: (turn1.reply ?? "").includes(SECRET) });
  record.verdicts.engineReadsTerminalOutput = Boolean(turn1.userEntryHasBlock && turn1.reply?.includes(FAIL) && /\b2\b/.test(turn1.reply) && !turn1.reply.includes(SECRET));

  // ---- 5. a large output stays bounded --------------------------------------
  await t.workTab("Terminal");
  await waitFor(() => app.ev("Boolean(document.querySelector('form.terminal-input input'))"), 8_000, 200);
  await setComposer("");
  const big = await t.run("python3 big.py", (a) => a.includes("LIGNE-2500-M1-06"), 20_000);
  await app.ev("(document.querySelector('button.terminal-context').click(), true)");
  await waitFor(async () => (await composer())?.includes("LIGNE-2500-M1-06"), 5_000, 100);
  const bigBlock = blockBlock(await composer());
  check("bounded-block", { generated: big.ok, ptyChars: big.raw.length, blockChars: bigBlock.length, ellipsisPrefix: bigBlock.startsWith("…"), tailKept: bigBlock.includes("LIGNE-2500-M1-06") });
  record.verdicts.boundedTo12000 = Boolean(big.ok && big.raw.length > 12_000 && bigBlock.length <= 12_001 && bigBlock.length > 11_000 && bigBlock.startsWith("…") && bigBlock.includes("LIGNE-2500-M1-06"));
  await setComposer("");

  // ---- 6. Run in Muse (userShell) and turn 2 -----------------------------------
  const rimState = await app.ev("(() => { const b = document.querySelector('button.terminal-muse'); return b ? { disabled: b.disabled, title: b.title } : null; })()");
  await t.focusInput();
  await app.send("Input.insertText", { text: `echo ${RIM}` });
  await waitFor(async () => (await t.inputValue()) === `echo ${RIM}`, 5_000, 50);
  const rimEnabled = await app.ev("(() => { const b = document.querySelector('button.terminal-muse'); return b ? { disabled: b.disabled, title: b.title } : null; })()");
  const before = (await transcript(app, sidA)).length;
  await app.ev("(document.querySelector('button.terminal-muse').click(), true)");
  // The thread's userShell entry: "$ echo <token>" then either the output or
  // the host's failure text.
  const item = await waitFor(async () => {
    const log = (await transcript(app, sidA)).slice(before);
    const entry = log.find((e) => String(e.text ?? "").includes(`$ echo ${RIM}`));
    const body = entry ? String(entry.text).split("\n").slice(1).join("\n") : "";
    return entry && body.trim().length > 0 ? { role: entry.role, text: String(entry.text).slice(0, 320), outputLine: body.split("\n").some((l) => l.trim() === RIM), failed: /tool failed|sandbox is unavailable/.test(body) } : null;
  }, 30_000, 500);
  const onScreen = await app.ev(`[...document.querySelectorAll('.msg, article, [class*=tool]')].some((n) => (n.innerText || '').includes(${JSON.stringify(`echo ${RIM}`)}))`);
  const ipcShell = await app.ev("window.__baselineIpc.calls.filter((c) => c.cmd === 'user_shell').map((c) => ({ ok: c.ok, result: String(c.result).slice(0, 200) }))");
  check("run-in-muse", { buttonBeforeTyping: rimState, buttonWithCommand: rimEnabled, ipc: ipcShell, threadEntry: item, commandOnScreen: onScreen });
  record.verdicts.runInMuseItemShown = Boolean(item && onScreen && ipcShell.at(-1)?.ok);
  record.verdicts.runInMuseOutputShown = Boolean(item?.outputLine);
  if (item?.outputLine) {
    await sleep(1_500);
    const turn2 = await ask(sidA, "Look at the shell command I just ran through you and its output. Reply with only the RUN-IN-MUSE token it printed.", RIM);
    check("turn-2-engine-reads-usershell", turn2);
    record.verdicts.engineReadsUserShellOutput = Boolean(turn2.reply?.includes(RIM));
  }
} catch (error) {
  record.failure = String(error?.stack ?? error).slice(0, 800);
} finally {
  record.consoleErrors = inst.app.errors.slice(0, 20);
  record.stop = await inst.stop();
}
await sleep(1_000);
const survivors = watched.filter(Boolean).filter(sameAlive);
for (const p of survivors) { try { process.kill(p.pid, "SIGKILL"); } catch { /* gone */ } }
record.verdicts.noOrphanAtEnd = survivors.length === 0 && record.stop.leftAfterQuit.length === 0;
record.verdicts.isolationKept = record.stop.defaultStoresUnchangedAtEnd === true && record.stop.testStoreDeleted === true;
// The plan's acceptance and the Windows pieces. Run in Muse's output depends
// on the engine's managed shell sandbox (m1-06-usershell-probe-macos.json):
// reported, not counted; the labelled insertion is the ticket's other path.
const keys = ["failingBuildCaptured", "captureNonBlocking", "noTargetMixup", "engineReadsTerminalOutput", "boundedTo12000", "runInMuseItemShown", "noOrphanAtEnd", "isolationKept"];
record.verdicts.all = !record.failure && keys.every((k) => record.verdicts[k] === true);
const out = redact(record);
if (OUT) {
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, `${JSON.stringify(out, null, 2)}\n`);
}
console.log(JSON.stringify(out.verdicts, null, 2));
if (record.failure) console.error(record.failure);
process.exit(record.verdicts.all ? 0 : 1);
