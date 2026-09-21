#!/usr/bin/env node
/**
 * Verify the Muse authentication section renders, without starting a sign-in.
 *
 * Opens Settings, reads the section, and reports what the user would see. It
 * deliberately never clicks the sign-in button: that would begin a real
 * device-code login. The click path is covered by unit tests on `signInCommand`
 * and by the fact that the button only exists when `canOfferSignIn` is true.
 *
 * Usage: node scripts/ux-auth-section.mjs --port 9227
 */
import { exit } from "node:process";
const PORT = (() => { const i = process.argv.indexOf("--port"); return i >= 0 ? Number(process.argv[i + 1]) : 9227; })();
const sleep = (ms) => new Promise((d) => setTimeout(d, ms));

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === "page" && !String(t.url).startsWith("chrome-error"));
if (!page) { console.error("pas de page"); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let id = 1; const pending = new Map();
ws.addEventListener("message", (e) => {
  const f = JSON.parse(typeof e.data === "string" ? e.data : "");
  if (f.id === undefined) return;
  const p = pending.get(f.id); if (p) { pending.delete(f.id); p(f); }
});
const cmd = (m, p) => new Promise((res) => { const i = id++; pending.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
async function ev(expression) {
  const r = await cmd("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || "exception");
  return r.result?.result?.value;
}
const VIS = `const vis = (n) => { if (!n || !n.isConnected) return false; const c = getComputedStyle(n);
  if (c.display === "none" || c.visibility === "hidden") return false;
  if (c.display !== "contents" && n.getClientRects().length === 0) return false; return true; };`;

// Open Settings through its own trigger, the way a user would.
await ev(`(() => { ${VIS}
  const b = [...document.querySelectorAll("button")].filter(vis)
    .find((n) => /settings|réglages/i.test((n.getAttribute("aria-label") || "") + " " + (n.textContent || "")));
  if (b) b.click();
  return Boolean(b); })()`);
await sleep(1500);

const rendered = await ev(`(() => { ${VIS} return Boolean(document.querySelector(".settings-panel")); })()`);
if (!rendered) { console.error("  le panneau Reglages ne s'est pas ouvert"); ws.close(); process.exit(1); }
console.log("  panneau Reglages ouvert");

const section = await ev(`(() => { ${VIS}
  const head = [...document.querySelectorAll(".settings-panel h3")].find((h) => /Muse authentication/i.test(h.textContent || ""));
  if (!head) return { found: false };
  const group = head.parentElement;
  const notes = [...group.querySelectorAll(".settings-note")].map((n) => (n.innerText || "").trim());
  const buttons = [...group.querySelectorAll("button")].filter(vis).map((b) => (b.innerText || "").trim());
  const warned = [...group.querySelectorAll(".settings-note-warning")].length;
  return { found: true, notes, buttons, warned };
})()`);

if (!section.found) { console.error("  section 'Muse authentication' ABSENTE"); ws.close(); process.exit(1); }
console.log("  section 'Muse authentication' presente\n");
console.log(`  boutons : ${JSON.stringify(section.buttons)}`);
console.log(`  notes en avertissement : ${section.warned}`);
for (const note of section.notes) console.log(`    - ${note.slice(0, 150)}`);

const hasSignIn = section.buttons.some((b) => /sign in/i.test(b));
console.log(`\n  action de connexion proposee : ${hasSignIn ? "OUI" : "NON"}`);
ws.close();
