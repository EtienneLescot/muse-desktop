#!/usr/bin/env node

/**
 * Force the UI into a conversation, then expand the work panel, capturing only
 * states that are verified. Every step retries and re-reads, because in this app
 * a single click frequently does nothing — the campaign's own evidence shows the
 * Library view persisting through clicks that "should" have opened a thread.
 *
 * Usage: node scripts/ux-force-conversation.mjs --out <dir> --port 9227
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const OUT = (() => { const i = process.argv.indexOf("--out"); return i >= 0 ? process.argv[i + 1] : "docs/evidence/2026-09-21-ux/pass1"; })();
const PORT = (() => { const i = process.argv.indexOf("--port"); return i >= 0 ? Number(process.argv[i + 1]) : 9227; })();
const sleep = (ms) => new Promise((d) => setTimeout(d, ms));

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === "page" && !String(t.url).startsWith("chrome-error"));
if (!page) { console.error("pas de page applicative"); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let id = 1; const pending = new Map();
ws.addEventListener("message", (e) => {
  const f = JSON.parse(typeof e.data === "string" ? e.data : "");
  if (f.id === undefined) return;
  const p = pending.get(f.id); if (p) { pending.delete(f.id); p(f); }
});
const cmd = (m, p) => new Promise((res) => { const i = id++; pending.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
const ev = async (expr) => {
  const r = await cmd("Runtime.evaluate", { expression: `(() => { try { return JSON.stringify(${expr}); } catch (e) { return JSON.stringify({ __e: String(e.message) }); } })()`, returnByValue: true });
  const v = r.result?.result?.value;
  return v === undefined ? null : JSON.parse(v);
};

mkdirSync(OUT, { recursive: true });
const manifest = { schema: "muse-desktop.ux-force-conversation.v1", shots: [] };
let n = 200;
const shot = async (name, note) => {
  n += 1;
  const file = `${n}-${name}.png`;
  const captured = await cmd("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  const base64 = captured?.result?.data;
  if (typeof base64 !== "string" || base64.length === 0) {
    console.log(`  ${file}  CAPTURE VIDE — ignoree`);
    return;
  }
  writeFileSync(join(OUT, file), Buffer.from(base64, "base64"));
  const state = await ev(`(() => {
    const visible = (n) => {
    if (!n || !n.isConnected) return false;
    const c = getComputedStyle(n);
    if (c.display === "none" || c.visibility === "hidden") return false;
    if (c.display !== "contents" && n.getClientRects().length === 0) return false;
    return true;
  };
    const tabs = [...document.querySelectorAll("button, [role=tab]")].filter(visible)
      .map((b) => (b.innerText || "").trim())
      .filter((t) => /^(Content|Review|Terminal|Files|Browser|Desktop|Memory)$/.test(t));
    return {
      titre: document.querySelector("h1") ? document.querySelector("h1").innerText.trim().slice(0, 40) : null,
      onglets: tabs,
      composer: [...document.querySelectorAll("textarea")].some(visible),
      messages: document.querySelectorAll("[class*=message],[class*=msg-]").length,
    };
  })()`);
  manifest.shots.push({ file, note, state });
  console.log(`  ${file}  ${JSON.stringify(state)}`);
};

const CONTEXT = `(() => {
  const visible = (n) => {
    if (!n || !n.isConnected) return false;
    const c = getComputedStyle(n);
    if (c.display === "none" || c.visibility === "hidden") return false;
    if (c.display !== "contents" && n.getClientRects().length === 0) return false;
    return true;
  };
  return {
    titre: document.querySelector("h1") ? document.querySelector("h1").innerText.trim().slice(0, 40) : null,
    pickers: [...document.querySelectorAll(".session-select")].filter(visible).length,
    moreButtons: [...document.querySelectorAll("button[aria-label^='Actions for']")].filter(visible).length,
    showPanel: [...document.querySelectorAll("button")].filter(visible).some((b) => (b.getAttribute("aria-label") || "") === "Show work panel"),
    views: [...document.querySelectorAll("button")].filter(visible).map((b) => (b.innerText || "").trim()).filter((t) => /^(Search|Automations|Extensions|Library)$/.test(t)),
  };
})()`;

try {
  await cmd("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
} catch { /* optional */ }

// Step 1: leave the sidebar views (they are not the workspace) and open a thread.
for (let attempt = 1; attempt <= 6; attempt += 1) {
  const before = await ev(CONTEXT);
  console.log(`essai ${attempt} : ${JSON.stringify(before)}`);
  if (before.showPanel) break;
  // Leave any library/search/extensions/automations view first.
  await ev(`(() => {
    const visible = (n) => {
    if (!n || !n.isConnected) return false;
    const c = getComputedStyle(n);
    if (c.display === "none" || c.visibility === "hidden") return false;
    if (c.display !== "contents" && n.getClientRects().length === 0) return false;
    return true;
  };
    const b = [...document.querySelectorAll("button")].filter(visible)
      .find((x) => (x.innerText || "").trim() === "New conversation");
    if (b) b.click();
    return true;
  })()`);
  await sleep(2_200);
  // Then open the most recent thread from the sidebar.
  const clicked = await ev(`(() => {
    const visible = (n) => {
    if (!n || !n.isConnected) return false;
    const c = getComputedStyle(n);
    if (c.display === "none" || c.visibility === "hidden") return false;
    if (c.display !== "contents" && n.getClientRects().length === 0) return false;
    return true;
  };
    const picker = [...document.querySelectorAll(".session-select")].filter(visible)[0];
    if (!picker) return { clicked: false, reason: "aucun .session-select visible" };
    picker.click();
    return { clicked: true, label: (picker.innerText || "").trim().slice(0, 40) };
  })()`);
  console.log(`         clic : ${JSON.stringify(clicked)}`);
  await sleep(3_000);
}
const afterOpen = await ev(CONTEXT);
console.log(`contexte final : ${JSON.stringify(afterOpen)}`);
await shot("conversation-forcee", `tentative d'ouverture — showPanel=${afterOpen.showPanel}`);

// Step 2: expand the work panel, retrying, and capture each tab once it exists.
if (afterOpen.showPanel) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await ev(`(() => {
      const b = [...document.querySelectorAll("button")].find((x) => (x.getAttribute("aria-label") || "") === "Show work panel");
      if (b) b.click();
      return true;
    })()`);
    await sleep(2_500);
    const state = await ev(`(() => {
      const visible = (n) => {
    if (!n || !n.isConnected) return false;
    const c = getComputedStyle(n);
    if (c.display === "none" || c.visibility === "hidden") return false;
    if (c.display !== "contents" && n.getClientRects().length === 0) return false;
    return true;
  };
      return {
        hidePanel: [...document.querySelectorAll("button")].filter(visible).some((b) => (b.getAttribute("aria-label") || "") === "Hide work panel"),
        tabs: [...document.querySelectorAll("button, [role=tab]")].filter(visible).map((b) => (b.innerText || "").trim())
          .filter((t) => /^(Content|Review|Terminal|Files|Browser|Desktop|Memory)$/.test(t)),
      };
    })()`);
    console.log(`panneau essai ${attempt} : ${JSON.stringify(state)}`);
    if (state.tabs.length > 0) break;
  }
  await shot("panneau-deplie", "panneau de travail deplie");
  const tabs = (await ev(`(() => {
    const visible = (n) => {
    if (!n || !n.isConnected) return false;
    const c = getComputedStyle(n);
    if (c.display === "none" || c.visibility === "hidden") return false;
    if (c.display !== "contents" && n.getClientRects().length === 0) return false;
    return true;
  };
    return [...document.querySelectorAll("button, [role=tab]")].filter(visible).map((b) => (b.innerText || "").trim())
      .filter((t) => /^(Content|Review|Terminal|Files|Browser|Desktop|Memory)$/.test(t));
  })()`)) ?? [];
  const seen = new Set();
  for (const tab of tabs) {
    if (seen.has(tab)) continue;
    seen.add(tab);
    const ok = await ev(`(() => {
      const visible = (n) => {
    if (!n || !n.isConnected) return false;
    const c = getComputedStyle(n);
    if (c.display === "none" || c.visibility === "hidden") return false;
    if (c.display !== "contents" && n.getClientRects().length === 0) return false;
    return true;
  };
      const b = [...document.querySelectorAll("button, [role=tab]")].filter(visible).find((x) => (x.innerText || "").trim() === ${JSON.stringify(tab)});
      if (!b) return { clicked: false };
      b.click();
      return { clicked: true };
    })()`);
    await sleep(2_200);
    await shot(`onglet-${tab.toLowerCase()}`, `onglet ${tab} — ${ok?.clicked ? "clic OK" : "clic manque"}`);
  }
}

writeFileSync(join(OUT, "manifest-force.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
console.log(`\n${manifest.shots.length} captures dans ${OUT}`);
ws.close();
