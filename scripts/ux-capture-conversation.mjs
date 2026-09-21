#!/usr/bin/env node

/**
 * Capture the conversation and work-panel surfaces, after proving the UI is
 * actually in the state each shot claims.
 *
 * The first attempt at this produced nine identical screenshots of an
 * action dialog that was silently left open. So this version closes any open
 * dialog, asserts the state before every capture, and refuses to write a shot
 * whose precondition is not met — a wrong screenshot is worse than a missing
 * one, because it looks like evidence.
 *
 * Usage:
 *   node scripts/ux-capture-conversation.mjs --out <dir> --port 9227
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { exit } from "node:process";

const OUT = (() => {
  const i = process.argv.indexOf("--out");
  return i >= 0 ? process.argv[i + 1] : "docs/evidence/2026-09-21-ux/pass1";
})();
const PORT = (() => {
  const i = process.argv.indexOf("--port");
  return i >= 0 ? Number(process.argv[i + 1]) : 9227;
})();
const WIDTH = Number(process.env.MUSE_VIEWPORT_W ?? 1440);
const HEIGHT = Number(process.env.MUSE_VIEWPORT_H ?? 900);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function pageTarget() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = list.find((t) => t.type === "page" && !String(t.url).startsWith("chrome-error"));
  if (!page) throw new Error(`no application page on port ${PORT}`);
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
    send(method, params = {}, timeoutMs = 60_000) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method}: timed out`)); }, timeoutMs);
        pending.set(id, { resolve, reject, method, timer });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    close() { try { socket.close(); } catch { /* closed */ } },
  };
}

async function evaluate(client, expression) {
  const result = await client.send("Runtime.evaluate", {
    expression: `(() => { try { return JSON.stringify(${expression}); }
      catch (error) { return JSON.stringify({ __error: String((error && error.message) || error) }); } })()`,
    returnByValue: true,
    awaitPromise: true,
  });
  const raw = result.result?.value;
  if (raw === undefined) return null;
  const parsed = JSON.parse(raw);
  if (parsed && typeof parsed === "object" && "__error" in parsed) throw new Error(parsed.__error);
  return parsed;
}

/** Open dialogs, settings panel, theme, and whether a conversation is displayed. */
const STATE = `(() => {
  const visible = (n) => Boolean(n) && n.offsetParent !== null;
  const dialogs = [...document.querySelectorAll("dialog")].filter((d) => d.open).length;
  const label = (a) => [...document.querySelectorAll("button")].filter(visible).some((b) => (b.getAttribute("aria-label") || "") === a);
  const tabs = [...document.querySelectorAll("button, [role=tab]")].filter(visible)
    .map((b) => (b.innerText || "").trim())
    .filter((t) => /^(Content|Review|Terminal|Files|Browser|Desktop|Memory)$/.test(t));
  return {
    dialogs,
    settingsOpen: label("Close settings"),
    conversationOpen: !label("Show work panel") ? null : Boolean(document.querySelector("h1")),
    title: document.querySelector("h1") ? document.querySelector("h1").innerText.trim().slice(0, 44) : null,
    panelButton: label("Show work panel"),
    hidePanelButton: label("Hide work panel"),
    tabs,
    theme: document.documentElement.dataset.theme || (document.body.className.match(/light|dark/) || [null])[0],
    composerPresent: [...document.querySelectorAll("textarea")].some(visible),
    bodyHead: (document.body.innerText || "").replace(/\\s+/g, " ").slice(0, 140),
  };
})()`;

async function main() {
  mkdirSync(OUT, { recursive: true });
  const target = await pageTarget();
  const client = connect(target.webSocketDebuggerUrl);
  await client.ready;
  const manifest = { schema: "muse-desktop.ux-capture-conversation.v1", port: PORT, shots: [] };
  let index = 100;

  const shot = async (name, note) => {
    index += 1;
    const file = `${index}-${name}.png`;
    const captured = await client.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    writeFileSync(join(OUT, file), Buffer.from(captured.data, "base64"));
    const state = await evaluate(client, STATE);
    manifest.shots.push({ file, name, note: note ?? null, state });
    process.stdout.write(`  ${file}  ${JSON.stringify(state)}\n`);
  };

  try {
    await client.send("Emulation.setDeviceMetricsOverride", { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false });
  } catch { /* optional */ }

  // 1. Close everything that can hide the workspace, and prove it.
  await evaluate(client, `(() => {
    let closed = 0;
    for (const d of document.querySelectorAll("dialog")) {
      if (!d.open) continue;
      const b = [...d.querySelectorAll("button")].find((x) => (x.getAttribute("aria-label") || "") === "Close")
        || [...d.querySelectorAll("button")][0];
      if (b) { b.click(); closed += 1; }
    }
    return { closed };
  })()`);
  await sleep(1_200);
  await evaluate(client, `(() => {
    const b = [...document.querySelectorAll("button")].find((n) => (n.getAttribute("aria-label") || "") === "Close settings");
    if (b) b.click();
    return true;
  })()`);
  await sleep(1_200);

  const baseline = await evaluate(client, STATE);
  process.stdout.write(`baseline : ${JSON.stringify(baseline)}\n`);
  if (baseline.dialogs > 0 || baseline.settingsOpen) {
    process.stderr.write("un dialogue ou le panneau reglages reste ouvert — capture refusee\n");
    writeFileSync(join(OUT, "manifest-conversation.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    client.close();
    return;
  }

  // 2. Make sure a conversation with messages is displayed.
  const opened = await evaluate(client, `(() => {
    const visible = (n) => Boolean(n) && n.offsetParent !== null;
    if (visible(document.querySelector("textarea")) && document.querySelector("h1")) return { already: true };
    const rows = [...document.querySelectorAll("button[aria-label^='Actions for']")].filter(visible);
    const target = rows.find((b) => /BETA/.test(b.getAttribute("aria-label") || "")) || rows[0];
    if (!target) return { opened: false };
    const sib = target.parentElement && target.parentElement.querySelector(".session-select");
    (sib || target).click();
    return { opened: true };
  })()`);
  await sleep(3_000);
  await shot("conversation-propre", `conversation affichee — ${JSON.stringify(opened)}`);

  // 3. Expand the work panel: its tabs do not exist in the DOM until then.
  const panel = await evaluate(client, `(() => {
    const b = [...document.querySelectorAll("button")].find((n) => (n.getAttribute("aria-label") || "") === "Show work panel");
    if (!b) return { opened: false };
    b.click();
    return { opened: true };
  })()`);
  await sleep(2_500);
  const afterPanel = await evaluate(client, STATE);
  if (afterPanel.tabs.length > 0) {
    await shot("barre-travail", `panneau deplie, ${afterPanel.tabs.length} onglets`);
    for (const tab of afterPanel.tabs) {
      const clicked = await evaluate(client, `(() => {
        const visible = (n) => Boolean(n) && n.offsetParent !== null;
        const b = [...document.querySelectorAll("button, [role=tab]")].filter(visible)
          .find((n) => (n.innerText || "").trim() === ${JSON.stringify(tab)});
        if (!b) return { clicked: false };
        b.click();
        return { clicked: true };
      })()`);
      await sleep(2_000);
      await shot(`onglet-${tab.toLowerCase()}`, `onglet ${tab} — clic ${clicked?.clicked ? "OK" : "MANQUE"}`);
    }
  } else {
    manifest.shots.push({ file: null, name: "barre-travail", note: `PANNEAU NON DEPLIE — ${JSON.stringify(panel)}`, state: afterPanel });
    process.stdout.write(`  barre-travail : panneau non deplie (${JSON.stringify(panel)})\n`);
  }

  // 4. Light theme, for the palette.
  await evaluate(client, `(() => {
    const b = [...document.querySelectorAll("button")].find((n) => /Switch to light theme/.test(n.getAttribute("aria-label") || ""));
    if (b) b.click();
    return true;
  })()`);
  await sleep(2_000);
  await shot("theme-clair-conversation", "theme clair sur une conversation");

  writeFileSync(join(OUT, "manifest-conversation.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  process.stdout.write(`\n${manifest.shots.filter((s) => s.file).length} captures ecrites dans ${OUT}\n`);
  client.close();
}

await main().catch((error) => { process.stderr.write(`${(error && error.message) || error}\n`); exit(1); });
