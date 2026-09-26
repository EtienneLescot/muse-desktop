#!/usr/bin/env node
/**
 * M2-02 native qualification: sandbox postures really apply.
 *
 *   1. baseline: the running dev hosts' command lines;
 *   2. project posture switch (workspace) + "Restart workspace host" -> the
 *      respawned host carries `--sandbox-network restricted`;
 *   3. posture raised to elevated while the host runs workspace -> a new
 *      conversation in the same project hits the explicit refusal
 *      ("workspace host already uses sandbox posture workspace; request a
 *      restart") with the Restart action;
 *   4. after the restart the host runs `--disable-sandbox --sandbox-network
 *      enabled`;
 *   5. durability: `taskkill /F` the host, resume the conversation -> the
 *      respawned host still carries the project's posture;
 *   6. two projects, two postures at once: a second scratch project set to
 *      `network` runs `--sandbox-network enabled` while project 1 stays
 *      elevated.
 *
 * Usage: node scripts/cdp-m2-02-postures.mjs
 *   [--out docs/evidence/2026-09-26-m2-closure/m2-02-postures.json]
 */
import { execFileSync } from "node:child_process";
import { writeFileSync as wf, mkdirSync as mkd, rmSync, readdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";

const PORT = Number(process.env.MUSE_CDP_PORT ?? 9222);
const OUT = (() => {
  const i = process.argv.indexOf("--out");
  return i >= 0 ? process.argv[i + 1] : null;
})();
const REPO2 = "G:\\repos\\m1-qualif-2";
const REPO2_FWD = "G:/repos/m1-qualif-2";
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const hostLines = () => {
  const raw = execFileSync(
    "powershell",
    ["-NoProfile", "-Command",
      "Get-CimInstance Win32_Process -Filter \"Name='muse.exe'\" | Where-Object { $_.CommandLine -like '*target*' } | ForEach-Object { $_.CommandLine }"],
    { encoding: "utf8" },
  ).trim();
  return raw.split(/\r?\n/).map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean);
};

// --- second scratch project folder
if (existsSync(REPO2_FWD)) {
  for (const entry of readdirSync(REPO2_FWD)) {
    try { rmSync(join(REPO2_FWD, entry), { recursive: true, force: true }); } catch {}
  }
} else {
  mkd(REPO2_FWD, { recursive: true });
}
execFileSync("git", ["init", "-q", REPO2_FWD]);
execFileSync("git", ["-C", REPO2_FWD, "config", "user.email", "qualif@local"]);
execFileSync("git", ["-C", REPO2_FWD, "config", "user.name", "Qualif Locale"]);
wf(join(REPO2_FWD, "README.md"), "# Scratch qualif 2\n");
execFileSync("git", ["-C", REPO2_FWD, "add", "-A"]);
execFileSync("git", ["-C", REPO2_FWD, "commit", "-qm", "initial"]);

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
if (!page) throw new Error("no CDP page target");
const socket = new WebSocket(page.webSocketDebuggerUrl);
let nextId = 1;
const pending = new Map();
socket.addEventListener("message", (event) => {
  const frame = JSON.parse(typeof event.data === "string" ? event.data : "");
  if (frame.id === undefined || !pending.has(frame.id)) return;
  const entry = pending.get(frame.id);
  pending.delete(frame.id);
  frame.error ? entry.reject(new Error(`${entry.method}: ${frame.error.message}`)) : entry.resolve(frame);
});
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", () => reject(new Error("CDP socket error")), { once: true });
});
const send = (m, p) => new Promise((resolve, reject) => {
  const id = nextId++;
  pending.set(id, { resolve, reject });
  socket.send(JSON.stringify({ id, method: m, params: p }));
});
const evaluate = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "page exception");
  return r.result?.result?.value;
};
const report = {
  schema: "muse-desktop.m2-02-postures.v1",
  date: new Date().toISOString().slice(0, 10),
  platform: "Windows 11 (26200), dev webview (WebView2, CDP), real Muse 1.3.0 sidecar",
  steps: {},
  verdict: {},
};
const step = (name, data) => {
  report.steps[name] = data;
  console.log(`- ${name}: ${JSON.stringify(data).slice(0, 260)}`);
};
const setValue = (selector, value) => evaluate(`(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return false;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, ${JSON.stringify(value)});
  el.dispatchEvent(new Event("input", { bubbles: true }));
  return true;
})()`);

// open the scratch conversation (m1-qualification) so Settings edits ITS project
await sleep(2000);
const target = await evaluate(`(() => {
  const sessions = JSON.parse(localStorage.getItem("muse-desktop.sessions.v1") || "[]");
  const inWs = sessions.find((s) => (s.workspace || "").includes("m1-qualification"));
  return inWs ? { id: inWs.session_id, title: inWs.title } : null;
})()`);
if (!target) throw new Error("scratch conversation not found");
await evaluate(`(() => {
  const row = [...document.querySelectorAll("button.session-select")]
    .find((b) => (b.getAttribute("title") || "") === ${JSON.stringify(target.title)});
  row?.click();
})()`);
await sleep(3500);

// declare the second project for step 6
await evaluate(`(() => {
  const key = "muse-desktop.projects.v1";
  const projects = JSON.parse(localStorage.getItem(key) || "[]");
  const ws = "G:\\\\repos\\\\m1-qualif-2";
  if (projects.some((p) => (p.workspace || "") === ws)) return { added: false };
  projects.push({
    id: "m1-qualif-2-project",
    name: "m1-qualif-2",
    workspace: ws,
    workspaces: [ws],
    instructions: "",
    workspaceReviewed: true,
    createdAt: Date.now(),
  });
  localStorage.setItem(key, JSON.stringify(projects));
  return { added: true };
})()`);

// 1. baseline
const baseline = hostLines();
step("baseline-host-lines", baseline);

// open Settings
await evaluate(`(() => {
  document.querySelector('button[aria-label="Settings"]')?.click();
})()`);
await sleep(1200);
const currentMode = await evaluate(`(() => ({
  effective: document.querySelector(".authorization-status strong")?.textContent ?? null,
  selected: document.querySelector('input[name="sandbox-mode"]:checked')?.value ?? null,
}))()`);
step("settings-current", currentMode);

// 2. switch the project posture to workspace + restart the host
await evaluate(`(() => {
  const radio = document.querySelector('input[name="sandbox-mode"][value="workspace"]');
  radio?.click();
})()`);
await sleep(800);
const pick1 = await evaluate(`(() => ({
  selected: document.querySelector('input[name="sandbox-mode"]:checked')?.value ?? null,
}))()`);
step("posture-picked-workspace", pick1);
await evaluate(`(() => {
  const b = [...document.querySelectorAll("button")].find((x) => /Restart workspace host/.test(x.textContent));
  b?.click();
})()`);
await sleep(9000);
const linesWorkspace = hostLines();
step("hosts-after-workspace-restart", linesWorkspace);
report.verdict.workspacePostureApplies =
  linesWorkspace.some((l) => l.includes("--sandbox-network restricted") && !l.includes("--disable-sandbox"));

// 3. raise the project posture to elevated -> a new conversation hits the refusal
await evaluate(`(() => {
  const radio = document.querySelector('input[name="sandbox-mode"][value="elevated"]');
  radio?.click();
})()`);
await sleep(800);
// close settings, start a new conversation in the same project
await evaluate(`(() => {
  const nav = Array.from(document.querySelectorAll("button")).find(
    (b) => (b.getAttribute("aria-label") || "") === "New conversation",
  );
  nav?.click();
})()`);
await sleep(2500);
await evaluate(`(() => {
  const picker = document.querySelector("details.project-picker-control");
  if (picker) {
    picker.setAttribute("open", "");
    const option = [...picker.querySelectorAll("button, [role=option]")]
      .find((o) => /m1-qualification/i.test(o.textContent));
    option?.click();
  }
})()`);
await sleep(800);
await evaluate(`(() => {
  const area = document.querySelector('textarea[aria-label="Your first message"]');
  const P = HTMLTextAreaElement.prototype;
  Object.getOwnPropertyDescriptor(P, "value").set.call(area, "Reply ELEV1.");
  area.dispatchEvent(new Event("input", { bubbles: true }));
})()`);
await evaluate(`document.querySelector("button.welcome-send")?.click()`);
await sleep(6000);
const refusal = await evaluate(`(() => {
  const text = (document.body.innerText || "");
  const m = text.match(/workspace host already uses sandbox posture[^\\n]*/i);
  return { found: !!m, message: m ? m[0].slice(0, 140) : null, restartOffered: /Restart workspace host/i.test(text) };
})()`);
step("refusal-on-posture-switch", refusal);
report.verdict.postureSwitchRefused = refusal.found;

// 4. restart the host so the elevated posture applies
await evaluate(`(() => {
  const b = [...document.querySelectorAll("button")].find((x) => /Restart workspace host/i.test(x.textContent || x.title || ""));
  b?.click();
})()`);
await sleep(9000);
const linesElevated = hostLines();
step("hosts-after-elevated-restart", linesElevated);
report.verdict.elevatedPostureApplies =
  linesElevated.some((l) => l.includes("--disable-sandbox") && l.includes("--sandbox-network enabled"));

// 5. durability: kill the dev hosts, resume the conversation, re-read
execFileSync("taskkill", ["/F", "/IM", "muse.exe"], { stdio: "pipe" });
await sleep(3000);
await evaluate(`(() => {
  const row = [...document.querySelectorAll("button.session-select")]
    .find((b) => (b.getAttribute("title") || "") === ${JSON.stringify(target.title)});
  row?.click();
})()`);
await sleep(9000);
const linesAfterKill = hostLines();
step("hosts-after-kill-resume", linesAfterKill);
report.verdict.postureDurableAcrossKill =
  linesAfterKill.some((l) => l.includes("--disable-sandbox") && l.includes("--sandbox-network enabled"));

// 6. second project with its own posture (network)
await evaluate(`(() => {
  const nav = Array.from(document.querySelectorAll("button")).find(
    (b) => (b.getAttribute("aria-label") || "") === "New conversation",
  );
  nav?.click();
})()`);
await sleep(2500);
await evaluate(`(() => {
  const picker = document.querySelector("details.project-picker-control");
  if (picker) {
    picker.setAttribute("open", "");
    const option = [...picker.querySelectorAll("button, [role=option]")]
      .find((o) => /m1-qualif-2/i.test(o.textContent));
    option?.click();
  }
})()`);
await sleep(800);
await evaluate(`(() => {
  const area = document.querySelector('textarea[aria-label="Your first message"]');
  const P = HTMLTextAreaElement.prototype;
  Object.getOwnPropertyDescriptor(P, "value").set.call(area, "Reply NET2.");
  area.dispatchEvent(new Event("input", { bubbles: true }));
})()`);
// set THIS project's posture to network while the welcome screen is up is not
// possible (settings need an active conversation); start first, then switch.
await evaluate(`document.querySelector("button.welcome-send")?.click()`);
await sleep(9000);
await evaluate(`(() => {
  document.querySelector('button[aria-label="Settings"]')?.click();
})()`);
await sleep(1200);
await evaluate(`(() => {
  const radio = document.querySelector('input[name="sandbox-mode"][value="network"]');
  radio?.click();
})()`);
await sleep(800);
await evaluate(`(() => {
  const b = [...document.querySelectorAll("button")].find((x) => /Restart workspace host/.test(x.textContent));
  b?.click();
})()`);
await sleep(9000);
const linesBoth = hostLines();
step("hosts-two-projects-two-postures", linesBoth);
report.verdict.twoProjectsTwoPostures =
  linesBoth.some((l) => l.includes("--sandbox-network enabled") && !l.includes("--disable-sandbox")) &&
  linesBoth.some((l) => l.includes("--disable-sandbox"));

socket.close();
report.verdict.all =
  !!report.verdict.workspacePostureApplies &&
  !!report.verdict.postureSwitchRefused &&
  !!report.verdict.elevatedPostureApplies &&
  !!report.verdict.postureDurableAcrossKill &&
  !!report.verdict.twoProjectsTwoPostures;
if (OUT) {
  mkd(dirname(OUT), { recursive: true });
  wf(OUT, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`written ${OUT}`);
}
console.log(JSON.stringify(report.verdict));
process.exit(0);
