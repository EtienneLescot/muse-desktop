#!/usr/bin/env node
/**
 * M1-05 native macOS proof: open and use a terminal in the project.
 *
 * The plan's acceptance (interactive input, ANSI, resize, a long-running
 * server, a view change, close/restart, Unicode, no orphan process), replayed
 * in one isolated instance (scripts/macos/test-instance.mjs) of the debug
 * build on the pinned engine. No model turn: the conversation's first message
 * is refused by the harness IPC guard (send_input blocked) and discarded, as in
 * the Windows proof (scripts/cdp-m1-05-m3-02-terminal-mcp.mjs).
 *
 * The shell is the app's own choice ($SHELL, /bin/zsh here). ZDOTDIR points at
 * a proof folder holding a one-line .zshrc (a recognisable prompt), so the
 * user's ~/.zshrc is not read and the test commands never reach
 * ~/.zsh_history. Everything goes through the panel's real input: CDP
 * Input.insertText, a real Enter, Ctrl+C/Ctrl+D/Ctrl+L as AppKit key events.
 *
 *   node scripts/macos/m1-05-terminal.mjs --exe ~/muse-proofs/app/08b291d/muse-desktop
 *     [--port 9441] [--base $TMPDIR/muse-proofs-g4/m1-05] [--out docs/evidence/2026-10-13-macos-closure/m1-05-terminal-macos.json]
 *     [--build-commit 08b291d]
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { argValue, sleep, waitFor } from "../cdp-harness.mjs";
import { newProjectConversation, sendFirstMessage } from "./smoke-real-turn.mjs";
import { launch } from "./test-instance.mjs";
import { descendants, loneSurrogates, plain, platform, proc, redactPaths, replacements, request, sameAlive, shellsOf, terminalDriver } from "./m1-05-terminal-lib.mjs";

const BUILD = argValue("--build-commit", "08b291d");
const FIXED_BUILD = BUILD !== "08b291d";
const EXE = resolve(argValue("--exe", "src-tauri/target/debug/muse-desktop"));
const PORT = Number(argValue("--port", "9441"));
const ID = Date.now().toString(36);
const BASE = resolve(argValue("--base", join(tmpdir(), "muse-proofs-g4", `m1-05-${ID}`)));
const OUT = argValue("--out", null);
const PROJECT = join(BASE, "project");
const ZDOT = join(BASE, "zdotdir");
// e-acute, euro sign, grinning face, from code points.
const UNICODE = String.fromCodePoint(0xe9, 0x20ac, 0x1f600);
const PROMPT_MARK = "[m1p ";

const FIXTURES = {
  "server.py": `# M1-05 proof: a long-running HTTP server that keeps writing to the terminal.
import http.server, os, threading, time
hits = 0
class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        global hits
        hits += 1
        print(f"hit {hits} {self.path}", flush=True)
        body = f"ok {hits} pid {os.getpid()}".encode()
        self.send_response(200)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    def log_message(self, *args):
        pass
server = http.server.HTTPServer(("127.0.0.1", 0), Handler)
print(f"listening {server.server_address[1]} pid {os.getpid()}", flush=True)
def tick():
    n = 0
    while True:
        time.sleep(1)
        n += 1
        print(f"tick {n}", flush=True)
threading.Thread(target=tick, daemon=True).start()
server.serve_forever()
`,
  "cp.py": `# M1-05 proof: print the code points of one line typed into the terminal.
import sys
print("CP-READY", flush=True)
line = sys.stdin.readline().rstrip("\\n")
print("CP:" + ",".join(format(ord(c), "x") for c in line), flush=True)
`,
  "long.py": `# M1-05 proof: a long multibyte output ("wide": 3-byte CJK and a 4-byte emoji per line).
import sys
n = int(sys.argv[1])
wide = len(sys.argv) > 2
for i in range(1, n + 1):
    s = f"{i:04d}"
    print(f"W{s} 中文字符測試漢字中文字符測試漢字😀" if wide else f"U{s} ${UNICODE} 中文 ✓ ${UNICODE}")
print(f"LONG-DONE {n}")
`,
  "ansi.sh": `# M1-05 proof: SGR 16 colours, 256 colours, 24-bit, bold.
printf '\\033[31mANSI-RED\\033[0m \\033[32mANSI-GREEN\\033[0m \\033[38;5;208mANSI-C256\\033[0m \\033[38;2;10;120;250mANSI-RGB\\033[0m \\033[1mANSI-BOLD\\033[0m\\n'
`,
};

function writeFixtures() {
  mkdirSync(PROJECT, { recursive: true });
  mkdirSync(ZDOT, { recursive: true });
  for (const [name, text] of Object.entries(FIXTURES)) writeFileSync(join(PROJECT, name), text);
  writeFileSync(join(PROJECT, `name-${UNICODE}.txt`), "named with e-acute, euro sign and an emoji\n");
  writeFileSync(join(ZDOT, ".zshrc"), "PROMPT='[m1p %/]%# '\n");
  execFileSync("git", ["init", "-q"], { cwd: PROJECT });
  execFileSync("git", ["add", "-A"], { cwd: PROJECT });
  execFileSync("git", ["-c", "user.name=proof", "-c", "user.email=proof@example.invalid", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "M1-05 proof fixtures"], { cwd: PROJECT });
}

const record = {
  schema: "muse-desktop.m1-05-terminal-macos.v1",
  ticket: "M1-05",
  date: new Date().toISOString().slice(0, 10),
  commit: BUILD,
  platform: platform().replace("08b291d", BUILD),
  engine: null,
  liveTurns: 0,
  harness: `scripts/macos/m1-05-terminal.mjs (+ m1-05-terminal-lib.mjs) on scripts/macos/test-instance.mjs, bridge port ${PORT}`,
  isolation: null,
  method: "One isolated instance (own data folder, own WKWebView store, default stores compared before and after). A project folder under the proof's temp folder (git repo with four fixtures). Its conversation is created from the welcome screen; the first message is refused by the harness IPC guard (send_input blocked) then discarded: no turn reaches the engine. The Terminal work tab opens the app's PTY (portable-pty, /dev/ptmx) with the app's shell ($SHELL); ZDOTDIR points at a proof folder with a one-line .zshrc (prompt '[m1p <cwd>]% '), so ~/.zshrc and ~/.zsh_history are never touched. Input goes through the panel's own field: CDP Input.insertText, then a real Enter; Ctrl+C/D/L, Tab and Escape are AppKit key events delivered by the bridge (isTrusted). Output is read twice: the DOM the user sees and the raw terminal_read stream tapped on the page's fetch. Processes are identified by PID and start time (ps lstart); the server is requested from outside by the harness (node fetch to 127.0.0.1).",
  env: { LANG: process.env.LANG ?? null, LC_ALL: process.env.LC_ALL ?? null, LC_CTYPE: process.env.LC_CTYPE ?? null, SHELL: process.env.SHELL ?? null },
  checks: {},
  verdicts: {},
  // On a build after the fix (--build-commit other than 08b291d), unicodeShellEcho
  // and typedQuotesReachShell are expected true: the 08b291d defects go to previousRun.
  ...(FIXED_BUILD ? {
    previousRun: {
      file: "docs/evidence/2026-10-13-macos-closure/m1-05-terminal-macos.json",
      commit: "08b291d",
      defectsThen: [
        "unicodeShellEcho false: the PTY shell had no LANG (GUI app environment), zsh ran under LC_CTYPE=C, echoed typed UTF-8 as U+FFFD and <0082>-style escapes, and `ls` printed a non-ASCII name as '?????????'.",
        "typedQuotesReachShell false: typed one key at a time, `echo 'q1 q2' \"q3\" -- end` reached zsh as `echo ‘q1 q2’ “q3” — end` (system smart quotes and dashes on an input with no spellcheck attribute).",
      ],
      expectationNow: `Replay on ${BUILD} (terminal.rs sets LANG=en_US.UTF-8 when no locale is set; spellCheck={false} on the terminal input): both verdicts are expected true, with the same checks and the same harness environment (no LANG, LC_ALL or LC_CTYPE, as a Finder launch).`,
    },
  } : {}),
  findings: FIXED_BUILD ? [] : [
    "macOS code defect (unicodeShellEcho): the PTY shell gets the GUI app's environment, which on macOS carries no LANG (launchd gives none to apps; Terminal.app sets its own). terminal.rs sets TERM only, so zsh runs under LC_CTYPE=C: the typed line it echoes back holds U+FFFD and <0082>-style escapes, and `ls` prints a non-ASCII file name as '?????????'. The same commands under LANG=en_US.UTF-8 in a subshell are clean. Suggested fix: on macOS, set LANG (or LC_CTYPE) to a UTF-8 locale in the CommandBuilder when the environment has none.",
    "macOS code defect (typedQuotesReachShell): WKWebView applies the system text substitutions (smart quotes and dashes, on by default in macOS) to the terminal input, which has no spellcheck=\"false\". Typed one key at a time, `echo 'q1 q2' \"q3\" -- end` reaches zsh as `echo ‘q1 q2’ “q3” — end`. scripts/macos/m1-05-quote-probe.mjs shows the same field without substitution once spellcheck=\"false\" is set. Suggested fix: spellCheck={false} (and autoCorrect/autoCapitalize off) on the terminal input.",
  ],
  limits: [
    "Typing goes through Input.insertText (AppKit insertText:, the path typed characters take) and AppKit key events from the bridge; no physical keyboard. The checks other than typed-quotes insert a whole line at once, which WKWebView does not substitute.",
    "ZDOTDIR points at a proof folder: the user's own ~/.zshrc (prompt themes, plugins) is not exercised, and is not read or written.",
    "The app inherits the harness's environment (no LANG, as a Finder launch); a launch from a terminal that exports LANG would hide the locale defect.",
    "The panel is a log-style view, not a screen emulator: full-screen programs are out of reach (same limit as on Windows), and zsh's backspace after the first typed character shows as a control glyph (backspacesInDom).",
  ],
};
const check = (name, data) => {
  record.checks[name] = data;
  console.error(`- ${name}: ${JSON.stringify(data).slice(0, 300)}`);
};

writeFixtures();
const projectReal = realpathSync(PROJECT);
const redact = redactPaths([[PROJECT, "<project>"], [ZDOT, "<zdotdir>"], [BASE, "<proof>"]]);
const inst = await launch({ exe: EXE, port: PORT, data: join(BASE, "data"), env: { ZDOTDIR: ZDOT } });
record.engine = inst.engineVersion;
record.isolation = inst.isolation;
const { app } = inst;
const t = terminalDriver(app);
const watched = []; // every process that must be gone at the end
try {
  // ---- conversation, no turn ------------------------------------------------
  const ready = await newProjectConversation(app, PROJECT);
  if (ready !== "ready") throw new Error(`welcome flow: ${ready}`);
  await app.ev("(window.__baselineIpc.block = ['send_input'], true)");
  const sid = await sendFirstMessage(app, "M1-05 macOS terminal proof. The harness refuses this message: it is never sent.");
  if (!sid) throw new Error("start_session failed");
  await waitFor(() => app.ev("document.querySelectorAll('.pending-send').length > 0"), 20_000, 300);
  const sends = await app.ev("window.__baselineIpc.calls.filter((c) => c.cmd === 'send_input')");
  for (let i = 0; i < 4; i++) {
    const discarded = await app.ev("(() => { const b = [...document.querySelectorAll('.pending-send button')].find((n) => n.innerText.trim() === 'Discard'); if (b) b.click(); return !!b; })()");
    if (!discarded) break;
    await sleep(800);
  }
  await app.ev("(window.__baselineIpc.block = [], true)");
  check("conversation", { sessionCreated: true, sends: sends.length, everySendRefusedByHarness: sends.length > 0 && sends.every((c) => c.blockedByHarness === true) });
  await t.install();

  // ---- 1. shell bound to the project's cwd -----------------------------------
  const opened = await t.openPanel();
  if (!opened || opened.error) throw new Error(`terminal_open: ${JSON.stringify(opened)}`);
  const firstPrompt = await t.until(0, (a) => a.includes(PROMPT_MARK), 15_000);
  const shellProc = shellsOf(inst.pid).at(-1) ?? null;
  watched.push(shellProc);
  const pwd = await t.run("pwd; pwd -P", (a) => (a.match(/\[m1p /g) || []).length >= 1 && a.includes(projectReal), 8_000);
  check("shell-in-cwd", {
    terminalOpen: { shell: opened.shell, cwd: opened.cwd, cols: opened.cols, rows: opened.rows, ms: opened.ms },
    promptShown: firstPrompt.ok,
    shellProcess: shellProc?.command ?? null,
    shellIsChildOfApp: shellProc?.ppid === inst.pid,
    pwdOutput: pwd.added.split("\n").filter((l) => l.startsWith("/")),
  });
  record.verdicts.shellInProjectCwd = Boolean(
    opened.shell && /zsh$/.test(opened.shell) && realpathSync(opened.cwd) === projectReal && firstPrompt.ok && pwd.ok
      && pwd.added.split("\n").some((l) => l.trim() === projectReal) && shellProc?.ppid === inst.pid,
  );

  // ---- 2. ANSI -----------------------------------------------------------------
  const ansi = await t.run("sh ansi.sh", (a) => a.includes("ANSI-BOLD") && /ANSI-BOLD[^\n]*\n[\s\S]*\[m1p /.test(a), 8_000);
  const colours = await app.ev(`(() => {
    const out = {};
    for (const span of document.querySelectorAll('pre.terminal-output span')) {
      for (const word of ['ANSI-RED', 'ANSI-GREEN', 'ANSI-C256', 'ANSI-RGB', 'ANSI-BOLD']) {
        if (span.textContent === word) { const s = getComputedStyle(span); out[word] = { color: s.color, weight: s.fontWeight }; }
      }
    }
    out.plainColor = getComputedStyle(document.querySelector('pre.terminal-output')).color;
    return out;
  })()`);
  check("ansi", { ran: ansi.ok, rawHasSgr: /\x1b\[31m/.test(ansi.raw), colours });
  const distinct = new Set(["ANSI-RED", "ANSI-GREEN", "ANSI-C256", "ANSI-RGB"].map((w) => colours[w]?.color));
  record.verdicts.ansiRendered = Boolean(
    ansi.ok && distinct.size === 4 && !distinct.has(colours.plainColor) && !distinct.has(undefined)
      && colours["ANSI-RGB"]?.color === "rgb(10, 120, 250)" && Number(colours["ANSI-BOLD"]?.weight) >= 600,
  );

  // ---- 3. Unicode out and in --------------------------------------------------
  const echo = await t.run(`echo ${UNICODE}`, (a) => /\n[^\n]*\u{1F600}[^\n]*\n[\s\S]*\[m1p /u.test(a), 8_000);
  const echoLines = echo.added.split("\n").filter((l) => l.includes("\u{1F600}") || l.includes("�") || /<[0-9a-f]{2}>|\\M-|\$'\\/i.test(l));
  const domTail = (await t.dom()).slice(-600);
  check("unicode-echo", { ok: echo.ok, lines: echoLines, outputLineExact: echo.added.split("\n").some((l) => l.trim() === UNICODE), replacementChars: replacements(echo.added), domShowsIt: domTail.includes(UNICODE) });
  // The shell's locale as the app hands it over, then the same echo and an ls
  // of a non-ASCII file name under that locale and under LANG=en_US.UTF-8.
  const loc = await t.run("locale | grep -E '^(LANG|LC_CTYPE)='; ls name-*.txt", (a) => /LC_CTYPE=[^\n]*\n[\s\S]*name-[^\n]*\n[\s\S]*\[m1p /.test(a), 6_000);
  const utf = await t.run("LANG=en_US.UTF-8 zsh -i", (a) => a.includes(PROMPT_MARK), 8_000);
  const echoUtf = await t.run(`echo ${UNICODE}; ls name-*.txt`, (a) => /name-[^\n]*\n[\s\S]*\[m1p /.test(a), 8_000);
  await t.run("exit", (a) => a.includes(PROMPT_MARK), 6_000);
  const lsLine = (text) => text.split("\n").find((l) => /^name-.*\.txt\s*$/.test(l.trim()))?.trim() ?? null;
  const echoedLine = echo.added.split("\n").find((l) => l.includes("echo ")) ?? "";
  const echoedUtf = echoUtf.added.split("\n").find((l) => l.includes("echo ")) ?? "";
  check("unicode-locale", {
    shellLocale: loc.added.split("\n").filter((l) => /^(LANG|LC_CTYPE)=/.test(l)),
    echoedCommandAsHandedOver: echoedLine,
    lsAsHandedOver: lsLine(loc.added),
    utf8SubshellStarted: utf.ok,
    echoedCommandUnderUtf8: echoedUtf,
    lsUnderUtf8: lsLine(echoUtf.added),
  });
  record.checks["unicode-echo"].backspacesInDom = ((await t.dom()).match(/\x08/g) || []).length;
  const cpReady = await t.run("python3 cp.py", (a) => a.includes("CP-READY"), 15_000);
  const cp = cpReady.ok ? await t.run(UNICODE, (a) => /CP:[0-9a-f,]*/.test(a) && /CP:[^\n]*\n/.test(a), 8_000) : { ok: false, added: "" };
  const expectedCp = [...UNICODE].map((c) => c.codePointAt(0).toString(16)).join(",");
  const readCp = cp.added.match(/CP:([0-9a-f,]*)/)?.[1] ?? null;
  check("unicode-input", { ok: cp.ok, read: readCp, expected: expectedCp });
  await t.until(await t.rawLength(), (a) => a.includes(PROMPT_MARK), 3_000);
  const longFrom = await t.rawLength();
  const long = await t.run("python3 long.py 1500", (a) => a.includes("LONG-DONE 1500"), 30_000);
  const wide = await t.run("python3 long.py 4000 wide", (a) => a.includes("LONG-DONE 4000"), 60_000);
  await sleep(800);
  const longRaw = await t.rawSince(longFrom);
  const uLines = (plain(longRaw).match(/U\d{4} \u00e9\u20ac\u{1F600} \u4e2d\u6587 \u2713 \u00e9\u20ac\u{1F600}\n/gu) || []).length;
  const wLines = (plain(longRaw).match(/W\d{4} 中文字符測試漢字中文字符測試漢字😀\n/gu) || []).length;
  const dom = await t.dom();
  check("unicode-long", {
    shortRun: long.ok, wideRun: wide.ok,
    rawChars: longRaw.length, rawBytesApprox: Buffer.byteLength(longRaw),
    exactUnicodeLines: uLines, exactWideLines: wLines,
    rawReplacementChars: replacements(longRaw), rawLoneSurrogates: loneSurrogates(longRaw),
    domChars: dom.length, domReplacementChars: replacements(dom), domHasLastLine: dom.includes("W4000 ") && dom.includes("LONG-DONE 4000"),
    brokenRawLines: plain(longRaw).split("\n").filter((l) => l.includes("�")).slice(0, 4).map((l) => l.slice(0, 80)),
  });
  if (replacements(longRaw) > 0) {
    record.findings.push(`Shared code defect (unicode-long, intermittent): ${replacements(longRaw)} U+FFFD in the raw terminal_read stream of a long multibyte output (python3 writes valid UTF-8). src-tauri/src/terminal.rs read_output decodes each 8192-byte PTY read on its own with String::from_utf8_lossy, so a 3- or 4-byte character split across two reads becomes replacement characters. Whether it happens depends on where the reads fall (0 in the 08b291d run, ${replacements(longRaw)} here). Fix direction: keep the incomplete UTF-8 tail of a read and prepend it to the next one. Not part of the 3196ce2 fixes.`);
  }
  // Program output and program input (the plan's Unicode criterion).
  record.verdicts.unicodeProgramOutputAndInput = Boolean(
    echo.ok && echo.added.split("\n").some((l) => l.trim() === UNICODE)
      && readCp === expectedCp && uLines === 1500 && wLines === 4000 && replacements(longRaw) === 0 && loneSurrogates(longRaw) === 0
      && replacements(dom) === replacements(echoedLine),
  );
  // What the shell itself shows: the typed line echoed back and a file name.
  record.verdicts.unicodeShellEcho = replacements(echoedLine) === 0 && lsLine(loc.added) === `name-${UNICODE}.txt`;

  // ---- 4. interactive input: a python3 REPL, Ctrl+D back to the shell ----------
  const replFrom = await t.rawLength();
  const repl = await t.run("python3 -q", (a) => a.includes(">>> "), 15_000);
  const replProc = descendants(inst.pid).find((p) => /Python|python3/.test(p.command)) ?? null;
  const sum = await t.run("6*7", (a) => /\n42\n/.test(a), 5_000);
  // No quote in the line: typed quotes are checked on their own (6b).
  const asked = await t.run("name = input(chr(78) + chr(63) + chr(32))", (a) => a.includes("N? "), 5_000);
  const answered = asked.ok ? await t.run("interactive-ok", (a) => a.includes(">>> "), 5_000) : { ok: false };
  const upper = await t.run("print(name.upper())", (a) => a.includes("INTERACTIVE-OK"), 5_000);
  const eofFrom = await t.rawLength();
  await t.ctrl("d");
  const back = await t.until(eofFrom, (a) => a.includes(PROMPT_MARK), 8_000);
  await sleep(500);
  check("python-repl", {
    started: repl.ok, process: replProc?.command?.slice(0, 120) ?? null, underShell: replProc ? replProc.ppid === shellProc?.pid : null,
    typed: [repl, sum, asked, answered, upper].map((r) => r.typed ?? null),
    sixTimesSeven: sum.ok, inputPrompt: asked.ok, inputDelivered: answered.ok, readBack: upper.ok,
    ctrlDBackToShell: back.ok, replGoneAfterCtrlD: replProc ? !sameAlive(replProc) : null,
    transcript: plain(await t.rawSince(replFrom)).split("\n").slice(-12),
  });
  record.verdicts.interactiveRepl = Boolean(repl.ok && sum.ok && asked.ok && answered.ok && upper.ok && back.ok && replProc && !sameAlive(replProc));

  // ---- 5. Ctrl+C on a running ping --------------------------------------------
  const ping = await t.run("ping 127.0.0.1", (a) => (a.match(/bytes from 127\.0\.0\.1/g) || []).length >= 3, 10_000);
  const pingProc = descendants(inst.pid).find((p) => /^ping /.test(p.command)) ?? null;
  watched.push(pingProc);
  const intFrom = await t.rawLength();
  await t.ctrl("c");
  const interrupted = await t.until(intFrom, (a) => /ping statistics/.test(a) && a.includes(PROMPT_MARK), 6_000);
  await sleep(300);
  check("ctrl-c", {
    pingReplies: ping.ok, pingProcessSeen: Boolean(pingProc), statisticsPrinted: interrupted.ok,
    caretShown: /\^C/.test(interrupted.added), pingGone: pingProc ? !sameAlive(pingProc) : null,
    tail: interrupted.added.split("\n").filter(Boolean).slice(-5),
  });
  record.verdicts.ctrlCInterrupts = Boolean(ping.ok && pingProc && interrupted.ok && !sameAlive(pingProc));

  // ---- 6. resize: stty size follows the pane; the manual width sticks ----------
  const stty = async () => {
    const r = await t.run("stty size", (a) => /\n(\d+) (\d+)\n/.test(a), 6_000);
    const m = [...r.added.matchAll(/(?:^|\n)(\d+) (\d+)\n/g)].at(-1);
    return { rows: m ? Number(m[1]) : null, cols: m ? Number(m[2]) : null, label: await t.sizeLabel() };
  };
  const labelMatches = (s) => s.label === `${s.cols}×${s.rows}`;
  const win = await app.send("Browser.getWindowForTarget", {});
  const base = await stty();
  await app.send("Browser.setWindowBounds", { windowId: 1, bounds: { width: win.bounds.width + 320, height: win.bounds.height + 160 } });
  await sleep(1_500);
  const bigger = await stty();
  await app.ev("(document.querySelector('button[aria-label=\"Increase terminal width\"]').click(), true)");
  await sleep(600);
  const manual = await stty();
  await sleep(2_500);
  const manualLater = await stty();
  await app.send("Browser.setWindowBounds", { windowId: 1, bounds: { width: win.bounds.width, height: win.bounds.height } });
  await sleep(1_500);
  const restored = await stty();
  check("resize", { window: win.bounds, base, bigger, manual, manualLater, restored });
  record.verdicts.resizeFollowsPane = Boolean(
    base.cols && bigger.cols > base.cols && bigger.rows > base.rows && labelMatches(base) && labelMatches(bigger)
      && manual.cols === bigger.cols + 10 && labelMatches(manual) && manualLater.cols === manual.cols
      && restored.cols === base.cols && restored.rows === base.rows && labelMatches(restored),
  );

  // ---- 6b. quotes and dashes typed one key at a time reach the shell as typed
  const typedLine = `echo 'q1 q2' "q3" -- end`;
  await t.focusInput();
  for (const ch of typedLine) await app.send("Input.insertText", { text: ch });
  await sleep(300);
  const fieldValue = await t.inputValue();
  const qFrom = await t.rawLength();
  await app.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", text: "\r" });
  await app.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter" });
  const qOut = await t.until(qFrom, (a) => /\n[^\n]*end[^\n]*\n[\s\S]*\[m1p /.test(a) || /quote>/.test(a), 6_000);
  if (/quote>/.test(qOut.added)) { const f = await t.rawLength(); await t.ctrl("c"); await t.until(f, (a) => a.includes(PROMPT_MARK), 4_000); }
  check("typed-quotes", {
    typed: typedLine,
    fieldValue,
    shellOutput: qOut.added.split("\n").filter((l) => l.includes("end") && !l.includes("echo ")),
    inputAttributes: await app.ev("(() => { const i = document.querySelector('form.terminal-input input'); return { spellcheck: i.getAttribute('spellcheck'), autocorrect: i.getAttribute('autocorrect'), autocomplete: i.getAttribute('autocomplete') }; })()"),
  });
  record.verdicts.typedQuotesReachShell = fieldValue === typedLine && qOut.added.split("\n").some((l) => l.trim() === "q1 q2 q3 -- end");

  // ---- 7. other shortcuts, informational (not in the plan's acceptance) -------
  await t.focusInput();
  await app.send("Input.insertText", { text: "abcXYZ-should-vanish" });
  await sleep(150);
  await t.key("Escape", "Escape");
  const afterEscape = await t.inputValue();
  // Escape also wrote ESC to zsh; Ctrl+C gives it a clean line again.
  let from = await t.rawLength();
  await t.ctrl("c");
  await t.until(from, (a) => a.includes(PROMPT_MARK), 4_000);
  await t.focusInput();
  await app.send("Input.insertText", { text: "cat serv" });
  await sleep(150);
  from = await t.rawLength();
  await t.key("Tab", "Tab");
  await sleep(1_000);
  const afterTab = { raw: JSON.stringify((await t.rawSince(from)).slice(0, 200)), inputValue: await t.inputValue() };
  await t.focusInput();
  await app.ev("(() => { const i = document.querySelector('form.terminal-input input'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, ''); i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()");
  from = await t.rawLength();
  await t.ctrl("c");
  await t.until(from, (a) => a.includes(PROMPT_MARK), 4_000);
  from = await t.rawLength();
  await t.ctrl("l");
  await sleep(800);
  const afterCtrlL = await t.rawSince(from);
  check("shortcuts-informational", {
    escapeClearsInput: afterEscape === "",
    tab: afterTab,
    ctrlLClearSequence: /\x1b\[H\x1b\[2J|\x1b\[2J/.test(afterCtrlL) || /\x1b\[H/.test(afterCtrlL),
    ctrlLRaw: JSON.stringify(afterCtrlL.slice(0, 120)),
  });

  // ---- 8. a long-running server across a work-tab change and a page change ----
  const srv = await t.run("python3 server.py", (a) => /listening \d+ pid \d+/.test(a), 15_000);
  const m = srv.added.match(/listening (\d+) pid (\d+)/);
  const srvPort = m ? Number(m[1]) : null;
  const srvProc = m ? proc(Number(m[2])) : null;
  watched.push(srvProc);
  const termIdAtStart = t.current;
  const hits = [];
  hits.push(await request(srvPort, "/visible-1"));
  await t.workTab("Changes");
  await sleep(2_500);
  hits.push(await request(srvPort, "/hidden-tab-1"));
  await sleep(1_000);
  await app.ev("(document.querySelector('button[aria-label=\"Settings\"]')?.click(), true)");
  const settingsShown = await waitFor(() => app.ev("Boolean(document.querySelector('.settings-panel'))"), 5_000, 200);
  await sleep(2_500);
  hits.push(await request(srvPort, "/hidden-page-1"));
  await sleep(1_000);
  await app.ev(`(document.querySelector('li.session-item[data-session-id="${sid}"] button.session-select')?.click(), true)`);
  await waitFor(() => app.ev("!document.querySelector('.settings-panel') && Boolean(document.querySelector('button[aria-label=\"Show work panel\"], nav.work-tabs'))"), 8_000, 200);
  // The panel remounts on a live terminal: no new terminal_open is expected,
  // and any that happens must answer the same id.
  const opensBeforeReturn = (await t.taps()).opens.length;
  await t.workTab("Terminal");
  await waitFor(() => app.ev("Boolean(document.querySelector('pre.terminal-output'))"), 8_000, 200);
  await sleep(1_500);
  const opensOnReturn = (await t.taps()).opens.slice(opensBeforeReturn);
  hits.push(await request(srvPort, "/visible-2"));
  await sleep(1_500);
  const domAfter = plain(await t.dom());
  const ticks = [...domAfter.matchAll(/tick (\d+)/g)].map((x) => Number(x[1]));
  const maxTick = Math.max(0, ...ticks);
  const missingTicks = [];
  for (let i = 1; i <= maxTick; i++) if (!ticks.includes(i)) missingTicks.push(i);
  const shownHits = [...domAfter.matchAll(/hit (\d+) (\/[a-z-]+-\d)/g)].map((x) => `${x[1]} ${x[2]}`);
  check("server-across-views", {
    listening: Boolean(srvPort), serverUnderShell: srvProc ? srvProc.ppid === shellProc?.pid : null,
    requests: hits.map((h) => ({ path: h.path, status: h.status ?? null, error: h.error ?? null })),
    settingsPageShown: Boolean(settingsShown),
    sameTerminalAfterReturn: opensOnReturn.every((o) => o.terminalId === termIdAtStart),
    terminalOpensOnReturn: opensOnReturn.map((o) => (o.terminalId === termIdAtStart ? "same id" : "new id")),
    readsOfThatTerminal: (await t.taps()).reads[termIdAtStart] ?? 0,
    serverStillSameProcess: sameAlive(srvProc),
    ticksShown: ticks.length, maxTick, missingTicks,
    hitsShown: shownHits,
  });
  record.verdicts.serverAcrossViews = Boolean(
    srvPort && hits.every((h) => h.status === 200) && settingsShown && opensOnReturn.every((o) => o.terminalId === termIdAtStart)
      && sameAlive(srvProc) && maxTick >= 8 && missingTicks.length === 0
      && ["1 /visible-1", "2 /hidden-tab-1", "3 /hidden-page-1", "4 /visible-2"].every((h) => shownHits.includes(h)),
  );

  // ---- 9. Close with the server running: no orphan; then restart; then exit ----
  const beforeClose = { shell: shellProc, server: srvProc, tree: descendants(inst.pid).map((p) => p.command.slice(0, 80)) };
  const closesBefore = (await t.taps()).closes.length;
  await app.ev("(document.querySelector('button.terminal-close').click(), true)");
  await waitFor(async () => (await t.taps()).closes.length > closesBefore, 5_000, 100);
  const gone = await waitFor(() => !sameAlive(shellProc) && !sameAlive(srvProc), 10_000, 250);
  const portAfterClose = await request(srvPort, "/after-close");
  const emptyState = await app.ev("(() => { const p = document.querySelector('.terminal-empty'); return p ? p.innerText.replace(/\\s+/g, ' ').trim() : null; })()");
  await sleep(2_000);
  const noAutoReopen = (await t.taps()).opens.length;
  check("close-no-orphan", {
    closeOk: (await t.taps()).closes.at(-1)?.ok ?? null,
    treeBeforeClose: beforeClose.tree,
    shellGone: !sameAlive(shellProc), serverGone: !sameAlive(srvProc), within10s: Boolean(gone),
    serverPortAfterClose: portAfterClose.error ?? portAfterClose.status,
    panelAfterClose: emptyState,
    treeAfterClose: descendants(inst.pid).map((p) => p.command.slice(0, 80)),
  });
  record.verdicts.closeLeavesNoOrphan = Boolean(gone && portAfterClose.error && /No terminal running/.test(emptyState ?? ""));

  const opensBefore = noAutoReopen;
  await app.ev("(() => { const b = [...document.querySelectorAll('.terminal-empty button')].find((n) => n.innerText.trim() === 'Open terminal'); if (b) b.click(); return !!b; })()");
  const restart = await waitFor(async () => { const l = (await t.taps()).opens; return l.length > opensBefore ? l.at(-1) : null; }, 15_000, 200);
  if (restart && !restart.error) t.current = restart.terminalId;
  const restartPrompt = await t.until(0, (a) => a.includes(PROMPT_MARK), 15_000);
  const shell2 = shellsOf(inst.pid).at(-1) ?? null;
  watched.push(shell2);
  const exitFrom = await t.rawLength();
  await t.typeLine("exit");
  const exited = await waitFor(async () => (await t.dom()).includes("[process exited]"), 10_000, 250);
  check("restart-and-exit", {
    newTerminal: Boolean(restart && !restart.error && restart.terminalId !== termIdAtStart),
    sameCwd: restart?.cwd ? realpathSync(restart.cwd) === projectReal : false,
    promptShown: restartPrompt.ok,
    newShellProcess: Boolean(shell2 && shell2.pid !== shellProc?.pid),
    exitTyped: plain(await t.rawSince(exitFrom)).slice(0, 80),
    processExitedShown: Boolean(exited),
    shellGoneAfterExit: shell2 ? !sameAlive(shell2) : null,
  });
  record.verdicts.closeRestart = Boolean(restart && !restart.error && restart.terminalId !== termIdAtStart && restartPrompt.ok && shell2 && exited && !sameAlive(shell2));

  // ---- 10. a server left running while the app quits --------------------------
  const closes2 = (await t.taps()).closes.length;
  await app.ev("(document.querySelector('button.terminal-close')?.click(), true)");
  await waitFor(async () => (await t.taps()).closes.length > closes2, 5_000, 100);
  await sleep(500);
  const opens3 = (await t.taps()).opens.length;
  await app.ev("(() => { const b = [...document.querySelectorAll('.terminal-empty button')].find((n) => n.innerText.trim() === 'Open terminal'); if (b) b.click(); return !!b; })()");
  const third = await waitFor(async () => { const l = (await t.taps()).opens; return l.length > opens3 ? l.at(-1) : null; }, 15_000, 200);
  if (third && !third.error) t.current = third.terminalId;
  await t.until(0, (a) => a.includes(PROMPT_MARK), 15_000);
  const shell3 = shellsOf(inst.pid).at(-1) ?? null;
  const srv3 = await t.run("python3 server.py", (a) => /listening \d+ pid \d+/.test(a), 15_000);
  const m3 = srv3.added.match(/listening (\d+) pid (\d+)/);
  record.atQuit = { shell: shell3, server: m3 ? proc(Number(m3[2])) : null, port: m3 ? Number(m3[1]) : null };
  watched.push(shell3, record.atQuit.server);
} catch (error) {
  record.failure = String(error?.stack ?? error).slice(0, 800);
} finally {
  record.consoleErrors = app.errors.slice(0, 20);
  record.stop = await inst.stop();
}

// After the quit: the shell and server started last, and every process seen, gone.
await sleep(1_500);
if (record.atQuit) {
  const port = record.atQuit.port ? await request(record.atQuit.port, "/after-quit") : null;
  record.checks["quit-no-orphan"] = {
    quitBy: record.stop.quitBy,
    shellGone: !sameAlive(record.atQuit.shell),
    serverGone: !sameAlive(record.atQuit.server),
    serverPortAfterQuit: port ? port.error ?? port.status : null,
    leftAfterQuit: record.stop.leftAfterQuit,
    groupLeftAfterQuit: record.stop.groupLeftAfterQuit,
  };
  record.verdicts.quitLeavesNoOrphan = Boolean(record.atQuit.shell && record.atQuit.server && !sameAlive(record.atQuit.shell) && !sameAlive(record.atQuit.server) && port?.error);
  delete record.atQuit;
}
const survivors = watched.filter(Boolean).filter(sameAlive);
record.checks.everyWatchedProcessGone = { watched: watched.filter(Boolean).length, survivors: survivors.map((p) => p.command.slice(0, 80)) };
for (const p of survivors) { try { process.kill(p.pid, "SIGKILL"); } catch { /* gone */ } }
record.verdicts.noOrphanAtEnd = survivors.length === 0 && record.stop.leftAfterQuit.length === 0;
record.verdicts.isolationKept = record.stop.defaultStoresUnchangedAtEnd === true && record.stop.testStoreDeleted === true;
const keys = ["shellInProjectCwd", "ansiRendered", "unicodeProgramOutputAndInput", "unicodeShellEcho", "interactiveRepl", "typedQuotesReachShell", "ctrlCInterrupts", "resizeFollowsPane", "serverAcrossViews", "closeLeavesNoOrphan", "closeRestart", "quitLeavesNoOrphan", "noOrphanAtEnd", "isolationKept"];
record.verdicts.all = !record.failure && keys.every((k) => record.verdicts[k] === true);
const out = redact(record);
if (OUT) {
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, `${JSON.stringify(out, null, 2)}\n`);
}
console.log(JSON.stringify(out.verdicts, null, 2));
process.exit(record.verdicts.all ? 0 : 1);
