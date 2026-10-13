#!/usr/bin/env node
/**
 * M4-03 on macOS: have Muse drive the browser. The macOS replay of
 * scripts/cdp-m4-03-acceptance.mjs (the plan's acceptance set: a complete web
 * workflow, an unexpected navigation, a stop without acting on another tab),
 * in a live turn, with the "Attach the user's browser" consent on.
 *
 * Never the user's browser: the browser is a Google Chrome started here on a
 * temporary --user-data-dir (mock keychain, its own DevTools port in the proof
 * range), on two local pages served on 127.0.0.1. The harness refuses to run
 * when another Chrome is open, so the driver can only see this one.
 *
 *   1. Settings > Computer use: "Observe and act" then "Attach the user's
 *      browser", clicked; the service the app starts is CuaDriver.app (open -n
 *      -g -a, the TCC identity the user granted) with --grant existing-profile
 *      on the instance's own socket.
 *   2. A new conversation (the MCP entry is fixed at session start): the model
 *      lists the windows, prepares the Chrome window (existing_profile), reads
 *      the tabs, clicks the target tab's viewport with the exact ids, reads
 *      again and reports.
 *   3. Verified outside the driver and the model: Chrome's own DevTools list
 *      (target tab on /unexpected.html, decoy untouched) and the test server's
 *      request log (the decoy's button never fired).
 *   4. Turn off and revoke: the service stops.
 * Approval cards, if any, get "Allow once" and are recorded.
 *
 *   node scripts/macos/m4-03-browser-drive.mjs --exe ~/muse-proofs/app/08b291d/muse-desktop [--port 9470] [--web 9472] [--devtools 9479]
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { argValue, redactor, sleep, waitFor } from "../cdp-harness.mjs";
import { newProjectConversation, transcript } from "./smoke-real-turn.mjs";
import { launch } from "./test-instance.mjs";

const BUILD = argValue("--build-commit", "08b291d");
const EXE = resolve(argValue("--exe", "src-tauri/target/debug/muse-desktop"));
const PORT = Number(argValue("--port", "9470"));
const WEB = Number(argValue("--web", "9472"));
const DEVTOOLS = Number(argValue("--devtools", "9479"));
const BASE = resolve(argValue("--base", join(tmpdir(), "muse-proofs-g7", "m4-03")));
const OUT = argValue("--out", "docs/evidence/2026-10-13-macos-closure/m4-03-browser-drive-macos.json");
const ID = Date.now().toString(36);
const RUN = ID.toUpperCase();
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const DRIVER = "/Applications/CuaDriver.app/Contents/MacOS/cua-driver";
const PROFILE = join(BASE, `chrome-profile-${ID}`);
const ORIGIN = `http://127.0.0.1:${WEB}`;
const TARGET_TITLE = `M4-03 Drive Target ${RUN}`;
const DECOY_TITLE = `M4-03 Decoy ${RUN}`;

// ---- the local pages ---------------------------------------------------------------
const hits = [];
const pages = {
  "/target.html": `<!doctype html><title>${TARGET_TITLE}</title><body style="margin:0"><button id="go" style="width:100vw;height:100vh;font-size:48px;display:block" onclick="location.href='/unexpected.html'">Go</button>`,
  "/decoy.html": `<!doctype html><title>${DECOY_TITLE}</title><body style="margin:0"><button style="width:100vw;height:100vh;font-size:48px;display:block" onclick="fetch('/decoy-clicked')">Never click</button>`,
  "/unexpected.html": `<!doctype html><title>Unexpected Landing ${RUN}</title><h1>UNEXPECTED NAVIGATION LANDING</h1>`,
};
const server = createServer((req, res) => {
  hits.push({ at: Date.now(), path: req.url });
  const body = pages[req.url];
  res.writeHead(body ? 200 : 404, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(body ?? "not found");
});

// ---- processes ---------------------------------------------------------------------
const ps = () => execFileSync("ps", ["-axww", "-o", "pid=,ppid=,command="], { encoding: "utf8", maxBuffer: 32 << 20 }).split("\n")
  .map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)).filter(Boolean).map(([, pid, ppid, command]) => ({ pid: Number(pid), ppid: Number(ppid), command }));
const chromes = () => ps().filter((p) => p.command.startsWith(CHROME));
const drivers = () => ps().filter((p) => p.command.startsWith(DRIVER) && / serve /.test(p.command));
/** The user's own computer-use socket (computer.rs endpoint() outside test mode). */
const DEFAULT_SOCKET = join(tmpdir(), "muse-desktop-computer.sock").replace(/^\/var\//, "/private/var/");
const onDefaultSocket = (p) => p.command.replace(/\/\/+/g, "/").replace(" /var/", " /private/var/").includes(`--socket ${DEFAULT_SOCKET}`);
const testServices = () => drivers().filter((p) => p.command.includes("muse-desktop-computer-test-"));
/** The relay the engine started (muse-desktop --computer-use-mcp): its environment and the socket its driver proxy uses. */
function relays() {
  const all = ps();
  return all.filter((p) => / --computer-use-mcp( |$)/.test(p.command)).map((p) => {
    let env = "";
    try { env = execFileSync("ps", ["-wwE", "-o", "command=", "-p", String(p.pid)], { encoding: "utf8" }); } catch { /* gone */ }
    const proxies = all.filter((c) => c.ppid === p.pid).map((c) => c.command);
    return {
      pid: p.pid,
      parent: all.find((x) => x.pid === p.ppid)?.command.split(" ").slice(0, 2).join(" ").replace(/^.*\//, "") ?? null,
      // In its environment, or named in its argv (test_mode::relay_args, since 4fecdc8's successor).
      seesTestDataDir: /\bMUSE_DESKTOP_TEST_DATA_DIR=/.test(env) || / --test-data-dir \S/.test(p.command),
      seesTestSidecar: /\bMUSE_DESKTOP_TEST_SIDECAR=/.test(env),
      driverProxies: proxies,
      proxyOnDefaultSocket: proxies.some((c) => c.replace(/\/\/+/g, "/").replace(" /var/", " /private/var/").includes(`--socket ${DEFAULT_SOCKET}`)),
    };
  });
}
const devtools = async () => (await (await fetch(`http://127.0.0.1:${DEVTOOLS}/json/list`)).json()).filter((t) => t.type === "page").map((t) => ({ title: t.title, url: t.url }));

// ---- page helpers --------------------------------------------------------------------
async function click(app, expr) {
  const at = await app.ev(`(() => { const el = ${expr}; if (!el) return null; el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  if (!at) throw new Error(`nothing to click: ${expr}`);
  await app.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: at.x, y: at.y });
  await app.send("Input.dispatchMouseEvent", { type: "mousePressed", x: at.x, y: at.y, button: "left", buttons: 1, clickCount: 1 });
  await app.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: at.x, y: at.y, button: "left", buttons: 0, clickCount: 1 });
  await sleep(300);
}
const panel = (app) => app.ev(`(() => {
  const s = document.querySelector('section.computer-use');
  if (!s) return null;
  return {
    state: s.querySelector('.computer-use-state')?.textContent ?? null,
    summary: s.querySelector('.computer-use-summary')?.textContent ?? null,
    level: s.querySelector('input[name="computer-use-level"]:checked')?.value ?? null,
    attach: s.querySelector('.computer-use-attach input')?.checked ?? null,
    busy: s.querySelector('fieldset.computer-use-levels')?.disabled ?? null,
    probes: [...s.querySelectorAll('.computer-use-probes li')].map((li) => li.textContent),
  };
})()`);

// ---- scenario --------------------------------------------------------------------
const platform = execFileSync("sw_vers", [], { encoding: "utf8" }).trim().split("\n").map((l) => l.split(":")[1].trim());
const report = {
  schema: "muse-desktop.m4-03-browser-drive-macos.v1",
  ticket: "M4-03",
  date: new Date().toISOString().slice(0, 10),
  commit: BUILD,
  platform: `${platform[0]} ${platform[1]} (${platform[2]}), arm64, Apple Silicon; debug build with embedded frontend, WKWebView through the test bridge`,
  harness: "scripts/macos/m4-03-browser-drive.mjs on scripts/macos/test-instance.mjs (macOS replay of scripts/cdp-m4-03-acceptance.mjs)",
  liveTurns: 0,
  method: "One isolated test instance (fresh data folder and WKWebView store, pinned engine, its own computer-use socket named after the data folder). Settings > Computer use is driven with the bridge's trusted mouse: \"Observe and act\", then \"Attach the user's browser\". The service command line is read from ps. A Google Chrome is started by the harness on a temporary --user-data-dir (--use-mock-keychain, --password-store=basic, --remote-debugging-port in the proof range) with a decoy tab and a target tab served on 127.0.0.1; the harness refuses to start when any other Chrome runs, so the driver cannot bind the user's. A new conversation is started from the welcome screen with the instruction typed and sent with Enter; the model drives the browser through the app's computer-use relay. The outcome is read from Chrome's own DevTools list and from the test server's request log, neither of which goes through the driver or the model. Turn off and revoke ends it.",
  limits: [
    "The browser is a Chrome started by the harness on a temporary profile, not the user's own signed-in browser: the attach consent and the binding are proved, the user's real profile (and Chrome's per-profile remote-debugging consent page, which a profile started without --remote-debugging-port would need) is Étienne's to try.",
    "Defect found (test mode, macOS, engine 1.4.2): the computer-use relay the engine starts (muse-desktop --computer-use-mcp, a child of muse-bin serve) does not receive MUSE_DESKTOP_TEST_DATA_DIR (nor MUSE_DESKTOP_TEST_SIDECAR): the engine starts MCP stdio servers with a filtered environment. The relay then takes the user's default endpoint ($TMPDIR/muse-desktop-computer.sock) and the user's level record (~/Library/Application Support/com.muse.desktop/computer-use), and `cua-driver mcp` starts a service of its own on that socket, without the attach grant. The model's calls never reach the instance's service: browser_prepare and get_browser_state answer browser_consent_required. Had the user's own service been running with a grant, a test turn would have acted through it. The run stops the service it caused on the default socket (none ran before). The model-driven workflow therefore stays unproved on macOS; the driver half is shown harness-driven through the instance's own service (check 3b).",
    "Driver 0.28.2 on macOS refuses browser_click on the trusted route (Input.dispatchMouseEvent), by coordinates or by ref, even with the window brought to front: {effect: refused, escalation: route_unavailable}. The DOM route (input_route dom_event, a ref from get_browser_state mode snapshot) clicks and the page navigates; the driver reports that effect as unverifiable, so the outcome is read from Chrome. browser_navigate also works. Unlike the Windows note, snapshot refs do materialize here. A newer driver (0.34.1) is announced; not installed (nothing downloaded).",
    "list_windows answers the model with a count only (\"Found N window(s)\"): the records are in structuredContent, which the host drops, and the relay surfaces snapshot and browser ids but not windows. get_accessibility_tree carries pid and window_id in its text, so the instruction names it (the first trial with list_windows ended with no window found).",
    "Accessibility and Screen Recording were already granted to CuaDriver (com.trycua.driver) on this Mac; the grant itself is not part of this proof.",
  ],
  checks: {},
};
let inst = null;
let chrome = null;
try {
  report.preflight = {
    chromeVersion: execFileSync(CHROME, ["--version"], { encoding: "utf8" }).trim(),
    driverVersion: execFileSync(DRIVER, ["--version"], { encoding: "utf8" }).trim(),
    otherChromesRunning: chromes().length,
    driverServicesBefore: drivers().length,
    serviceOnTheUsersDefaultSocketBefore: drivers().some(onDefaultSocket),
  };
  if (report.preflight.otherChromesRunning > 0) throw new Error("a Chrome is already running: refusing, the driver could bind the user's browser");
  await new Promise((ok, fail) => { server.once("error", fail); server.listen(WEB, "127.0.0.1", ok); });
  mkdirSync(PROFILE, { recursive: true });
  chrome = spawn(CHROME, [`--user-data-dir=${PROFILE}`, "--no-first-run", "--no-default-browser-check", "--use-mock-keychain", "--password-store=basic",
    `--remote-debugging-port=${DEVTOOLS}`, "--new-window", `${ORIGIN}/decoy.html`], { stdio: "ignore", detached: true });
  chrome.unref();
  await waitFor(() => devtools().then((t) => t.some((x) => x.title === DECOY_TITLE)).catch(() => false), 30_000, 500);
  // The target tab, opened last, is the active one: its title is the window's.
  await fetch(`http://127.0.0.1:${DEVTOOLS}/json/new?${encodeURIComponent(`${ORIGIN}/target.html`)}`, { method: "PUT" });
  await waitFor(() => devtools().then((t) => t.some((x) => x.title === TARGET_TITLE)).catch(() => false), 15_000, 300);
  report.checks.chromeBefore = { tabs: await devtools(), processes: chromes().length };

  inst = await launch({ exe: EXE, port: PORT, data: join(BASE, `data-${ID}`) });
  report.engine = inst.engineVersion;
  report.isolation = inst.isolation;
  const app = inst.app;

  // 1. The consent, from Settings.
  await waitFor(() => app.ev(`Boolean(document.querySelector('button.account[aria-label="Settings"]'))`), 60_000, 250);
  await click(app, `document.querySelector('button.account[aria-label="Settings"]')`);
  await waitFor(() => panel(app).then((p) => p && p.busy === false && /available|tools|off/i.test(`${p.summary} ${p.state}`)), 30_000, 300);
  const initial = await panel(app);
  await click(app, `document.querySelector('input[name="computer-use-level"][value="act"]')`);
  const granted = await waitFor(() => panel(app).then((p) => (p && p.state === "Granted" && p.level === "act" && p.busy === false ? p : null)), 60_000, 500);
  await click(app, `document.querySelector('.computer-use-attach input')`);
  const attached = await waitFor(() => panel(app).then((p) => (p && p.attach === true && p.state === "Granted" && p.busy === false ? p : null)), 60_000, 500);
  const services = drivers().map((p) => ({ parent: p.ppid === 1 ? "launchd (open -n -g -a CuaDriver.app)" : String(p.ppid), argv: p.command }));
  report.checks.consent = { initial, granted, attached, services, recorded: (() => { try { return JSON.parse(readFileSync(join(inst.data, "computer-use", "computer-attach.json"), "utf8")); } catch { return undefined; } })() };

  // 2. A new conversation, the instruction typed and sent.
  await click(app, `document.querySelector('button.account[aria-label="Settings"]')`);
  await sleep(500);
  const project = join(BASE, `project-${ID}`);
  mkdirSync(project, { recursive: true });
  await newProjectConversation(app, project);
  const instruction = `On the Google Chrome window whose title is '${TARGET_TITLE}', drive the browser using ONLY the computer-use tools (get_accessibility_tree, browser_prepare, get_browser_state, browser_click), never a shell command. Steps: (1) get_accessibility_tree, whose text lists each window with its pid and window_id, and take that window's pid and window_id; (2) browser_prepare with that pid and window_id and strategy kind existing_profile; (3) get_browser_state on that window: it returns the target_id and the tabs with their tab_id; (4) get_browser_state again with that target_id, the tab_id of the tab titled '${TARGET_TITLE}' and mode snapshot: it returns element refs such as p1:0; (5) browser_click passing EXACTLY that target_id and tab_id, the ref of the button, and input_route dom_event (on this Mac the trusted route is refused for a background browser); those ids are valid, use them verbatim, never invent ids; (6) get_browser_state again and report exactly what happened to that tab. Then STOP: no other click, and never touch the other tab (the decoy tab titled '${DECOY_TITLE}' is open; leave it exactly as it is).`;
  await click(app, `document.querySelector('textarea[aria-label="Your first message"]')`);
  await app.send("Input.insertText", { text: instruction });
  await waitFor(() => app.ev(`(() => { const b = document.querySelector('button.welcome-send'); return document.activeElement?.value === ${JSON.stringify(instruction)} && b && !b.disabled; })()`), 10_000, 100);
  const sentAt = Date.now();
  await app.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", text: "\r" });
  await app.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter" });
  const sid = await waitFor(async () => {
    const call = (await app.ev("window.__baselineIpc.calls.filter((c) => c.cmd === 'start_session')")).at(-1);
    return call?.ok ? JSON.parse(call.result).session_id : null;
  }, 60_000);
  if (!sid) throw new Error("no session started");
  report.liveTurns = 1;
  const approvals = [];
  let relaySeen = null;
  const servicesDuringTurn = new Set();
  const done = await waitFor(async () => {
    if (!relaySeen) { const r = relays(); if (r.length > 0) relaySeen = r; }
    for (const d of drivers()) servicesDuringTurn.add(d.command);
    const cards = await app.ev(`[...document.querySelectorAll('.approvals .approval')].map((g) => ({ title: g.querySelector('.approval-title-row strong')?.innerText ?? null, detail: (g.querySelector('.approval-details pre')?.innerText || '').slice(0, 200) }))`);
    if (cards.length > 0) {
      approvals.push(cards[0]);
      await click(app, `[...document.querySelectorAll('.approvals .approval-actions button')].find((b) => b.innerText.trim() === 'Allow once')`).catch(() => null);
      return null;
    }
    const running = await app.ev(`document.querySelector('.task-metadata .dot')?.getAttribute('data-running') === 'true'`);
    const log = await transcript(app, sid);
    const last = log.filter((e) => e.role === "assistant" && String(e.text ?? "").trim()).at(-1);
    return !running && last && log.some((e) => e.role === "tool") ? log : null;
  }, 540_000, 2_000);
  const log = done ?? await transcript(app, sid);
  // The desktop inventory lists the user's own apps and windows: only its counts are kept.
  const tools = log.filter((e) => e.role === "tool").map((e) => String(e.text ?? "").replace(/\s+/g, " ").replace(/(get accessibility tree \d+ running app\(s\), \d+ visible window\(s\)).*/i, "$1 [inventory omitted]").slice(0, 240));
  const screenSteps = await app.ev(`[...new Set((document.querySelector('.session-center')?.innerText ?? '').split('\\n').filter((l) => /computer use/i.test(l)).map((l) => l.trim().slice(0, 80)))]`);
  report.checks.turn = {
    completed: Boolean(done),
    ms: Date.now() - sentAt,
    approvals,
    tools,
    screenSteps,
    reply: String(log.filter((e) => e.role === "assistant" && String(e.text ?? "").trim()).at(-1)?.text ?? "").slice(0, 800),
    engineErrors: log.filter((e) => e.engineError).map((e) => e.engineError),
  };
  report.checks.relay = {
    relays: relaySeen,
    servicesDuringTurn: [...servicesDuringTurn].map((cmd) => ({ onTheUsersDefaultSocket: onDefaultSocket({ command: cmd }), testSocket: cmd.includes("muse-desktop-computer-test-"), argv: cmd })),
  };

  // 3. The aftermath, from Chrome itself and from the server.
  await sleep(1_500);
  const after = await devtools();
  report.checks.chromeAfter = {
    tabs: after,
    serverHits: hits.filter((h) => h.at >= sentAt).map((h) => h.path),
  };

  // 3b. The driver half, harness-driven (no model): the same calls through the service the app
  // itself started on the instance's socket, with the attach grant. Shows what the relay would
  // reach if it found that socket.
  const testSocket = testServices()[0]?.command.match(/--socket (\S+)/)?.[1] ?? null;
  const callDriver = (tool, args) => {
    try { return JSON.parse(execFileSync(DRIVER, ["call", tool, JSON.stringify(args), "--socket", testSocket], { encoding: "utf8", timeout: 60_000 }).replace(/^[^{]*/, "")); } catch (error) { return { error: String(error.stdout ?? error.message).slice(0, 300) }; }
  };
  if (testSocket) {
    const tabsBefore = await devtools();
    const listed = callDriver("list_windows", {});
    const win = (listed.windows ?? []).find((w) => w.app_name === "Google Chrome" && w.title === TARGET_TITLE);
    const args = win ? { pid: win.pid, window_id: win.window_id, session: `harness-${ID}` } : null;
    const prepare = args ? callDriver("browser_prepare", { ...args, strategy: { kind: "existing_profile" } }) : null;
    const state = args ? callDriver("get_browser_state", args) : null;
    const tab = (state?.tabs ?? []).find((t) => t.title === TARGET_TITLE);
    const hitsBefore = hits.length;
    // The coordinate click of the Windows acceptance (trusted route), then the route macOS allows.
    const trusted = tab ? callDriver("browser_click", { ...args, target_id: state.target_id, tab_id: tab.tab_id, x: 400, y: 300 }) : null;
    await sleep(1_000);
    const afterTrusted = await devtools();
    const snapshot = tab ? callDriver("get_browser_state", { ...args, target_id: state.target_id, tab_id: tab.tab_id, mode: "snapshot" }) : null;
    const ref = snapshot?.refs?.find((r) => r.node === "button")?.ref ?? null;
    const clickResult = ref ? callDriver("browser_click", { ...args, target_id: state.target_id, tab_id: tab.tab_id, ref, input_route: "dom_event" }) : null;
    await sleep(1_500);
    report.checks.driverHalf = {
      socket: "the instance's own test socket (the service the app started, --grant existing-profile)",
      tabsBefore,
      window: win ? { app: win.app_name, title: win.title } : null,
      prepare: prepare ? { action: prepare.action ?? null, status: prepare.status ?? null, sideEffects: prepare.side_effects ?? null, error: prepare.error ?? null } : null,
      state: state ? { binding_quality: state.binding_quality ?? null, tabs: (state.tabs ?? []).map((t) => ({ title: t.title, url: t.url })), error: state.error ?? null } : null,
      trustedCoordinateClick: trusted ? JSON.stringify(trusted).slice(0, 300) : null,
      tabsAfterTrustedClick: afterTrusted,
      snapshotRefs: snapshot?.refs ?? null,
      domEventRefClick: clickResult ? JSON.stringify(clickResult).slice(0, 300) : null,
      tabsAfter: await devtools(),
      serverHits: hits.slice(hitsBefore).map((h) => h.path),
    };
  }

  // 4. Turn off and revoke.
  await click(app, `document.querySelector('button.account[aria-label="Settings"]')`);
  await waitFor(() => app.ev(`Boolean([...document.querySelectorAll('section.computer-use button')].find((b) => b.textContent.trim() === 'Turn off and revoke'))`), 10_000, 200);
  await click(app, `[...document.querySelectorAll('section.computer-use button')].find((b) => b.textContent.trim() === 'Turn off and revoke')`);
  const off = await waitFor(() => panel(app).then((p) => (p && p.state === "Off" && p.busy === false ? p : null)), 30_000, 500);
  report.checks.revoked = { panel: off, testServicesLeft: await waitFor(() => (testServices().length === 0 ? [] : null), 15_000, 500) ?? testServices().map((p) => p.command) };
} catch (error) {
  report.failure = String(error?.message ?? error).slice(0, 400);
} finally {
  if (inst) {
    report.consoleErrors = inst.app.errors.slice(0, 20);
    report.stop = await inst.stop();
  }
  // Never leave a service of this instance behind.
  for (const p of drivers().filter((d) => d.command.includes("muse-desktop-computer-test-"))) {
    const socket = p.command.match(/--socket (\S+)/)?.[1];
    if (socket) { try { execFileSync(DRIVER, ["stop", "--socket", socket], { stdio: "ignore", timeout: 15_000 }); } catch { /* gone */ } }
  }
  // A service on the user's default socket that was not there before this run was started by this
  // run's relay: stopped, so the user's socket is left as found.
  if (report.preflight && report.preflight.serviceOnTheUsersDefaultSocketBefore === false && drivers().some(onDefaultSocket)) {
    try { execFileSync(DRIVER, ["stop", "--socket", DEFAULT_SOCKET], { stdio: "ignore", timeout: 15_000 }); } catch { /* gone */ }
    report.stoppedServiceThisRunStartedOnTheUsersSocket = !(await waitFor(() => !drivers().some(onDefaultSocket), 10_000, 500)) ? false : true;
  }
  for (const p of chromes().filter((c) => c.command.includes(PROFILE))) { try { process.kill(p.pid, "SIGTERM"); } catch { /* gone */ } }
  await waitFor(() => chromes().filter((c) => c.command.includes(PROFILE)).length === 0, 15_000, 500);
  report.cleanup = { chromeLeft: chromes().filter((c) => c.command.includes(PROFILE)).length, testServicesLeft: testServices().length, serviceOnTheUsersDefaultSocket: drivers().some(onDefaultSocket) };
  server.close();
  rmSync(PROFILE, { recursive: true, force: true });
  report.cleanup.profileDeleted = !existsSync(PROFILE);
}

const c = report.checks;
const tools = (c.turn?.tools ?? []).join(" | ");
const target = (c.chromeAfter?.tabs ?? []).find((t) => t.url === `${ORIGIN}/unexpected.html`);
const decoy = (c.chromeAfter?.tabs ?? []).find((t) => t.title === DECOY_TITLE);
report.verdicts = {
  "1 consent recorded and the service restarted with --grant existing-profile": c.consent?.attached?.attach === true && (c.consent?.services ?? []).some((s) => /--permission-mode standard --grant existing-profile/.test(s.argv) && /muse-desktop-computer-test-/.test(s.argv)),
  "2 turn completed": c.turn?.completed === true && (c.turn?.engineErrors ?? []).length === 0,
  "2 browser_prepare called by the model": /browser prepare/i.test(`${tools} ${(c.turn?.screenSteps ?? []).join(" ")}`),
  "2 existing profile attached for the model (not refused)": /browser prepare/i.test(tools) && !/browser prepare refused/i.test(tools),
  "2 get_browser_state bound the tabs for the model": /get browser state/i.test(tools) && !/get browser state refused/i.test(tools),
  "2 browser_click executed": /browser click|browser_click|clicked/i.test(`${tools} ${(c.turn?.screenSteps ?? []).join(" ")}`),
  "2 model reported the navigation": /unexpected/i.test(c.turn?.reply ?? ""),
  "3 unexpected navigation happened (Chrome's own list)": Boolean(target) && (c.chromeAfter?.serverHits ?? []).includes("/unexpected.html"),
  "3 decoy untouched": Boolean(decoy) && decoy.url === `${ORIGIN}/decoy.html` && !(c.chromeAfter?.serverHits ?? []).includes("/decoy-clicked"),
  "4 turn off and revoke stops the service": c.revoked?.panel?.state === "Off" && Array.isArray(c.revoked?.testServicesLeft) && c.revoked.testServicesLeft.length === 0,
  "3b driver half on macOS: bind exact, a DOM-route ref click navigates the target, decoy untouched (harness-driven)": c.driverHalf?.prepare?.action === "attached_existing_profile" && c.driverHalf?.state?.binding_quality === "exact" && (c.driverHalf?.tabsAfter ?? []).some((t) => t.url === `${ORIGIN}/unexpected.html`) && (c.driverHalf?.tabsAfter ?? []).some((t) => t.title === DECOY_TITLE && t.url === `${ORIGIN}/decoy.html`) && !(c.driverHalf?.serverHits ?? []).includes("/decoy-clicked"),
  "isolation: the relay reaches the instance's own service, never the user's socket": (c.relay?.relays ?? []).length > 0 && c.relay.relays.every((r) => r.seesTestDataDir && !r.proxyOnDefaultSocket) && !(c.relay?.servicesDuringTurn ?? []).some((s) => s.onTheUsersDefaultSocket),
  "clean stop": report.stop?.leftAfterQuit?.length === 0 && report.stop.defaultStoresUnchangedAtEnd === true && report.stop.testStoreDeleted === true && report.cleanup?.chromeLeft === 0 && !report.failure,
};
report.passed = Object.values(report.verdicts).every(Boolean);
const redact = redactor([[BASE, "<proof>"], [BASE.replace(/^\/var\//, "/private/var/"), "<proof>"], [tmpdir(), "<tmp>"], [tmpdir().replace(/^\/var\//, "/private/var/"), "<tmp>"], [homedir(), "<home>"]]);
mkdirSync(resolve(OUT, ".."), { recursive: true });
writeFileSync(OUT, `${JSON.stringify(redact(report), null, 2)}\n`);
console.log(JSON.stringify({ verdicts: report.verdicts, failure: report.failure ?? null }, null, 2));
process.exit(report.passed ? 0 : 1);
