#!/usr/bin/env node

/**
 * Capture every distinct surface of the application as a PNG, for a UX review.
 *
 * The point is coverage, not one perfect shot: each UI state gets its own file so
 * a reviewer can look at them side by side and spot what is ugly, inconsistent or
 * broken. Each capture records the viewport size, the page title and a short
 * text digest next to the image, so a finding can be traced back to a state.
 *
 * Works against the **installed** package (which serves its own frontend from
 * `tauri.localhost`) or the dev server, whichever answers on the given port.
 *
 * Usage:
 *   node scripts/ux-capture.mjs --out docs/evidence/2026-09-21-ux/pass1
 *   node scripts/ux-capture.mjs --out <dir> --port 9226
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { exit } from "node:process";

const OUT = (() => {
  const index = process.argv.indexOf("--out");
  return index >= 0 ? process.argv[index + 1] : "docs/evidence/2026-09-21-ux/pass1";
})();
const PORT = (() => {
  const index = process.argv.indexOf("--port");
  return index >= 0 ? Number(process.argv[index + 1]) : Number(process.env.MUSE_CDP_PORT ?? 9226);
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

/** `returnByValue` is mandatory; the value lives at result.result.value. */
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

/** Click the first visible control whose text matches, and report whether it did. */
const clickByText = (patterns) => `(() => {
  const wanted = ${JSON.stringify(patterns)}.map((p) => new RegExp(p, "i"));
  const nodes = [...document.querySelectorAll("button, a, [role='button'], [role='tab']")]
    .filter((n) => n.offsetParent !== null);
  const hit = nodes.find((n) => {
    const text = (n.innerText || n.getAttribute("aria-label") || "").trim();
    return wanted.some((re) => re.test(text));
  });
  if (!hit) return { clicked: false };
  hit.click();
  return { clicked: true, label: (hit.innerText || hit.getAttribute("aria-label") || "").trim().slice(0, 40) };
})()`;

const DIGEST = `(() => {
  const body = (document.body.innerText || "").replace(/\\s+/g, " ").trim();
  const buttons = [...document.querySelectorAll("button")].filter((b) => b.offsetParent !== null)
    .map((b) => (b.innerText || b.getAttribute("aria-label") || "").trim()).filter(Boolean);
  const panels = [...document.querySelectorAll("[class*=panel],[class*=sidebar],[class*=bar]")]
    .filter((n) => n.offsetParent !== null).map((n) => n.className).slice(0, 12);
  return { textLength: body.length, head: body.slice(0, 220), buttons: [...new Set(buttons)].slice(0, 24), panels };
})()`;

async function main() {
  mkdirSync(OUT, { recursive: true });
  const target = await pageTarget();
  const client = connect(target.webSocketDebuggerUrl);
  await client.ready;
  const manifest = { schema: "muse-desktop.ux-capture.v1", port: PORT, viewport: { width: WIDTH, height: HEIGHT }, shots: [] };
  let index = 0;

  const shot = async (name, note) => {
    index += 1;
    const file = `${String(index).padStart(2, "0")}-${name}.png`;
    const captured = await client.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    writeFileSync(join(OUT, file), Buffer.from(captured.data, "base64"));
    const digest = await evaluate(client, DIGEST);
    manifest.shots.push({ file, name, note: note ?? null, ...digest });
    process.stdout.write(`  ${file}  ${(digest?.head ?? "").slice(0, 70)}\n`);
  };

  try {
    // A predictable viewport makes screenshots comparable between passes.
    await client.send("Emulation.setDeviceMetricsOverride", {
      width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false,
    });
  } catch { /* the surface may refuse metrics override; the shot still works */ }

  try {
    await sleep(1_500);
    await shot("accueil", "état d'accueil, aucune conversation sélectionnée");

    // Sidebar surfaces.
    for (const [patterns, name, note] of [
      [["^Search$"], "recherche", "vue recherche"],
      [["^Automations$"], "automatisations", "vue automatisations"],
      [["^Extensions$"], "extensions", "vue extensions"],
      [["^Library$"], "bibliotheque", "vue bibliothèque"],
      [["^M$|profil|profile"], "profil", "menu profil"],
    ]) {
      const result = await evaluate(client, clickByText(patterns));
      await sleep(1_800);
      await shot(name, `${note} — clic ${result?.clicked ? "OK" : "MANQUÉ"} ${result?.label ?? ""}`);
    }

    // Back to a conversation, then the work-bar panels, which need the side panel open.
    const conversation = await evaluate(client, `(() => {
      const rows = [...document.querySelectorAll("button[aria-label^='Actions for']")].filter((b) => b.offsetParent !== null);
      if (!rows.length) return { opened: false };
      rows[0].click();
      return { opened: true, label: rows[0].getAttribute("aria-label") };
    })()`);
    await sleep(2_500);
    await shot("conversation", `conversation ouverte — ${conversation?.label ?? "aucune"}`);

    // The work-bar tabs only exist in the DOM once the side panel is expanded.
    const panel = await evaluate(client, `(() => {
      const b = [...document.querySelectorAll("button")].find((n) => n.offsetParent !== null && (n.getAttribute("aria-label") || "") === "Show work panel");
      if (!b) return { opened: false };
      b.click();
      return { opened: true };
    })()`);
    await sleep(2_000);
    await shot("barre-travail", `barre de travail depliee — ${panel?.opened ? "panneau ouvert" : "BOUTON INTROUVABLE"}`);

    for (const [patterns, name] of [
      [["^Content$"], "panneau-content"],
      [["^Review$"], "panneau-review"],
      [["^Terminal$"], "panneau-terminal"],
      [["^Files$"], "panneau-files"],
      [["^Browser$"], "panneau-browser"],
      [["^Desktop$"], "panneau-desktop"],
      [["^Memory$"], "panneau-memory"],
    ]) {
      const result = await evaluate(client, clickByText(patterns));
      await sleep(2_000);
      await shot(name, `onglet de la barre de travail — clic ${result?.clicked ? "OK" : "MANQUÉ"}`);
    }

    // Settings, which is where the model and effort controls live.
    const settings = await evaluate(client, clickByText(["^Settings$|^Réglages$"]));
    await sleep(2_000);
    if (settings?.clicked) await shot("reglages", "panneau réglages");

    // Light theme changes the whole palette: worth its own capture.
    const theme = await evaluate(client, `(() => {
      const b = [...document.querySelectorAll("button")].find((n) => n.offsetParent !== null && /Switch to light theme/.test(n.getAttribute("aria-label") || ""));
      if (!b) return { switched: false };
      b.click();
      return { switched: true };
    })()`);
    await sleep(2_000);
    await shot("theme-clair", `theme clair — ${theme?.switched ? "bascule OK" : "BOUTON INTROUVABLE"}`);

    writeFileSync(join(OUT, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    process.stdout.write(`\n${index} captures dans ${OUT}\n`);
  } catch (error) {
    process.stderr.write(`capture interrompue : ${(error && error.message) || error}\n`);
    writeFileSync(join(OUT, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  } finally {
    client.close();
  }
}

await main().catch((error) => { process.stderr.write(`${(error && error.message) || error}\n`); exit(1); });
