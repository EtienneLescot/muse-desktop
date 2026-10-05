#!/usr/bin/env node

/**
 * M0-13 native acceptance, no model turn: a click -> effect audit of every
 * surface that carries a capability badge or a connect action. Each action is
 * clicked in the real webview and its effect is measured outside the click
 * (IPC result, storage, a local server's own log, a second HTTP client). An
 * entry passes as "effect" or "refusal"; "silent" (nothing visible) and
 * "fake" (a success claim without the effect) fail.
 *
 *   connectors  real local stdio MCP probe (scripts/msp-fixture.mjs), tool
 *               call, save/start/stop/remove, a nonexistent command, a curated
 *               catalog "Add", an MCP Bundle that is not one, a remote URL the
 *               guard refuses, "Reconnect with current connectors";
 *   library     index (on, pick files, search, rescan, pause/resume, delete,
 *               off) and config import (unparseable text, one session, remove);
 *   computer    Settings > Computer use: state shown vs computer_status and a
 *               Refresh; levels, attach and revoke are NOT clicked (they would
 *               change the user's standing grant);
 *   share       snapshot, unreachable endpoint, invalid endpoint, the local
 *               reference server (publish -> 200 for a second client, revoke
 *               -> 404), forget;
 *   browser     invalid address, local pages served by the harness (hits
 *               counted), back/forward/reload, add to prompt, open in a
 *               window (native window seen by the server and by CDP), tabs,
 *               annotations.
 *
 * Every user setting it touches is restored (connectors, import list, index,
 * share endpoint, composer draft). Test artefacts stay under --base.
 *
 * Usage:
 *   node scripts/cdp-m0-13-click-effect.mjs --conversation "Reply with just the word BASELINE"
 *     [--base G:\muse-proofs\baseline\m0-13] [--only connectors,library,computer,share,browser]
 *     [--out docs/evidence/2026-10-05-roadmap-closure/m0-13-click-effect.json]
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { INSTALL_IPC_TRACE, PORT, argValue, gitHead, openPage, redactor, sleep, waitFor } from "./cdp-harness.mjs";

const BASE = argValue("--base", "G:\\muse-proofs\\baseline\\m0-13");
const CONVERSATION = argValue("--conversation", "Reply with just the word BASELINE");
const ONLY = new Set(argValue("--only", "connectors,library,computer,share,browser").split(","));
const OUT = argValue("--out", "docs/evidence/2026-10-05-roadmap-closure/m0-13-click-effect.json");
const REPO = resolve(".");
// Unquoted on purpose: a quoted path is mangled by the cmd /S /C spawn (measured below).
const FIXTURE_PATH = join(REPO, "scripts", "msp-fixture.mjs");
const FIXTURE_CMD = `node ${FIXTURE_PATH} success`;
const FIXTURE_CMD_QUOTED = `node "${FIXTURE_PATH}" success`;

const H = `
  const vis = (n) => n && n.offsetParent !== null;
  const q = (s, root) => [...(root || document).querySelectorAll(s)].filter(vis);
  const text = (n) => (n ? (n.innerText || '').replace(/\\s+/g, ' ').trim() : null);
  const setValue = (el, v) => {
    const P = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(P, 'value').set.call(el, v);
    el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
  };
  const button = (label, root) => q('button', root).find((b) => text(b) === label || b.getAttribute('aria-label') === label) || null;
  const click = (label, root) => { const b = button(label, root); if (b && !b.disabled) { b.click(); return true; } return false; };
  const alerts = () => q('[role="alert"]').map(text).filter(Boolean).slice(0, 4);
  const statuses = (root) => q('[role="status"]', root).map(text).filter(Boolean).slice(0, 6);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const store = (key) => localStorage.getItem(key);
  const nav = (label) => { const b = q('.primary-nav button').find((n) => n.getAttribute('aria-label') === label); if (b) b.click(); return !!b; };
  const openSettings = () => { const b = document.querySelector('button.account[aria-label="Settings"]'); if (b) b.click(); return !!b; };
`;
const page = (body) => `(async () => { ${H} ${body} })()`;

const audit = [];
const note = (surface, action, outcome, measured) => {
  audit.push({ surface, action, outcome, measured });
  process.stdout.write(`${outcome.padEnd(13)} ${surface} · ${action}\n`);
};

async function ipc(app, cmd) {
  return app.ev(`window.__baselineIpc.calls.filter((c) => c.cmd === ${JSON.stringify(cmd)}).map((c) => ({ ok: c.ok, args: c.args, result: (c.result || '').slice(0, 400) }))`);
}

/** Local HTTP server owned by the harness: counts the hits the browser makes. */
async function hitServer() {
  const hits = [];
  const server = createServer((req, res) => {
    hits.push({ path: req.url, ua: /Edg\//.test(req.headers["user-agent"] ?? "") ? "webview2" : "other", at: Date.now() });
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<!doctype html><title>baseline ${req.url}</title><p>baseline page ${req.url}</p>`);
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  return { hits, url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

async function connectors(app) {
  await app.ev(page("return nav('Extensions');"));
  await sleep(800);
  const before = await app.ev("localStorage.getItem('muse-desktop.connectors.v1')");
  note("connectors", "capability badge", "observed", await app.ev(page(`
    const b = q('section[aria-label="Connectors"] .capability-badge')[0];
    return { label: text(b), accessibleName: b ? b.getAttribute('aria-label') : null };
  `)));

  // A quoted command path (what a path with spaces needs) on the same server.
  const quoted = await app.ev(page(`
    const form = q('section[aria-label="Local MCP server"] form')[0];
    setValue(form.querySelector('input[aria-label="Local MCP command"]'), ${JSON.stringify(FIXTURE_CMD_QUOTED)});
    await wait(200);
    click('Probe', form);
    for (let i = 0; i < 60 && text(button('Probing…', form)); i += 1) await wait(250);
    await wait(500);
    const section = q('section[aria-label="Local MCP server"]')[0];
    return { notice: text(section.querySelector('.integration-notice')), sectionStatus: statuses(section), alertsOnPage: alerts() };
  `));
  const quotedIpc = (await ipc(app, "mcp_local_probe")).at(-1);
  note("connectors", "Probe (quoted command path)", quoted.notice ? "effect" : (quoted.sectionStatus.length > 0 || quoted.alertsOnPage.length > 0) ? "refusal" : "silent",
    { ui: quoted, ipc: { ok: quotedIpc?.ok ?? null, error: quotedIpc?.ok ? null : quotedIpc?.result ?? null } });

  // Real local stdio MCP server.
  const probe = await app.ev(page(`
    const form = q('section[aria-label="Local MCP server"] form')[0];
    setValue(form.querySelector('input[aria-label="Local MCP server name"]'), 'baseline probe');
    setValue(form.querySelector('input[aria-label="Local MCP command"]'), ${JSON.stringify(FIXTURE_CMD)});
    await wait(200);
    click('Probe', form);
    for (let i = 0; i < 40 && !q('.local-mcp-result')[0]; i += 1) await wait(250);
    return { notice: text(q('section[aria-label="Local MCP server"] .integration-notice')[0]), alerts: alerts() };
  `));
  const probeIpc = (await ipc(app, "mcp_local_probe")).at(-1);
  note("connectors", "Probe (real local stdio MCP)", /Connected to msp-fixture 1\.0\.0 · 1 tool/.test(probe.notice ?? "") && probeIpc?.ok ? "effect" : "fail",
    { ui: probe, ipc: { ok: probeIpc?.ok, serverName: JSON.parse(probeIpc?.result || "{}").serverName ?? null, tools: (JSON.parse(probeIpc?.result || "{}").tools ?? []).map((t) => t.name) } });

  const call = await app.ev(page(`
    const box = q('.local-mcp-result')[0];
    setValue(box.querySelector('textarea'), '{"text":"m0-13 echo"}');
    await wait(200);
    const label = q('button', box).map(text).find((t) => t === 'Call tool' || t === 'Review and call');
    click(label, box);
    await wait(500);
    const approval = q('section.connector-approval')[0];
    const approvalShown = Boolean(approval);
    if (approval) click('Allow once', approval);
    for (let i = 0; i < 40 && !q('.local-mcp-output')[0]; i += 1) await wait(250);
    return { label, approvalShown, output: text(q('.local-mcp-output')[0]) };
  `));
  const callIpc = (await ipc(app, "mcp_local_call")).at(-1);
  note("connectors", "Call tool", /m0-13 echo/.test(call.output ?? "") && callIpc?.ok ? "effect" : "fail", { ui: call, ipcOk: callIpc?.ok ?? null });

  const saved = await app.ev(page(`
    click('Save connector');
    await wait(500);
    const row = q('li.integration-row').find((li) => /baseline probe/.test(text(li)));
    const stored = JSON.parse(store('muse-desktop.connectors.v1') || '[]').find((e) => e.id === 'local-mcp-baseline-probe');
    return { rowShown: Boolean(row), stored: stored ? { status: stored.status, tools: stored.tools.map((t) => t.name), hasCommand: Boolean(stored.command) } : null };
  `));
  note("connectors", "Save connector", saved.rowShown && saved.stored?.hasCommand ? "effect" : "fail", saved);

  const startStop = await app.ev(page(`
    const row = () => q('li.integration-row').find((li) => /baseline probe/.test(text(li)));
    click('Start server', row());
    for (let i = 0; i < 40 && !/Persistent server running/.test(text(row())); i += 1) await wait(250);
    const started = text(row().querySelector('.integration-refresh-feedback'));
    click('Stop server', row());
    for (let i = 0; i < 40 && !/stopped/.test(text(row())); i += 1) await wait(250);
    const stopped = text(row().querySelector('.integration-refresh-feedback'));
    return { started, stopped };
  `));
  const startIpc = await app.ev("window.__baselineIpc.calls.filter((c) => /mcp_local_(start|stop)/.test(c.cmd)).map((c) => ({ cmd: c.cmd, ok: c.ok }))");
  note("connectors", "Start server / Stop server", /running · 1 tools/.test(startStop.started ?? "") && /stopped/.test(startStop.stopped ?? "") && startIpc.every((c) => c.ok) ? "effect" : "fail", { ui: startStop, ipc: startIpc });

  const removed = await app.ev(page(`
    const row = q('li.integration-row').find((li) => /baseline probe/.test(text(li)));
    click('Remove', row);
    await wait(600);
    return { rowGone: !q('li.integration-row').some((li) => /baseline probe/.test(text(li))) };
  `));
  note("connectors", "Remove", removed.rowGone ? "effect" : "fail", removed);

  // Nonexistent command: is the failure visible where the click happened?
  const missing = await app.ev(page(`
    const form = q('section[aria-label="Local MCP server"] form')[0];
    setValue(form.querySelector('input[aria-label="Local MCP command"]'), 'baseline-no-such-command-m0-13');
    await wait(200);
    click('Probe', form);
    for (let i = 0; i < 60 && text(button('Probing…', form)); i += 1) await wait(250);
    await wait(500);
    const section = q('section[aria-label="Local MCP server"]')[0];
    return { notice: text(section.querySelector('.integration-notice')), sectionStatus: statuses(section), alertsOnPage: alerts(), errorBannerAnywhere: text(document.querySelector('.error-banner')) };
  `));
  const missingIpc = (await ipc(app, "mcp_local_probe")).at(-1);
  note("connectors", "Probe (nonexistent command)",
    missing.notice === null && (missing.sectionStatus.length > 0 || missing.alertsOnPage.length > 0) ? "refusal" : missing.notice === null ? "silent" : "fake",
    { ui: missing, ipc: { ok: missingIpc?.ok, error: missingIpc?.result ?? null } });

  // Curated catalog entry: what does "Add" promise, and what backs it?
  const curated = await app.ev(page(`
    const entry = q('li.integration-row').find((li) => /^SQLite/.test(text(li)) && button('Add', li));
    if (!entry) return { skipped: 'SQLite already configured' };
    click('Add', entry);
    await wait(500);
    const configured = q('h4').find((h) => /^Configured/.test(text(h)));
    const rows = q('li.integration-row').filter((li) => /^SQLite/.test(text(li)));
    const stored = JSON.parse(store('muse-desktop.connectors.v1') || '[]').find((e) => e.id === 'local-sqlite');
    return {
      catalogFlag: text(rows[0].querySelector('.integration-flag')),
      configuredHeading: text(configured),
      configuredRow: rows[1] ? { text: text(rows[1]), badge: text(rows[1].querySelector('.capability-badge')), actions: q('button', rows[1]).map(text), toggles: q('input[type="checkbox"]', rows[1]).length } : null,
      stored: stored ? { status: stored.status, hasCommand: Boolean(stored.command), useInMuse: stored.useInMuse === true } : null,
    };
  `));
  const curatedHonest = Boolean(curated.configuredRow?.badge && /Not connected/.test(curated.configuredRow.badge));
  note("connectors", "Add (curated catalog entry)", curated.skipped ? "not-exercised" : curatedHonest ? "refusal" : "fake", curated);
  if (!curated.skipped) {
    await app.ev(page(`
      const row = q('li.integration-row').filter((li) => /^SQLite/.test(text(li)))[1];
      if (row) click('Remove', row);
      await wait(400);
      return true;
    `));
  }

  // An MCP Bundle that is not one (file input driven through CDP).
  mkdirSync(BASE, { recursive: true });
  const bogus = join(BASE, "not-a-bundle.mcpb");
  writeFileSync(bogus, randomBytes(512));
  const bundleFiles = await setFiles(app, 'section[aria-label="MCP Bundle package"] input[type="file"]', [bogus]);
  const bundle = await app.ev(page(`
    for (let i = 0; i < 40 && /Installing/.test(text(q('section[aria-label="MCP Bundle package"] .package-picker span')[0]) || ''); i += 1) await wait(250);
    await wait(500);
    const section = q('section[aria-label="MCP Bundle package"]')[0];
    return { sectionText: text(section), sectionStatus: statuses(section), alertsOnPage: alerts(), errorBannerAnywhere: text(document.querySelector('.error-banner')) };
  `));
  const bundleIpc = await app.ev("window.__baselineIpc.calls.filter((c) => /mcp_package/.test(c.cmd)).map((c) => ({ cmd: c.cmd, ok: c.ok, result: (c.result || '').slice(0, 300) }))");
  const bundleRowAdded = await app.ev(page("return q('li.integration-row').some((li) => /not-a-bundle/.test(text(li)));"));
  note("connectors", "Install an MCP Bundle (not a bundle)",
    bundleRowAdded ? "fake" : (bundle.sectionStatus.length > 0 || bundle.alertsOnPage.length > 0) ? "refusal" : "silent",
    { filesDelivered: bundleFiles, ui: bundle, ipc: bundleIpc, rowAdded: bundleRowAdded });

  // Remote connector form with a loopback URL: the guard must refuse it.
  const remote = await app.ev(page(`
    const form = q('form').find((f) => f.querySelector('input[aria-label="Public HTTPS connector URL"]'));
    setValue(form.querySelector('input[aria-label="Remote connector name"]'), 'baseline remote');
    setValue(form.querySelector('input[aria-label="Public HTTPS connector URL"]'), 'http://127.0.0.1:9/mcp');
    await wait(200);
    click('Connect and list tools', form);
    for (let i = 0; i < 60 && text(button('Connecting…', form)); i += 1) await wait(250);
    await wait(400);
    const panel = q('section[aria-label="Connectors"]')[0];
    return { result: text(q('[aria-label="Remote MCP connection result"]')[0]), notices: statuses(panel).filter((s) => !/Connected to msp-fixture/.test(s)), alertsOnPage: alerts() };
  `));
  const remoteIpc = await app.ev("window.__baselineIpc.calls.filter((c) => /remote/.test(c.cmd)).map((c) => ({ cmd: c.cmd, ok: c.ok, result: (c.result || '').slice(0, 200) }))");
  note("connectors", "Connect and list tools (loopback URL)", remote.result === null && (remote.notices.length > 0 || remote.alertsOnPage.length > 0) ? "refusal" : remote.result ? "fake" : "silent", { ui: remote, ipc: remoteIpc });

  // Reconnect the active (test) conversation with the current connectors.
  const reconnect = await app.ev(page(`
    const b = button('Reconnect with current connectors');
    if (!b) return { shown: false };
    b.click();
    for (let i = 0; i < 80 && text(button('Reconnecting…')); i += 1) await wait(250);
    return { shown: true, after: text(button('Reconnect with current connectors')) };
  `));
  const reconnectIpc = await app.ev("window.__baselineIpc.calls.filter((c) => /reconnect|resume|start_session|stop_session|kill/.test(c.cmd)).map((c) => ({ cmd: c.cmd, ok: c.ok }))");
  note("connectors", "Reconnect with current connectors", !reconnect.shown ? "not-exercised" : reconnectIpc.length > 0 && reconnectIpc.every((c) => c.ok) ? "effect" : "fail", { ui: reconnect, ipc: reconnectIpc });

  const after = await app.ev("localStorage.getItem('muse-desktop.connectors.v1')");
  return { connectorsRestored: after === before };
}

/**
 * Feed a file input through CDP and report how many files its change event
 * carried. A webkitdirectory input takes a folder path, not file paths.
 */
async function setFiles(app, selector, files) {
  await app.ev(`(() => {
    const input = document.querySelector(${JSON.stringify(selector)});
    window.__baselineFileChange = null;
    input.addEventListener('change', () => { window.__baselineFileChange = input.files.length; }, { once: true });
    return true;
  })()`);
  await app.send("DOM.enable");
  const doc = await app.send("DOM.getDocument", { depth: -1, pierce: true });
  const node = await app.send("DOM.querySelector", { nodeId: doc.root.nodeId, selector });
  if (!node.nodeId) throw new Error(`no file input ${selector}`);
  await app.send("DOM.setFileInputFiles", { files, nodeId: node.nodeId });
  return waitFor(() => app.ev("window.__baselineFileChange"), 3_000, 100);
}

async function library(app) {
  await app.ev(page("return nav('Library');"));
  await sleep(800);
  const before = await app.ev("({ enabled: localStorage.getItem('muse-desktop.index.enabled.v1'), data: localStorage.getItem('muse-desktop.index.data.v1'), imported: localStorage.getItem('muse-desktop.import.v1') })");
  note("library", "capability badges", "observed", await app.ev(page(`
    return q('.capability-badge').map((b) => ({ label: text(b), accessibleName: b.getAttribute('aria-label') }));
  `)));

  const src = join(BASE, "index-src");
  mkdirSync(src, { recursive: true });
  writeFileSync(join(src, "alpha.md"), "# alpha\nbaselineneedle lives here\n");
  writeFileSync(join(src, "beta.ts"), "export const beta = 1;\n// nothing to see\n");
  const on = await app.ev(page(`
    const panel = q('section[aria-label="Local file index"]')[0];
    const toggle = panel.querySelector('.index-toggle input');
    if (!toggle.checked) toggle.click();
    await wait(400);
    return { status: text(panel.querySelector('.index-status')), stored: store('muse-desktop.index.enabled.v1') };
  `));
  note("library", "Index On", on.stored === "1" && /Empty/.test(on.status ?? "") ? "effect" : "fail", on);
  const indexFiles = await setFiles(app, 'section[aria-label="Local file index"] input[type="file"]', [src]);
  const built = await app.ev(page(`
    const panel = q('section[aria-label="Local file index"]')[0];
    for (let i = 0; i < 40 && /Empty/.test(text(panel.querySelector('.index-status')) || ''); i += 1) await wait(250);
    setValue(panel.querySelector('input[aria-label="Search indexed files"]'), 'baselineneedle');
    await wait(500);
    return { status: q('.index-status', panel).map(text), hits: q('.index-hit', panel).map(text) };
  `));
  note("library", "Choose folder (2 files) + search", /2 file\(s\)/.test(built.status.join(" ")) && built.hits.some((h) => /baselineneedle/.test(h)) ? "effect" : "fail", { filesDelivered: indexFiles, ...built });
  const rescan = await app.ev(page(`
    const panel = q('section[aria-label="Local file index"]')[0];
    const before = text(panel.querySelector('.index-status[title="Last build or rescan"]'));
    click('Rescan', panel);
    await wait(800);
    const after = text(panel.querySelector('.index-status[title="Last build or rescan"]'));
    click('Pause', panel);
    await wait(300);
    const paused = { status: text(panel.querySelector('.index-status')), rescanDisabled: button('Rescan', panel)?.disabled === true };
    click('Resume', panel);
    await wait(300);
    return { before, after, paused, resumed: text(panel.querySelector('.index-status')) };
  `));
  note("library", "Rescan / Pause / Resume", rescan.after !== null && /paused/.test(rescan.paused.status ?? "") && rescan.paused.rescanDisabled && !/paused/.test(rescan.resumed ?? "") ? "effect" : "fail", rescan);
  const del = await app.ev(page(`
    const panel = q('section[aria-label="Local file index"]')[0];
    click('Delete Index', panel);
    await wait(400);
    const status = text(panel.querySelector('.index-status'));
    const toggle = panel.querySelector('.index-toggle input');
    if (toggle.checked) toggle.click();
    await wait(300);
    return { status, data: store('muse-desktop.index.data.v1'), enabled: store('muse-desktop.index.enabled.v1') };
  `));
  note("library", "Delete Index / Off", /Empty/.test(del.status ?? "") && del.data === null && del.enabled === null ? "effect" : "fail", del);

  const imp = await app.ev(page(`
    const panel = q('section[aria-label="Import CLI/IDE config"]')[0];
    const paste = (value) => { setValue(panel.querySelector('textarea[aria-label="Config file content"]'), value); };
    paste('this is not a config');
    await wait(200);
    click('Import text', panel);
    await wait(400);
    const unparseable = q('.collab-list li', panel).map(text);
    paste('{"session_id":"baseline-import-m0-13","title":"baseline import probe"}');
    await wait(200);
    click('Import text', panel);
    await wait(400);
    const rows = q('li.collab-row', panel).map(text);
    const row = q('li.collab-row', panel).find((li) => /baseline import probe/.test(text(li)));
    if (row) click('Remove', row);
    await wait(400);
    return { notes: q('.collab-list li', panel).map(text), unparseable, rowsAfterImport: rows.filter((r) => /baseline/.test(r)), removed: !q('li.collab-row', panel).some((li) => /baseline import probe/.test(text(li))) };
  `));
  note("library", "Import text (unparseable)", imp.unparseable.some((n) => /no importable sessions found/.test(n)) ? "refusal" : "fail", { notes: imp.unparseable });
  note("library", "Import text (one session) / Remove", imp.rowsAfterImport.length === 1 && imp.removed ? "effect" : "fail", { rows: imp.rowsAfterImport, notes: imp.notes, removed: imp.removed });
  const after = await app.ev("({ enabled: localStorage.getItem('muse-desktop.index.enabled.v1'), data: localStorage.getItem('muse-desktop.index.data.v1'), imported: localStorage.getItem('muse-desktop.import.v1') })");
  return { indexRestored: after.enabled === before.enabled && after.data === before.data, importRestored: after.imported === before.imported };
}

async function computer(app) {
  await app.ev(page("return openSettings();"));
  await sleep(1_000);
  const shown = await app.ev(page(`
    const panel = q('section.computer-use')[0];
    if (!panel) return null;
    return {
      state: text(panel.querySelector('.computer-use-state')),
      summary: text(panel.querySelector('.computer-use-summary')),
      levels: q('input[name="computer-use-level"]', panel).map((i) => ({ value: i.value, checked: i.checked })),
      attachChecked: panel.querySelector('.computer-use-attach input')?.checked ?? null,
      actions: q('button', panel).map(text),
    };
  `));
  const native = await app.ev("window.__TAURI_INTERNALS__.invoke('computer_status').then((s) => ({ available: s.available, grantState: s.grantState, attach: s.attach }))");
  const expected = !native.available ? "Not installed" : native.grantState === "active" ? "Granted" : native.grantState === "expired" ? "Grant expired" : native.grantState === "permissions" ? "Needs macOS permission" : "Off";
  note("computer", "state shown vs computer_status", shown?.state === expected ? "effect" : "fake", { shown, native });
  const refreshLabel = shown?.actions.includes("Refresh") ? "Refresh" : shown?.actions.includes("Check again") ? "Check again" : null;
  if (refreshLabel) {
    const before = (await ipc(app, "computer_status")).length;
    await app.ev(page(`click(${JSON.stringify(refreshLabel)}, q('section.computer-use')[0]); return true;`));
    const calls = await waitFor(async () => {
      const all = await ipc(app, "computer_status");
      return all.length > before && all.at(-1).ok !== undefined ? all : null;
    }, 30_000) ?? [];
    const stateAfter = await app.ev(page("return text(q('section.computer-use .computer-use-state')[0]);"));
    note("computer", refreshLabel, calls.length > before && calls.at(-1).ok && stateAfter === shown.state ? "effect" : "fail", { statusCalls: calls.length - before, stateAfter });
  }
  note("computer", "levels / attach / Turn off and revoke", "not-exercised", { reason: "each would change the user's standing desktop-control grant" });
  return {};
}

async function share(app) {
  await app.ev(page("return openSettings();"));
  await sleep(1_000);
  const before = await app.ev("({ endpoint: localStorage.getItem('muse-desktop.share-endpoint.v1') })");
  const snap = await app.ev(page(`
    const panel = q('.share-panel')[0];
    const count = () => q('.share-bundles li.share-bundle', panel).length;
    const n0 = count();
    click('Markdown', q('.share-snapshot', panel)[0]);
    await wait(500);
    return { before: n0, after: count(), newest: text(q('.share-bundles li.share-bundle .share-bundle-head', panel)[0]) };
  `));
  note("share", "Snapshot (Markdown)", snap.after === snap.before + 1 ? "effect" : "fail", snap);

  const setEndpoint = (url, token) => app.ev(page(`
    const panel = q('.share-panel')[0];
    setValue(panel.querySelector('input[aria-label="Share service URL"]'), ${JSON.stringify(url)});
    setValue(panel.querySelector('input[aria-label="Share service token"]'), ${JSON.stringify(token)});
    await wait(200);
    click('Save service', panel);
    await wait(300);
    return { configured: text(panel.querySelector('.share-endpoint-ok')), error: text(panel.querySelector('.share-endpoint [role="alert"]')) };
  `));
  const invalid = await setEndpoint("ftp://example.invalid/x", "");
  note("share", "Save service (invalid URL)", invalid.error && !invalid.configured ? "refusal" : "fake", invalid);

  const closed = await new Promise((done) => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => done(p)); }); });
  const unreachable = await setEndpoint(`http://127.0.0.1:${closed}`, "unused");
  const publishTry = await app.ev(page(`
    const panel = q('.share-panel')[0];
    const row = q('.share-bundles li.share-bundle', panel)[0];
    click('Publish', row);
    for (let i = 0; i < 60 && text(button('Publishing…', row)); i += 1) await wait(250);
    await wait(300);
    return { error: q('[role="alert"]', panel).map(text), published: Boolean(row.querySelector('.share-url')) };
  `));
  note("share", "Publish (service unreachable)", !publishTry.published && publishTry.error.length > 0 ? "refusal" : publishTry.published ? "fake" : "silent", { configured: unreachable.configured?.replace(/\d+$/, "<port>"), ...publishTry });

  const token = randomBytes(12).toString("hex");
  const port = closed;
  const server = spawn(process.execPath, ["scripts/share-server.mjs", "--port", String(port)], { env: { ...process.env, SHARE_TOKEN: token }, stdio: ["ignore", "pipe", "pipe"] });
  try {
    await waitFor(async () => (await fetch(`http://127.0.0.1:${port}/health`).catch(() => null))?.ok ?? false, 10_000, 250);
    await setEndpoint(`http://127.0.0.1:${port}`, token);
    const published = await app.ev(page(`
      const panel = q('.share-panel')[0];
      const row = q('.share-bundles li.share-bundle', panel)[0];
      click('Publish', row);
      for (let i = 0; i < 60 && !row.querySelector('.share-url'); i += 1) await wait(250);
      return { url: text(row.querySelector('.share-url')), alerts: q('[role="alert"]', panel).map(text) };
    `));
    const read = published.url ? await fetch(published.url).then(async (r) => ({ status: r.status, hasTitle: /BASELINE/i.test(await r.text()) })) : null;
    note("share", "Publish (local reference server)", read?.status === 200 && read.hasTitle ? "effect" : "fail", { urlShape: published.url?.replace(/^http:\/\/127\.0\.0\.1:\d+/, "<server>"), secondClient: read, alerts: published.alerts });
    const revoked = await app.ev(page(`
      const panel = q('.share-panel')[0];
      const row = q('.share-bundles li.share-bundle', panel)[0];
      click('Revoke', row);
      for (let i = 0; i < 40 && !/Revoked/.test(text(row)); i += 1) await wait(250);
      return { text: text(row.querySelector('p')) };
    `));
    const after = published.url ? (await fetch(published.url)).status : null;
    note("share", "Revoke", after === 404 && /Revoked/.test(revoked.text ?? "") ? "effect" : "fail", { ui: revoked, secondClientStatus: after });
  } finally {
    server.kill();
  }
  const forgot = await app.ev(page(`
    const panel = q('.share-panel')[0];
    click('Forget', panel);
    await wait(300);
    return { configured: text(panel.querySelector('.share-endpoint-ok')), stored: store('muse-desktop.share-endpoint.v1') };
  `));
  // Forget writes a JSON null; the profile had no key at all, so put that back.
  note("share", "Forget", forgot.configured === null && JSON.parse(forgot.stored ?? "null") === null ? "effect" : "fail", forgot);
  if (before.endpoint === null) await app.ev("(localStorage.removeItem('muse-desktop.share-endpoint.v1'), true)");
  return { endpointRestored: (await app.ev("localStorage.getItem('muse-desktop.share-endpoint.v1')")) === before.endpoint };
}

async function browser(app) {
  const server = await hitServer();
  const tabsBefore = await app.ev("Object.fromEntries(Object.keys(localStorage).filter((k) => k.startsWith('muse-desktop.browser.tabs.v1')).map((k) => [k, localStorage.getItem(k)]))");
  try {
    await openConversation(app);
    const opened = await app.ev(page(`
      const toggle = q('button').find((b) => b.getAttribute('aria-label') === 'Show work panel');
      if (toggle) toggle.click();
      await wait(400);
      click('Browser', q('nav.work-tabs')[0]);
      await wait(600);
      return Boolean(q('section.browser')[0]);
    `));
    if (!opened) { note("browser", "open panel", "fail", { opened }); return {}; }
    const go = (url) => app.ev(page(`
      const panel = q('section.browser')[0];
      setValue(panel.querySelector('input[aria-label="Address"]'), ${JSON.stringify(url)});
      await wait(150);
      panel.querySelector('form.browser-toolbar').requestSubmit();
      await wait(1200);
      return { notice: text(panel.querySelector('.browser-notice')), iframe: panel.querySelector('iframe')?.getAttribute('src') || null, address: panel.querySelector('input[aria-label="Address"]').value };
    `));
    const shownBefore = await app.ev(page("return q('section.browser iframe')[0]?.getAttribute('src') || null;"));
    const invalid = await go("not a url ::");
    note("browser", "Go (invalid address)", invalid.notice && invalid.iframe === shownBefore ? "refusal" : "fake",
      { ...invalid, iframeUnchanged: invalid.iframe === shownBefore, iframe: invalid.iframe ? "<previous page>" : null });
    const hits0 = server.hits.length;
    const first = await go(`${server.url}/page-1`);
    await sleep(800);
    note("browser", "Go (local page)", server.hits.slice(hits0).some((h) => h.path === "/page-1") ? "effect" : "fail", { iframe: first.iframe?.replace(server.url, "<server>"), serverHits: server.hits.slice(hits0).map((h) => h.path) });
    await go(`${server.url}/page-2`);
    await sleep(800);
    const hits1 = server.hits.length;
    const nav = await app.ev(page(`
      const panel = q('section.browser')[0];
      click('Back', panel); await wait(1200);
      const back = panel.querySelector('input[aria-label="Address"]').value;
      click('Forward', panel); await wait(1200);
      const forward = panel.querySelector('input[aria-label="Address"]').value;
      click('Reload', panel); await wait(1200);
      return { back, forward };
    `));
    const navHits = server.hits.slice(hits1).map((h) => h.path);
    note("browser", "Back / Forward / Reload", /page-1$/.test(nav.back) && /page-2$/.test(nav.forward) && navHits.join(",") === "/page-1,/page-2,/page-2" ? "effect" : "fail", { back: nav.back.replace(server.url, "<server>"), forward: nav.forward.replace(server.url, "<server>"), serverHits: navHits });

    const ctx = await app.ev(page(`
      const panel = q('section.browser')[0];
      const field = document.querySelector('textarea[placeholder^="Ask Muse"]') || q('main textarea')[0];
      const before = field ? field.value : null;
      click('Add this page to the prompt', panel);
      await wait(600);
      const after = field ? field.value : null;
      if (field) { setValue(field, before || ''); }
      return { before, after };
    `));
    note("browser", "Add this page to the prompt", /\[Browser context\]/.test(ctx.after ?? "") && ctx.after.includes("/page-2") ? "effect" : "fail", { inserted: ctx.after?.replace(server.url, "<server>") ?? null, composerRestored: true });

    const targetsBefore = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).map((t) => t.id);
    const hits2 = server.hits.length;
    await app.ev(page("click('Open in a browser window', q('section.browser')[0]); await wait(4000); return true;"));
    const windowIpc = (await ipc(app, "open_native_browser")).at(-1);
    const targets = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter((t) => !targetsBefore.includes(t.id));
    const nativeTarget = targets.find((t) => t.url.startsWith(server.url));
    note("browser", "Open in a browser window", windowIpc?.ok && (nativeTarget || server.hits.length > hits2) ? "effect" : windowIpc?.ok === false ? "refusal" : "fail",
      { ipcOk: windowIpc?.ok ?? null, ipcResult: windowIpc?.result ?? null, newCdpTarget: nativeTarget ? nativeTarget.url.replace(server.url, "<server>") : null, serverHits: server.hits.slice(hits2).map((h) => h.path) });
    // Close it through the app (closing the page over CDP leaves the window
    // registered, and the next open "reuses" a dead webview).
    const closed = await app.ev(`window.__TAURI_INTERNALS__.invoke('close_native_browser', { sessionId: ${JSON.stringify(windowIpc?.args?.sessionId ?? "")} })`).catch((error) => String(error.message ?? error));
    note("browser", "close the browser window (app command)", closed === true ? "effect" : "fail", { closed });

    const tabs = await app.ev(page(`
      const panel = q('section.browser')[0];
      const count = () => q('[role="tab"]', panel).length;
      const n0 = count();
      click('New tab', panel); await wait(300);
      const n1 = count();
      const close = q('button.browser-tab-close', panel).at(-1);
      if (close) close.click();
      await wait(300);
      return { n0, n1, n2: count() };
    `));
    note("browser", "New tab / close tab", tabs.n1 === tabs.n0 + 1 && tabs.n2 === tabs.n0 ? "effect" : "fail", tabs);

    const ann = await app.ev(page(`
      const panel = q('section.browser')[0];
      const key = 'muse-desktop.browser.annotations.v1';
      const count = () => (JSON.parse(store(key) || '[]') || []).length;
      const n0 = count();
      setValue(panel.querySelector('input[aria-label="Annotation comment"]'), 'baseline annotation');
      await wait(200);
      click('Anchor', panel); await wait(400);
      const listed = q('.browser-annotation-comment', panel).map(text);
      const n1 = count();
      const remove = q('button', panel).find((b) => b.getAttribute('aria-label') === 'Remove annotation baseline annotation');
      if (remove) remove.click();
      await wait(400);
      return { n0, n1, n2: count(), listed };
    `));
    note("browser", "Anchor / remove annotation", ann.n1 === ann.n0 + 1 && ann.n2 === ann.n0 && ann.listed.includes("baseline annotation") ? "effect" : "fail", ann);
    await app.ev(page("const t = q('button').find((b) => b.getAttribute('aria-label') === 'Hide work panel'); if (t) t.click(); return true;"));
  } finally {
    server.close();
  }
  // Put the per-conversation tab lists back as they were (the panel is closed).
  const restored = await app.ev(`(() => {
    const before = ${JSON.stringify(tabsBefore)};
    for (const k of Object.keys(localStorage).filter((k) => k.startsWith('muse-desktop.browser.tabs.v1'))) if (!(k in before)) localStorage.removeItem(k);
    for (const [k, v] of Object.entries(before)) localStorage.setItem(k, v);
    return Object.keys(localStorage).filter((k) => k.startsWith('muse-desktop.browser.tabs.v1')).every((k) => localStorage.getItem(k) === before[k]);
  })()`);
  return { browserTabsRestored: restored };
}

/** Make the test conversation active (its project group may be collapsed). */
async function openConversation(app) {
  const opened = await app.ev(page(`
    const row = [...document.querySelectorAll('.sidebar-scroll button.session-select')].find((b) => (b.textContent || '').trim().startsWith(${JSON.stringify(CONVERSATION)}));
    if (!row) return false;
    const group = row.closest('details');
    if (group && !group.open) group.open = true;
    await wait(200);
    row.click();
    await wait(1200);
    return true;
  `));
  if (!opened) throw new Error(`conversation "${CONVERSATION}" not found in the sidebar`);
}

const SURFACES = { connectors, library, computer, share, browser };
const app = await openPage();
const report = {
  schema: "muse-desktop.m0-13-click-effect.v1",
  ticket: "M0-13",
  date: new Date().toISOString().slice(0, 10),
  commit: gitHead(),
  platform: "Windows 11 (26200), debug build with embedded frontend, WebView2 over CDP",
  modelTurns: 0,
  restored: {},
};
try {
  await openConversation(app);
  for (const [name, run] of Object.entries(SURFACES)) {
    if (!ONLY.has(name)) continue;
    await app.ev(INSTALL_IPC_TRACE);
    try {
      Object.assign(report.restored, await run(app));
    } catch (error) {
      note(name, "harness", "error", { message: String(error?.message ?? error).slice(0, 300) });
    }
  }
} finally {
  report.audit = audit;
  report.summary = audit.reduce((acc, e) => ({ ...acc, [e.outcome]: (acc[e.outcome] ?? 0) + 1 }), {});
  report.consoleErrors = app.errors.slice(0, 20);
  app.close();
}
const record = redactor([[BASE, "<proof>"], [REPO, "<repo>"]])(report);
writeFileSync(OUT, `${JSON.stringify(record, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ summary: record.summary, restored: record.restored }, null, 2)}\n`);
