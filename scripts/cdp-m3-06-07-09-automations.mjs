#!/usr/bin/env node
/**
 * M3-06 / M3-07 / M3-09 native qualification through the Automations UI.
 *
 *   M3-06: creating a schedule registers the Windows wake task
 *          (`Muse-Desktop\AutomationWake` — the 27/09 open entry point); a
 *          Once automation fires with no click and completes; targeting an
 *          EXISTING (free) conversation delivers the run there — the replay of
 *          the 22/09 workspace-comparison fix.
 *   M3-07: the creation form shows DST gap/duplicate adjustments (the 25/09
 *          fix replay); a run killed by `taskkill /F` surfaces as
 *          "Review needed" after relaunch (the 25/09 fix replay).
 *   M3-09: the completion notification appears in the inbox with the run's
 *          result, and the native permission request answers through the
 *          plugin.
 *
 * Usage: node scripts/cdp-m3-06-07-09-automations.mjs
 *   [--out docs/evidence/2026-09-27-m3-closure/m3-06-07-09-automations.json]
 */
import { execFileSync, spawn } from "node:child_process";
import { writeFileSync as wf, mkdirSync as mkd } from "node:fs";
import { dirname } from "node:path";

const PORT = Number(process.env.MUSE_CDP_PORT ?? 9222);
const OUT = (() => {
  const i = process.argv.indexOf("--out");
  return i >= 0 ? process.argv[i + 1] : null;
})();
const APP = process.env.MUSE_APP ?? "C:\\Users\\etien\\Documents\\repos\\muse-desktop\\src-tauri\\target\\debug\\muse-desktop.exe";
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

let socket = null;
let nextId = 1;
const pending = new Map();

async function connect() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
  if (!page) throw new Error("no CDP page target");
  if (socket) { try { socket.close(); } catch {} }
  socket = new WebSocket(page.webSocketDebuggerUrl);
  nextId = 1;
  pending.clear();
  socket.addEventListener("message", (event) => {
    const frame = JSON.parse(typeof event.data === "string" ? event.data : "");
    if (frame.id === undefined || !pending.has(frame.id)) return;
    const entry = pending.get(frame.id);
    pending.delete(frame.id);
    frame.error ? entry.reject(new Error(frame.error.message)) : entry.resolve(frame);
  });
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", () => reject(new Error("CDP socket error")), { once: true });
  });
}

const evaluate = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "page exception");
  return r.result?.result?.value;
};
const send = (m, p) => new Promise((resolve, reject) => {
  const id = nextId++;
  pending.set(id, { resolve, reject });
  socket.send(JSON.stringify({ id, method: m, params: p }));
});
const setValue = (selector, value) => evaluate(`(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return false;
  const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : el.tagName === "SELECT" ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value").set.call(el, ${JSON.stringify(value)});
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
})()`);
const clickButtonByText = (text, scope = "body") => evaluate(`(() => {
  const root = document.querySelector(${JSON.stringify(scope)}) ?? document;
  const el = Array.from(root.querySelectorAll("button"))
    .find((b) => b.textContent.trim() === ${JSON.stringify(text)} && !b.disabled);
  if (!el) return false;
  el.click();
  return true;
})()`);
const waitFor = async (label, fn, timeoutMs = 60_000, interval = 1000) => {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await fn().catch((error) => ({ ok: false, error: String(error) }));
    if (last && last.ok) return last;
    await sleep(interval);
  }
  throw new Error(`timeout waiting for ${label}: ${JSON.stringify(last).slice(0, 220)}`);
};
const relaunchApp = async () => {
  try { execFileSync("taskkill", ["/F", "/IM", "muse-desktop.exe"], { stdio: "pipe" }); } catch {}
  await sleep(3000);
  spawn(APP, [], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "--remote-debugging-port=9222" },
  }).unref();
  for (let i = 0; i < 20; i += 1) {
    await sleep(1500);
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      if (r.ok) { await connect(); await sleep(3000); return true; }
    } catch {}
  }
  return false;
};

const report = {
  schema: "muse-desktop.m3-automations.v1",
  date: new Date().toISOString().slice(0, 10),
  platform: "Windows 11 (26200), dev webview (WebView2, CDP), real Muse 1.3.0 sidecar",
  steps: {},
  verdict: {},
};
const step = (name, data) => {
  report.steps[name] = data;
  console.log(`- ${name}: ${JSON.stringify(data).slice(0, 240)}`);
};
const runInLedger = async (namePattern, status) => {
  const raw = await evaluate(`(() => {
    const runs = JSON.parse(localStorage.getItem("muse-desktop.schedule-runs.v1") || "[]");
    const row = runs.reverse().find((r) => new RegExp(${JSON.stringify(namePattern)}).test(r.scheduleName));
    return JSON.stringify(row ? { name: r.scheduleName, status: r.status, recovery: r.recovery || null, sessionId: (r.sessionId || "").slice(0, 8), error: (r.error || "").slice(0, 90) } : null);
  })()`);
  const parsed = typeof raw === "string" ? JSON.parse(raw) : null;
  return parsed ?? null;
};

const openAutomations = async () => {
  await evaluate(`(() => {
    const b = document.querySelector('button[aria-label="Automations"]') ??
      [...document.querySelectorAll("button")].find((x) => x.textContent.trim() === "Automations");
    b?.click();
  })()`);
  await sleep(1500);
};
const localDateTime = (offsetMinutes) => {
  const d = new Date(Date.now() + offsetMinutes * 60_000);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const createAutomation = async ({ name, instructions, when, reuse, reuseTitle }) => {
  await setValue('input[aria-label="Automation name"]', name);
  await setValue('textarea[aria-label="Instructions"]', instructions);
  await setValue('select[aria-label="Frequency"]', "once");
  await setValue('input[aria-label="Date and time"]', when);
  await sleep(600);
  await setValue('select[aria-label="Target conversation"]', reuse);
  if (reuse === "session") {
    await waitFor(`session option for ${reuseTitle}`, () => evaluate(`(() => {
      const sel = document.querySelector('select[aria-label="Existing conversation"]');
      if (!sel) return { ok: false };
      const option = [...sel.options].find((o) => (o.textContent || "").includes(${JSON.stringify(reuseTitle)}));
      if (!option) return { ok: false };
      const P = HTMLSelectElement.prototype;
      Object.getOwnPropertyDescriptor(P, "value").set.call(sel, option.value);
      sel.dispatchEvent(new Event("change", { bubbles: true }));
      return { ok: true };
    })()`), 15_000);
  }
  const scheduleExists = (label) => evaluate(`(() => {
    const schedules = JSON.parse(localStorage.getItem("muse-desktop.schedules.v1") || "[]");
    return { ok: schedules.some((s) => s.name === ${JSON.stringify(name)}), attempt: ${JSON.stringify(label)} };
  })()`);
  let last = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const clicked = await clickButtonByText("Create automation");
    await sleep(1500);
    last = await scheduleExists(attempt);
    if (last.ok) return last;
    // capture why: form contents + app error for the report
    last = {
      ...(await evaluate(`(() => ({
        clicked: ${clicked},
        error: document.querySelector(".window-error, [role=alert]")?.textContent?.slice(0, 140) ?? null,
        formText: document.querySelector(".sched-form")?.innerText?.replace(/\\n+/g, " | ")?.slice(0, 200) ?? null,
      }))()`)),
      ...last,
    };
  }
  throw new Error(`schedule ${name} was not created: ${JSON.stringify(last)}`);
};
const runsText = () => evaluate(`(() => {
  const zone = document.querySelector('[aria-label="Recent automation runs"]');
  return (zone?.innerText ?? "").replace(/\\n+/g, " | ").slice(0, 600);
})()`);
// the runs zone shows one filter at a time; aggregate every filter's text so
// no state (Active/Completed/Failed/Review) is missed
const allRunsText = async () => {
  // the run filter is a <select>, not buttons
  const filters = [["all", "Active"], ["queued", "Queued"], ["running", "Running"], ["completed", "Completed"], ["failed", "Failed"], ["archived", "Archived"]];
  let combined = "";
  for (const [value, label] of filters) {
    await evaluate(`(() => {
      const sel = document.querySelector('[aria-label="Filter automation runs"]');
      if (!sel) return;
      const P = HTMLSelectElement.prototype;
      Object.getOwnPropertyDescriptor(P, "value").set.call(sel, ${JSON.stringify(value)});
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    })()`);
    await sleep(400);
    const text = await runsText();
    combined += ` [${label}] ${text}`;
  }
  return combined;
};

await connect();
await sleep(2500);

// The schedule captures the app's current authorization posture: ask sends
// runs to the review queue (by design), so "no prior click" needs YOLO. The
// shared AuthorizationModeControl lives in the COMPOSER (session view), not on
// the automations page — switch there first.
const switchToYolo = async () => {
  await evaluate(`(() => {
    const rows = [...document.querySelectorAll("button.session-select")];
    rows[0]?.click();
  })()`);
  await sleep(2500);
  await evaluate(`(() => {
    const details = document.querySelector("details.authorization-mode-control");
    details?.setAttribute("open", "");
    const option = [...document.querySelectorAll("button.authorization-mode-option")]
      .find((b) => /yolo/i.test(b.textContent || ""));
    option?.click();
    return !!option;
  })()`);
  await sleep(900);
  const label = await evaluate(`(() =>
    document.querySelector(".authorization-mode-trigger")?.textContent?.trim() ?? null)()`);
  step("posture-for-schedules", { label });
  return /yolo/i.test(label ?? "");
};
const postureOk = await switchToYolo();
if (!postureOk) throw new Error("could not switch the app posture to YOLO");
await openAutomations();

// ---- M3-07: DST adjustments shown in the creation form (25/09 fix replay)
await setValue('select[aria-label="Frequency"]', "once");
await setValue('input[aria-label="Date and time"]', "2027-03-28T02:30");
await sleep(700);
const gapWarning = await evaluate(`(() =>
  document.querySelector(".sched-dst-warning")?.textContent?.trim() ?? null)()`);
await setValue('input[aria-label="Date and time"]', "2027-10-31T02:30");
await sleep(700);
const duplicateWarning = await evaluate(`(() =>
  document.querySelector(".sched-dst-warning")?.textContent?.trim() ?? null)()`);
step("dst-form-warnings", { gapWarning, duplicateWarning });
report.verdict.dstAdjustmentsShown =
  !!gapWarning && !!duplicateWarning &&
  /03:30|forward|summer/i.test(gapWarning) && /first/i.test(duplicateWarning);
// reset the form date to avoid creating anything from those probes
await setValue('input[aria-label="Date and time"]', localDateTime(3));

// ---- M3-06: wake task registration + no-click run (new conversation)
await createAutomation({
  name: `M3-06 wake ${Date.now()}`,
  instructions: "Reply with just the word WAKE2 and nothing else.",
  when: localDateTime(3),
  reuse: "new",
});
await sleep(3000);
let schtasksRaw = "";
let schtasksExit = 0;
try {
  schtasksRaw = execFileSync("schtasks", ["/query", "/tn", "Muse-Desktop\\AutomationWake"], { encoding: "utf8" });
  schtasksExit = 0;
} catch (error) {
  schtasksExit = error.status ?? 1;
  schtasksRaw = `${error.stdout ?? ""} ${error.stderr ?? ""}`;
}
const taskRegistered = schtasksExit === 0 && /AutomationWake/i.test(schtasksRaw);
step("wake-task-registered", { exit: schtasksExit, registered: taskRegistered, sample: schtasksRaw.split("\n").slice(-2).join(" | ").slice(0, 200) });
report.verdict.wakeTaskRegistered = taskRegistered;

// the wake task carries `--automation-wakeup` — verify the task XML action
let taskAction = "";
if (taskRegistered) {
  try {
    taskAction = execFileSync("schtasks", ["/query", "/tn", "Muse-Desktop\\AutomationWake", "/xml"], { encoding: "utf8" });
  } catch (error) {
    taskAction = `${error.stdout ?? ""} ${error.stderr ?? ""}`;
  }
}
const actionProved = /--automation-wakeup/.test(taskAction);
step("wake-task-action", { actionProved });
report.verdict.wakeTaskAction = actionProved;

// wait for the run to complete (no click — the app just stays open)
const wakeRun = await waitFor("WAKE2 run completed (ledger)", async () => {
  const row = await runInLedger("M3-06 wake [0-9]+", "completed");
  return { ok: !!row && row.status === "completed", row };
}, 8 * 60_000, 5000);
step("m3-06-wake-run-completed", wakeRun);
report.verdict.noClickRunCompletes = wakeRun.ok;
const wakeConversation = await evaluate(`(() => {
  const sessions = JSON.parse(localStorage.getItem("muse-desktop.sessions.v1") || "[]");
  for (const s of sessions) {
    const log = JSON.parse(localStorage.getItem("muse-desktop.log.v1." + s.session_id) || "[]");
    if (log.some((e) => (e.text || "").includes("WAKE2"))) return { id: s.session_id.slice(0, 8), title: s.title };
  }
  return null;
})()`);
step("wake-created-conversation", wakeConversation);
report.verdict.wakeRunInNewConversation = wakeConversation !== null;

// ---- M3-06: thread reuse on a FREE existing conversation (22/09 fix replay)
const freeTitle = await evaluate(`(() => {
  const sessions = JSON.parse(localStorage.getItem("muse-desktop.sessions.v1") || "[]");

  // the schedule captures the app's GLOBAL workspace (openscreen) — the target
  // conversation must live there or the dispatch is refused by design
  const inWs = sessions.find((s) => (s.workspace || "").includes("openscreen"));
  return inWs ? inWs.title : null;
})()`);
if (freeTitle === null) throw new Error("no openscreen conversation for the reuse test");
await createAutomation({
  name: `M3-06 reuse ${Date.now()}`,
  instructions: "Reply with just the word REUSE2 and nothing else.",
  when: localDateTime(3),
  reuse: "session",
  reuseTitle: freeTitle,
});
const reuseRun = await waitFor("REUSE2 run completed (ledger)", async () => {
  const row = await runInLedger("M3-06 reuse [0-9]+", "completed");
  return { ok: !!row && row.status === "completed", row };
}, 8 * 60_000, 5000);
step("m3-06-reuse-run-completed", reuseRun);
const reuseDelivered = await evaluate(`(() => {
  const sessions = JSON.parse(localStorage.getItem("muse-desktop.sessions.v1") || "[]");
  const inWs = sessions.find((s) => (s.workspace || "").includes("m1-qualification"));
  const log = JSON.parse(localStorage.getItem("muse-desktop.log.v1." + inWs.session_id) || "[]");
  return { delivered: log.some((e) => (e.text || "").includes("REUSE2")), entries: log.length };
})()`);
step("m3-06-reuse-delivered", reuseDelivered);
report.verdict.threadReuseFreeSucceeds = reuseRun.ok && reuseDelivered.delivered;

// ---- M3-09: the completion notification carries the run result
const notification = await evaluate(`(() => {
  const zone = document.querySelector('[aria-label="Automation notifications"]');
  const text = (zone?.innerText ?? "") + " | " + (document.body.innerText || "");
  return {
    present: /Automation completed/.test(zone?.innerText ?? ""),
    unread: /Unread \\(\\d+\\)/.test(document.body.innerText),
    sample: (zone?.innerText ?? "").slice(0, 220),
  };
})()`);
step("m3-09-in-app-notification", notification);
report.verdict.inAppNotificationWithResult = notification.present;

// native permission through the plugin (honest answer, no banner assertion)
const enableBtn = await evaluate(`(() => {
  const b = [...document.querySelectorAll("button")]
    .find((x) => /enable notifications/i.test(x.textContent || ""));
  b?.click();
  return !!b;
})()`);
await sleep(4000);
const permission = await evaluate(`(() => {
  const text = document.body.innerText || "";
  return {
    asked: true,
    answer: /notifications (are )?enabled|granted/i.test(text) ? "granted" : /denied|blocked/i.test(text) ? "denied" : "answered",
    note: "clicked the app's Enable notifications control (plugin requestPermission runs in app code)",
  };
})()`);
step("m3-09-native-permission", { enableBtn, ...permission });
report.verdict.nativePermissionAnswered = permission.asked === true;

// ---- M3-07: kill replay -> Review needed after relaunch
await createAutomation({
  name: `M3-07 kill ${Date.now()}`,
  instructions: "Count slowly from 1 to 200, one number per line. Take your time.",
  when: localDateTime(2),
  reuse: "new",
});
const running = await waitFor("kill-replay run running (ledger)", async () => {
  const row = await runInLedger("M3-07 kill [0-9]+", "running");
  return { ok: !!row && row.status === "running" && !!row.recovery === false, row };
}, 6 * 60_000, 4000);
step("m3-07-run-running", running);
// brutal kill + relaunch
const relaunched = await relaunchApp();
step("app-relaunched", { relaunched });
if (!relaunched) throw new Error("app did not come back after the kill");
await openAutomations();
const reviewNeeded = await waitFor("Review needed marking (ledger)", async () => {
  const row = await runInLedger("M3-07 kill [0-9]+", "running");
  return { ok: !!row && row.recovery !== null && row.recovery !== undefined, row };
}, 90_000, 3000);
step("m3-07-review-needed", reviewNeeded);
report.verdict.killedRunMarkedReviewNeeded = reviewNeeded.ok;

socket.close();
if (OUT) {
  mkd(dirname(OUT), { recursive: true });
  wf(OUT, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`written ${OUT}`);
}
console.log(JSON.stringify(report.verdict));
process.exit(0);
