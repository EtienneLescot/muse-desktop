#!/usr/bin/env node
/**
 * M0-11 on macOS: the English interface and the navigation details, in the
 * macOS webview (WKWebView), on an isolated test instance driven by the
 * protocol fixture (scripts/muse-fixture.mjs, ADR 0003): no model turn.
 *
 * - French audit (the cdp-language-audit.mjs markers, extended to title,
 *   aria-label and placeholder attributes) on every surface the Windows audit
 *   reached plus the ones it missed: home, new conversation, automations,
 *   extensions, library, search, settings, archives, a conversation with an
 *   approval card, the same conversation after its turn.
 * - Modifier labels: every hint naming a modifier, which must say Cmd on macOS.
 * - Shortcuts with Cmd, dispatched as key events (Input.dispatchKeyEvent,
 *   modifiers 4): Cmd+K search, Cmd+N new conversation, Cmd+, Settings, Cmd+B
 *   sidebar; the conversation switch the sidebar hint announces; the zoom keys
 *   the brand hint announces.
 * - Search with the system locale (en_FR here): case and accents.
 * - displayPath: the conversation header shows the folder as a POSIX path.
 * - Window chrome: native traffic lights (no custom caption buttons), a drag
 *   region.
 *
 *   node scripts/macos/m0-11-language-navigation.mjs --exe ~/muse-proofs/app/08b291d/muse-desktop
 *     [--port 9423] [--base $TMPDIR/muse-proofs-g2/m0-11]
 *     [--out docs/evidence/2026-10-13-macos-closure/m0-11-language-navigation.json]
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { argValue, redactor, sleep, waitFor } from "../cdp-harness.mjs";
import { FIXTURE, engineVersion, launch } from "./test-instance.mjs";
import { newProjectConversation, sendFirstMessage } from "./smoke-real-turn.mjs";

const EXE = resolve(argValue("--exe", join(homedir(), "muse-proofs", "app", "08b291d", "muse-desktop")));
const PORT = Number(argValue("--port", "9423"));
const BASE = resolve(argValue("--base", join(tmpdir(), "muse-proofs-g2", "m0-11")));
const OUT = argValue("--out", "docs/evidence/2026-10-13-macos-closure/m0-11-language-navigation.json");
const RUN = join(BASE, `run-${Date.now().toString(36)}`);
const P1 = join(RUN, "projet-électricité");
const P2 = join(RUN, "second");
const redact = redactor([[P1, "<project 1>"], [P2, "<project 2>"], [RUN, "<run>"], [BASE, "<proof>"]]
  .flatMap(([p, l]) => [[p, l], [`/private${p}`, l]]).concat([[homedir(), "~"]]));

const H = `
  const vis = (n) => n && n.offsetParent !== null;
  const q = (s, root) => [...(root || document).querySelectorAll(s)].filter(vis);
  const activeSid = () => document.querySelector('li.session-item.active')?.getAttribute('data-session-id') || null;
`;
const page = (body) => `(async () => { ${H} ${body} })()`;

/** The cdp-language-audit.mjs markers, over visible text and over title / aria-label / placeholder. */
const AUDIT = page(`
  const markers = ["Ajouter","Supprimer","Enregistrer","Fermer","Ouvrir","Rechercher","Choisir","Afficher","Masquer","Annuler",
    "Valider","Aucun","Aucune","Créer","Modifier","Exécuter","Arrêter","Reprendre","Espace de travail","Réglages","Paramètres",
    "Automatisations","Bibliothèque","Tâche","Fichier","Envoyer","Réessayer","Reconnecter","Compacter","Dossier","Projet","Nouvelle"];
  const functionWords = /\\b(le|la|les|des|une|pour|avec|dans|sur|est|sont|votre|vous|nous|qui|que|ne|pas|tout|tous|toute|aucun|aucune|être|avoir|fait|faire)\\b/i;
  const hit = (raw) => { const m = markers.find((x) => raw.toLowerCase().includes(x.toLowerCase())); const w = functionWords.test(raw); return m || w ? { marker: m || null, functionWord: w } : null; };
  const texts = new Map();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let visibleStrings = 0;
  while (walker.nextNode()) {
    const raw = (walker.currentNode.textContent || '').trim();
    if (raw.length < 2 || raw.length > 160) continue;
    const el = walker.currentNode.parentElement;
    if (!el) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none') continue;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    visibleStrings++;
    const h = hit(raw);
    if (h && !texts.has(raw)) texts.set(raw, { text: raw.slice(0, 120), ...h, tag: el.tagName, cls: String(el.className || '').slice(0, 60) });
  }
  const attrs = new Map();
  const modifierHints = new Map();
  for (const el of document.querySelectorAll('[title], [aria-label], [placeholder]')) {
    for (const name of ['title', 'aria-label', 'placeholder']) {
      const v = el.getAttribute(name);
      if (!v) continue;
      const h = hit(v);
      if (h && !attrs.has(v)) attrs.set(v, { attr: name, value: v.slice(0, 120), ...h, tag: el.tagName });
      if (/\\b(Ctrl|Cmd|Command|Control|Alt|Option|Meta)\\b|⌘|⌃/.test(v) && !modifierHints.has(v)) modifierHints.set(v, { attr: name, value: v.slice(0, 160), tag: el.tagName, cls: String(el.className || '').slice(0, 40) });
    }
  }
  return { visibleStrings, textHits: [...texts.values()], attributeHits: [...attrs.values()], modifierHints: [...modifierHints.values()],
    surface: { settings: Boolean(document.querySelector('.settings-panel')), search: Boolean(document.querySelector('dialog.task-search[open]')), heading: (q('h1, h2')[0]?.innerText || '').slice(0, 60) } };
`);

const key = (app, keyName, code, modifiers = 0, text) => app.send("Input.dispatchKeyEvent", { type: "keyDown", key: keyName, code, modifiers, ...(text ? { text } : {}) })
  .then(() => app.send("Input.dispatchKeyEvent", { type: "keyUp", key: keyName, code, modifiers }));
const CMD = 4;
const CTRL = 2;

async function clickNav(app, label) {
  return app.ev(page(`const b = q('.primary-nav button, .session-list button, button').find((n) => (n.getAttribute('aria-label') || n.innerText || '').trim() === ${JSON.stringify(label)}); if (b) { b.click(); return true; } return false;`));
}

/** Answers the fixture's approval card with a real click on its accepting button, then waits for the turn's end. */
async function approveFixtureCard(app) {
  const box = await waitFor(() => app.ev(page(`
    const b = q('.approvals .approval-actions button.approve')[0];
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, text: b.innerText.trim() };
  `)), 30_000, 300);
  if (!box) return { clicked: false };
  await app.send("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button: "left", clickCount: 1 });
  await app.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x, y: box.y, button: "left", clickCount: 1 });
  const done = await waitFor(() => app.ev(page("return q('.approvals .approval').length === 0 && [...document.querySelectorAll('.msg')].some((n) => /fixture turn resumed/.test(n.innerText));")), 30_000, 300);
  return { clicked: true, button: box.text, turnEnded: Boolean(done) };
}

async function main() {
  mkdirSync(P1, { recursive: true });
  mkdirSync(P2, { recursive: true });
  for (const p of [P1, P2]) execFileSync("git", ["init", "-q"], { cwd: p });
  const record = {
    schema: "muse-desktop.m0-11-language-navigation-macos.v1",
    ticket: "M0-11",
    date: new Date().toISOString().slice(0, 10),
    commit: "08b291d",
    platform: `macOS ${execFileSync("sw_vers", ["-productVersion"], { encoding: "utf8" }).trim()} (${execFileSync("sw_vers", ["-buildVersion"], { encoding: "utf8" }).trim()}), ${process.arch}, debug build with embedded frontend, WKWebView through the test bridge`,
    engine: "scripts/muse-fixture.mjs (protocol double, ADR 0003); no real engine and no model turn in this proof",
    pinnedEngineOnThisMachine: engineVersion(),
    liveTurns: 0,
    harness: `scripts/macos/m0-11-language-navigation.mjs, port ${PORT}`,
    systemLocale: { AppleLocale: execFileSync("defaults", ["read", "-g", "AppleLocale"], { encoding: "utf8" }).trim() },
    method: "Isolated test instance (scripts/macos/test-instance.mjs) on the protocol fixture. Two project conversations created from the welcome screen (folders answered by the IPC trace), each first message typed and sent with a real Enter, each fixture approval card answered with a real mouse click. Every surface audited in the DOM with the cdp-language-audit.mjs markers, over visible text and over title, aria-label and placeholder; every attribute naming a modifier collected. Shortcuts dispatched as key events through the bridge (Input.dispatchKeyEvent, Cmd = modifiers 4, Ctrl = 2): they reach the page's keydown handlers, as a real key press in the focused window would; the OS-level handling of Cmd+Tab (the app switcher) is outside the page. Zoom measured as window.innerWidth in CSS pixels. Search typed with Input.insertText in the Cmd+K dialog.",
    surfaces: {},
    checks: {},
  };
  const inst = await launch({ exe: EXE, port: PORT, data: join(RUN, "data"), engine: ["node", FIXTURE] });
  record.isolation = inst.isolation;
  const app = inst.app;
  const audit = async (name) => { record.surfaces[name] = await app.ev(AUDIT); };
  try {
    record.webview = await app.ev("({ language: navigator.language, languages: navigator.languages, platform: navigator.platform })");
    await audit("home");

    // Two fixture conversations (each turn raises one approval card).
    record.checks.conversation1 = { start: await newProjectConversation(app, P1) };
    const sid1 = await sendFirstMessage(app, "Électricité : vérifie le compteur, puis réponds.");
    await waitFor(() => app.ev(page("return q('.approvals .approval').length > 0;")), 30_000, 300);
    await audit("conversation-with-approval-card");
    record.checks.conversation1.approve = await approveFixtureCard(app);
    await audit("conversation");
    record.checks.displayPath = await app.ev(page(`
      const spans = q('header span[title]').map((s) => ({ title: s.getAttribute('title'), text: s.textContent }));
      const ws = spans.find((s) => s.text.startsWith('/'));
      return { shown: ws ? ws.text : null, title: ws ? ws.title : null };
    `));
    record.checks.displayPath.expected = P1;
    record.checks.conversation2 = { start: await newProjectConversation(app, P2) };
    const sid2 = await sendFirstMessage(app, "Second conversation for the switch check.");
    record.checks.conversation2.approve = await approveFixtureCard(app);
    const order = await app.ev(page("return q('li.session-item').map((n) => n.getAttribute('data-session-id'));"));

    // Shortcuts.
    const sc = {};
    await key(app, "k", "KeyK", CMD);
    sc.cmdK = Boolean(await waitFor(() => app.ev("Boolean(document.querySelector('dialog.task-search[open]'))"), 3_000, 100));
    await audit("search");
    // Search with the system locale: lower case, upper case, and without the accent.
    const searchFor = async (text) => {
      await app.ev(page(`const i = document.querySelector('dialog.task-search input'); i.focus(); i.select(); return true;`));
      await app.send("Input.insertText", { text });
      await sleep(400);
      return app.ev(page(`const d = document.querySelector('dialog.task-search'); return { query: d.querySelector('input').value, results: [...d.querySelectorAll('.search-results button')].map((b) => b.innerText.replace(/\\s+/g, ' ').trim().slice(0, 80)), empty: Boolean(d.querySelector('.search-results p.muted')) };`));
    };
    record.checks.search = { lower: await searchFor("électricité"), upper: await searchFor("ÉLECTRICITÉ"), unaccented: await searchFor("electricite") };
    await key(app, "Escape", "Escape");
    sc.escapeClosesSearch = Boolean(await waitFor(() => app.ev("!document.querySelector('dialog.task-search[open]')"), 3_000, 100));
    await key(app, "n", "KeyN", CMD);
    sc.cmdN = Boolean(await waitFor(() => app.ev("Boolean(document.querySelector('textarea[aria-label=\"Your first message\"]'))"), 3_000, 100));
    await audit("new-conversation");
    await key(app, ",", "Comma", CMD);
    sc.cmdComma = Boolean(await waitFor(() => app.ev("Boolean(document.querySelector('.settings-panel'))"), 3_000, 100));
    await audit("settings");
    await key(app, ",", "Comma", CMD);
    sc.cmdCommaCloses = Boolean(await waitFor(() => app.ev("!document.querySelector('.settings-panel')"), 3_000, 100));
    await key(app, "b", "KeyB", CMD);
    sc.cmdB = Boolean(await waitFor(() => app.ev("document.querySelector('.app').classList.contains('nav-collapsed')"), 3_000, 100));
    await key(app, "b", "KeyB", CMD);
    sc.cmdBRestores = Boolean(await waitFor(() => app.ev("!document.querySelector('.app').classList.contains('nav-collapsed')"), 3_000, 100));

    // Conversation switch: what the sidebar hint says, and which modifier the app obeys.
    await app.ev(page(`document.querySelector('li.session-item[data-session-id="${sid1}"] button.session-select')?.click(); return true;`));
    await waitFor(() => app.ev(page(`return activeSid() === ${JSON.stringify(sid1)};`)), 5_000, 100);
    const sw = { hint: await app.ev("document.querySelector('.threads-label')?.getAttribute('title') || null"), order: order.map((s) => (s === sid1 ? "conversation 1" : s === sid2 ? "conversation 2" : "other")) };
    sw.before = (await app.ev(page("return activeSid();"))) === sid1 ? "conversation 1" : "other";
    await key(app, "Tab", "Tab", CMD);
    await sleep(600);
    sw.afterCmdTab = (await app.ev(page("return activeSid();"))) === sid1 ? "conversation 1 (unchanged)" : "switched";
    await key(app, "Tab", "Tab", CTRL);
    await sleep(600);
    sw.afterCtrlTab = (await app.ev(page("return activeSid();"))) === sid2 ? "conversation 2 (switched)" : "unchanged";
    record.checks.conversationSwitch = sw;

    // Zoom keys, as the brand hint announces them.
    const zoom = { hint: await app.ev("document.querySelector('.brand-text')?.getAttribute('title') || null") };
    const width = () => app.ev("window.innerWidth");
    zoom.width0 = await width();
    await key(app, "=", "Equal", CMD, "=");
    await sleep(800);
    zoom.afterCmdPlus = await width();
    await key(app, "-", "Minus", CMD, "-");
    await sleep(800);
    await key(app, "-", "Minus", CMD, "-");
    await sleep(800);
    zoom.afterTwoCmdMinus = await width();
    await key(app, "0", "Digit0", CMD, "0");
    await sleep(800);
    zoom.afterCmd0 = await width();
    record.checks.zoom = zoom;
    record.checks.shortcuts = sc;

    // Remaining surfaces.
    for (const [label, name] of [["Automations", "automations"], ["Extensions", "extensions"], ["Library", "library"]]) {
      const clicked = await clickNav(app, label);
      await sleep(1_200);
      await audit(clicked ? name : `${name}-NOT-CLICKED`);
    }
    const archives = await app.ev(page("const b = q('button').find((n) => /^Archived conversations$/.test((n.innerText || n.getAttribute('aria-label') || '').trim())); if (b) { b.click(); return true; } return false;"));
    await sleep(1_200);
    await audit(archives ? "archives" : "archives-NOT-CLICKED");

    record.checks.windowChrome = await app.ev(page(`return {
      customCaptionButtons: document.querySelectorAll('.window-controls').length,
      platformMacosClass: document.querySelector('.app')?.classList.contains('platform-macos') ?? false,
      dragRegions: document.querySelectorAll('[data-tauri-drag-region]').length,
      brandDragHandler: Boolean(document.querySelector('.brand')),
    };`));
    record.consoleErrors = app.errors.slice(0, 10);
  } catch (error) {
    record.failure = String(error?.message ?? error).slice(0, 400);
  } finally {
    record.stop = await inst.stop();
  }

  const s = record.surfaces;
  const c = record.checks;
  const allHints = [...new Map(Object.values(s).flatMap((x) => x.modifierHints ?? []).map((h) => [h.value, h])).values()];
  record.modifierHints = allHints;
  record.verdicts = {
    everySurfaceReached: ["home", "conversation-with-approval-card", "conversation", "search", "new-conversation", "settings", "automations", "extensions", "library", "archives"].every((n) => s[n]),
    noFrenchChrome: Object.entries(s).every(([, x]) => x.textHits.every((h) => /Électricité|vérifie|compteur|réponds|projet-électricité/.test(h.text)) && x.attributeHits.every((h) => /Électricité|vérifie|projet-électricité/.test(h.value))),
    modifierHintsSayCmd: allHints.some((h) => /\bCmd\+/.test(h.value)) && allHints.every((h) => !/\bCtrl\b/.test(h.value) || /^Shortcuts: Ctrl\+C interrupt/.test(h.value)),
    cmdShortcutsWork: Boolean(c.shortcuts?.cmdK && c.shortcuts.cmdN && c.shortcuts.cmdComma && c.shortcuts.cmdCommaCloses && c.shortcuts.cmdB && c.shortcuts.cmdBRestores && c.shortcuts.escapeClosesSearch),
    conversationSwitchMatchesItsHint: /Cmd\+Tab/.test(c.conversationSwitch?.hint ?? "") ? c.conversationSwitch.afterCmdTab === "switched" : c.conversationSwitch?.afterCtrlTab === "conversation 2 (switched)",
    zoomKeysWork: Boolean(c.zoom) && c.zoom.afterCmdPlus < c.zoom.width0 && c.zoom.afterTwoCmdMinus > c.zoom.width0 && c.zoom.afterCmd0 === c.zoom.width0,
    searchCaseInsensitiveUnderSystemLocale: Boolean(c.search?.lower.results.length && c.search.upper.results.length),
    displayPathReadable: Boolean(c.displayPath?.shown) && !/^\\\\\?\\/.test(c.displayPath.shown) && [P1, `/private${P1}`].includes(c.displayPath.shown),
    nativeTrafficLights: c.windowChrome?.customCaptionButtons === 0 && c.windowChrome.platformMacosClass === true,
    noConsoleErrorBesidesResizeObserver: (record.consoleErrors ?? []).every((e) => /^ResizeObserver loop/.test(e)),
    cleanStop: record.stop?.leftAfterQuit?.length === 0 && record.stop.defaultStoresUnchangedAtEnd === true,
  };
  record.defects = [];
  if (/Cmd\+Tab/.test(c.conversationSwitch?.hint ?? "") && c.conversationSwitch.afterCmdTab !== "switched") {
    record.defects.push({
      surface: "Sidebar hint 'Cmd+Tab to switch conversations' (SessionSidebar.tsx, primaryModifier())",
      observed: `Cmd+Tab: ${c.conversationSwitch.afterCmdTab}; Ctrl+Tab: ${c.conversationSwitch.afterCtrlTab}`,
      cause: "App.tsx's switch handler tests e.ctrlKey only; on macOS the hint names Cmd, and Cmd+Tab is the system app switcher, which no app receives. The hint should say Ctrl+Tab (Control) on macOS, or the shortcut should change.",
      macosSpecific: true,
    });
  }
  const zoomDenied = (record.consoleErrors ?? []).filter((e) => /set_webview_zoom not allowed/.test(e)).length;
  if (zoomDenied > 0 || (c.zoom && c.zoom.afterCmdPlus === c.zoom.width0)) {
    record.defects.push({
      surface: "Zoom keys announced by the brand hint ('Cmd+Plus enlarge, Cmd+Minus shrink, Cmd+0 reset zoom'), zoomHotkeysEnabled in tauri.macos.conf.json",
      observed: `innerWidth ${c.zoom?.width0} -> ${c.zoom?.afterCmdPlus} after Cmd+Plus, ${c.zoom?.afterTwoCmdMinus} after two Cmd+Minus; ${zoomDenied} console errors 'webview.set_webview_zoom not allowed. Permissions associated with this command: core:webview:allow-set-webview-zoom'`,
      cause: "On macOS, Tauri implements zoomHotkeysEnabled with a page-side key handler that invokes set_webview_zoom; src-tauri/capabilities/default.json grants core:default, which does not include core:webview:allow-set-webview-zoom, so every zoom key is refused. WebView2 zooms natively on Windows, which is why the 20/09 dogfood passed there.",
      macosSpecific: true,
    });
  }
  record.limits = [
    "No model turn: the conversation surfaces are the fixture's (approval card, tool lane, reply), the real engine's own texts are covered by the other macOS proofs (M0-05, M0-08).",
    "Key events are delivered to the WKWebView by the bridge without activating the app: menu shortcuts and OS shortcuts (Cmd+Tab app switcher, Cmd+Q) are not exercised; in particular the OS takes Cmd+Tab before any app sees it.",
    "Search is case-insensitive under the webview language (en-GB, system locale en_FR) and not accent-insensitive ('electricite' finds nothing): not a criterion of the ticket, recorded only.",
    "Light/dark captures at the target desktop sizes are not committed (the header shows the temp folder path); the theme surfaces are M0-12's.",
  ];
  const final = redact(record);
  mkdirSync(join(OUT, ".."), { recursive: true });
  writeFileSync(OUT, `${JSON.stringify(final, null, 2)}\n`);
  console.log(JSON.stringify({ verdicts: final.verdicts, failure: final.failure }, null, 2));
}

await main();
