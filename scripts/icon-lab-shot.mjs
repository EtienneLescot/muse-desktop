#!/usr/bin/env node
/**
 * Render the fork-icon candidates at their real size and save a PNG.
 *
 * Choosing a glyph by reasoning about path coordinates is how the current icon
 * came to look like the digit 4, so the decision is made on pixels: each
 * candidate is drawn through the exact CSS the app applies to every icon
 * (18x18, stroke 1.65, round caps, no fill) and captured.
 *
 * A temporary tab is opened in the running WebView2, used, and closed again, so
 * the application itself is untouched.
 *
 * Usage: node scripts/icon-lab-shot.mjs --port 9227 [--out <file.png>]
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { exit } from "node:process";

const PORT = (() => { const i = process.argv.indexOf("--port"); return i >= 0 ? Number(process.argv[i + 1]) : 9227; })();
const OUT = (() => { const i = process.argv.indexOf("--out"); return i >= 0 ? process.argv[i + 1] : "docs/evidence/2026-09-21-ux/pass2/fork-icon-candidats.png"; })();
const PAGE = resolve("scripts/icon-lab.html");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const app = list.find((t) => t.type === "page" && String(t.url).startsWith("http"));
if (!app) { console.error(`pas de page applicative sur ${PORT}`); process.exit(1); }

// The browser-level endpoint owns Target.createTarget.
const version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
const ws = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let id = 1; const pending = new Map();
ws.addEventListener("message", (e) => {
  const f = JSON.parse(typeof e.data === "string" ? e.data : "");
  if (f.id === undefined) return;
  const p = pending.get(f.id); if (p) { pending.delete(f.id); p(f); }
});
const cmd = (m, p) => new Promise((res) => { const i = id++; pending.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p })); });

const fileUrl = "file:///" + PAGE.replace(/\\/g, "/");
const created = await cmd("Target.createTarget", { url: fileUrl });
const targetId = created.result?.targetId;
if (!targetId) { console.error("creation d'onglet refusee :", JSON.stringify(created).slice(0, 200)); ws.close(); process.exit(1); }
await sleep(1200);

// Attach to the new target so the screenshot comes from that page, not the app.
const attached = await cmd("Target.attachToTarget", { targetId, flatten: true });
const sessionId = attached.result?.sessionId;
if (!sessionId) { console.error("attachement refuse"); await cmd("Target.closeTarget", { targetId }); ws.close(); process.exit(1); }

const send = (method, params) => new Promise((res) => {
  const i = id++;
  pending.set(i, res);
  ws.send(JSON.stringify({ id: i, sessionId, method, params }));
});
await send("Page.enable", {});
await sleep(400);
const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
await cmd("Target.closeTarget", { targetId });

const data = shot.result?.data;
if (!data) { console.error("capture vide"); ws.close(); process.exit(1); }
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, Buffer.from(data, "base64"));
console.log(`capture : ${OUT} (${Buffer.from(data, "base64").length} octets)`);
console.log("onglet temporaire ferme ; application intacte");
ws.close();
