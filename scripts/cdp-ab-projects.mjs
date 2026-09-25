#!/usr/bin/env node

/**
 * Two-project isolation scenario for M0-01 / M0-14, driven through CDP.
 *
 * Requires the CDP-enabled dev build:
 *   $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=9222"
 *   npm run tauri -- dev
 *
 * Usage: node scripts/cdp-ab-projects.mjs [--live]
 *
 * The workspace registry lives in `muse-desktop.projects.v1`. A second project
 * is declared only when `--declare` is passed, so the scenario never mutates
 * application state unless it was asked to.
 */
import { argv, exit } from "node:process";

const PORT = Number(process.env.MUSE_CDP_PORT ?? 9222);
const LIVE = argv.includes("--live");
const DECLARE = argv.includes("--declare");
const SECOND_WORKSPACE = process.env.MUSE_SECOND_WORKSPACE ?? "C:\\Users\\etien\\Documents\\repos\\muse-desktop";
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function pageTarget() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = list.find((t) => t.type === "page" && typeof t.webSocketDebuggerUrl === "string");
  if (!page) throw new Error("no CDP page target");
  return page;
}

function connect(url) {
  const socket = new WebSocket(url);
  let nextId = 1;
  const pending = new Map();
  const ready = new Promise((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("CDP socket error")), { once: true });
  });
  socket.addEventListener("message", (event) => {
    let frame;
    try { frame = JSON.parse(typeof event.data === "string" ? event.data : ""); } catch { return; }
    if (frame.id === undefined) return;
    const entry = pending.get(frame.id);
    if (!entry) return;
    pending.delete(frame.id);
    clearTimeout(entry.timer);
    if (frame.error) entry.reject(new Error(`${entry.method}: ${frame.error.message}`));
    else entry.resolve(frame.result);
  });
  return {
    ready,
    send(method, params = {}) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method}: timed out`)); }, 30_000);
        pending.set(id, { resolve, reject, method, timer });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    close() { try { socket.close(); } catch { /* closed */ } },
  };
}

async function evaluate(client, expression) {
  const wrapped = `(() => { try { return JSON.stringify(${expression}); }
    catch (error) { return JSON.stringify({ __error: String((error && error.message) || error) }); } })()`;
  const result = await client.send("Runtime.evaluate", { expression: wrapped, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? "eval failed");
  const parsed = JSON.parse(result.result?.value ?? "null");
  if (parsed && typeof parsed === "object" && "__error" in parsed) throw new Error(parsed.__error);
  return parsed;
}

const HELPERS = `
  const vis = (n) => n && n.offsetParent !== null;
  const nodes = (s) => [...document.querySelectorAll(s)].filter(vis);
  const text = (n) => ((n.innerText || n.getAttribute("aria-label") || n.getAttribute("title") || "").trim());
  const all = () => nodes('button, a, [role="button"], [role="tab"]');
  const clickText = (want) => {
    const hit = all().find((n) => text(n) === want)
      || all().find((n) => text(n).toLowerCase().includes(want.toLowerCase()));
    if (!hit) return false;
    hit.click();
    return true;
  };
  const composer = () => nodes('textarea, [contenteditable="true"]')[0] || null;
  const setField = (f, v) => {
    const P = f.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(P, "value").set.call(f, v);
    f.dispatchEvent(new Event("input", { bubbles: true }));
    f.focus();
  };
  const state = () => {
    const body = (document.body.innerText || "").replace(/\\s+/g, " ");
    const f = composer();
    const projects = JSON.parse(localStorage.getItem("muse-desktop.projects.v1") || "[]");
    const sessions = JSON.parse(localStorage.getItem("muse-desktop.sessions.v1") || "[]");
    return {
      composerDisabled: f ? f.disabled === true : null,
      connected: /Connected/.test(body),
      disconnected: /Disconnected/.test(body),
      connectionError: /Connection error/.test(body),
      working: /WORKING/.test(body),
      projectCount: Array.isArray(projects) ? projects.length : null,
      projectNames: Array.isArray(projects) ? projects.map((p) => p.name) : null,
      sessionCount: Array.isArray(sessions) ? sessions.length : null,
      workspaces: Array.isArray(sessions) ? [...new Set(sessions.map((s) => (s.workspace || "").slice(-30)))] : null,
      tail: body.slice(-240)
    };
  };
`;

async function main() {
  const target = await pageTarget();
  const client = connect(target.webSocketDebuggerUrl);
  await client.ready;
  const report = { schema: "muse-desktop.cdp-ab-projects.v1", live: LIVE, declared: DECLARE, steps: {} };
  try {
    report.steps.initial = await evaluate(client, `(() => { ${HELPERS} return state(); })()`);

    if (DECLARE) {
      report.steps.declare = await evaluate(client, `(() => {
        ${HELPERS}
        const key = "muse-desktop.projects.v1";
        const projects = JSON.parse(localStorage.getItem(key) || "[]");
        const ws = ${JSON.stringify(SECOND_WORKSPACE)};
        if (projects.some((p) => (p.workspace || "") === ws)) return { added: false, reason: "already declared" };
        projects.push({
          id: "ab-project-" + Math.random().toString(36).slice(2, 10),
          name: "muse-desktop",
          workspace: ws,
          workspaces: [ws],
          instructions: "",
          workspaceReviewed: true,
          createdAt: Date.now()
        });
        localStorage.setItem(key, JSON.stringify(projects));
        return { added: true, count: projects.length, workspace: ws };
      })()`);
      await sleep(500);
      await evaluate(client, "location.reload()").catch(() => undefined);
      await sleep(6_000);
      report.steps.afterReload = await evaluate(client, `(() => { ${HELPERS} return state(); })()`);
    }

    // Open the new-conversation screen so the environment picker is available.
    report.steps.newConversation = await evaluate(client, `(() => { ${HELPERS} return { clicked: clickText("New conversation") }; })()`);
    await sleep(2_500);
    report.steps.picker = await evaluate(client, `(() => {
      ${HELPERS}
      const body = (document.body.innerText || "").replace(/\\s+/g, " ");
      const startIn = nodes("select")[0];
      return {
        startInOptions: startIn ? [...startIn.options].map((o) => o.textContent.trim()) : null,
        startInCount: startIn ? startIn.options.length : 0,
        bodyTail: body.slice(-300)
      };
    })()`);

    if (!LIVE) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      return;
    }

    // Start a conversation rooted in the second project root. Two picker
    // implementations exist: with a declared project the welcome screen uses
    // a start-in `<select>`; without one it uses the reworked project picker
    // (`details` + option buttons). Try both.
    report.steps.pickSecond = await evaluate(client, `(() => {
      ${HELPERS}
      const sel = nodes("select")[0];
      if (sel) {
        const target = [...sel.options].find((o) => /muse-desktop/i.test(o.textContent));
        if (target) {
          const P = HTMLSelectElement.prototype;
          Object.getOwnPropertyDescriptor(P, "value").set.call(sel, target.value);
          sel.dispatchEvent(new Event("change", { bubbles: true }));
          return { picked: true, via: "select", label: target.textContent.trim(), value: target.value };
        }
      }
      const openWelcome = () => {
        const nav = [...document.querySelectorAll('button')].find((b) =>
          (b.getAttribute('aria-label') || '') === 'New conversation' &&
          !b.closest('[class*="session"]'));
        if (nav) nav.click();
        return !!nav;
      };
      let picker = document.querySelector('details.project-picker-control');
      if (!picker) { openWelcome(); }
      picker = document.querySelector('details.project-picker-control');
      if (!picker) return { picked: false, reason: "no project picker control" };
      picker.setAttribute('open', '');
      const options = [...document.querySelectorAll('.project-picker-control button, .project-picker-control [role="option"]')];
      const target = options.find((o) => /muse-desktop/i.test(o.textContent));
      if (!target) return { picked: false, reason: "project option missing", options: options.map((o) => o.textContent.trim().slice(0, 40)) };
      target.click();
      return { picked: true, via: "details-picker", label: target.textContent.trim().slice(0, 60) };
    })()`);
    await sleep(1_500);
    report.steps.fill = await evaluate(client, `(() => {
      ${HELPERS}
      const f = composer();
      if (!f) return { filled: false, reason: "no composer" };
      if (f.disabled) return { filled: false, reason: "composer disabled" };
      setField(f, "Reply with just the word ISOLATED and nothing else.");
      return { filled: true, value: f.value };
    })()`);
    report.steps.submit = await evaluate(client, `(() => { ${HELPERS}
      if (clickText("Start conversation")) return { clicked: true, via: "text" };
      const icon = document.querySelector('button.welcome-send, [aria-label="Start conversation"]');
      if (icon) { icon.click(); return { clicked: true, via: "aria-label" }; }
      return { clicked: false };
    })()`);
    await sleep(4_000);
    report.steps.afterStart = await evaluate(client, `(() => { ${HELPERS} return state(); })()`);
  } catch (error) {
    report.failure = String((error && error.message) || error).slice(0, 300);
  } finally {
    client.close();
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

await main().catch((error) => { process.stderr.write(`${(error && error.message) || error}\n`); exit(1); });
