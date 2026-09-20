#!/usr/bin/env node

/**
 * Audit the rendered interface for leftover French copy (M0-11).
 *
 * The source-level test only greps a blacklist in five files. French UI text can
 * appear without accents, so this walks the live DOM instead and reports any
 * visible string whose words are French function words or known French UI verbs.
 *
 * Requires the CDP-enabled dev build. Usage:
 *   node scripts/cdp-language-audit.mjs
 */
import { exit } from "node:process";

const PORT = Number(process.env.MUSE_CDP_PORT ?? 9222);
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
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method}: timed out`)); }, 60_000);
        pending.set(id, { resolve, reject, method, timer });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    close() { try { socket.close(); } catch { /* closed */ } }
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

/**
 * Collect visible strings and flag French ones. Unaccented French UI copy is the
 * target, so the markers are function words and interface verbs that do not
 * occur in English product text.
 */
const AUDIT = `(() => {
  const markers = [
    "Ajouter","Supprimer","Enregistrer","Fermer","Ouvrir","Rechercher","Choisir",
    "Afficher","Masquer","Annuler","Valider","Aucun","Aucune","Créer","Modifier",
    "Exécuter","Arrêter","Reprendre","Espace de travail","Réglages","Paramètres",
    "Conversations","Automatisations","Exten","Bibliothèque","Tâche","Fichier",
    "Envoyer","Réessayer","Reconnecter","Compacter","Dossier","Projet","Nouvelle"
  ];
  const functionWords = /\\b(le|la|les|des|une|pour|avec|dans|sur|est|sont|votre|vous|nous|qui|que|ne|pas|plus|tout|tous|toute|aucun|aucune|être|avoir|fait|faire)\\b/i;
  const seen = new Map();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const raw = (walker.currentNode.textContent || "").trim();
    if (raw.length < 2 || raw.length > 90) continue;
    const el = walker.currentNode.parentElement;
    if (!el) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.display === "none") continue;
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) continue;
    const markerHit = markers.find((m) => raw.includes(m));
    const wordHit = functionWords.test(raw);
    if (!markerHit && !wordHit) continue;
    if (!seen.has(raw)) seen.set(raw, { text: raw, marker: markerHit || null, functionWord: wordHit, tag: el.tagName });
  }
  return {
    candidates: [...seen.values()].slice(0, 25),
    candidateCount: seen.size,
    bodySample: (document.body.innerText || "").replace(/\\s+/g, " ").slice(0, 400)
  };
})()`;

const click = (client, label) => evaluate(client, `(() => {
  const nodes = [...document.querySelectorAll('button, a, [role="button"], [role="tab"]')].filter((n) => n.offsetParent !== null);
  const hit = nodes.find((n) => (n.innerText || "").trim().toLowerCase() === ${JSON.stringify(label.toLowerCase())})
    || nodes.find((n) => (n.innerText || "").trim().toLowerCase().includes(${JSON.stringify(label.toLowerCase())}));
  if (!hit) return { clicked: false, label: ${JSON.stringify(label)} };
  hit.click();
  return { clicked: true, label: (hit.innerText || "").trim().slice(0, 30) };
})()`);

async function main() {
  const target = await pageTarget();
  const client = connect(target.webSocketDebuggerUrl);
  await client.ready;
  const report = { schema: "muse-desktop.cdp-language-audit.v1", surfaces: [] };
  const record = async (name) => {
    const audit = await evaluate(client, AUDIT);
    report.surfaces.push({ name, candidateCount: audit.candidateCount, candidates: audit.candidates, sample: audit.bodySample });
  };
  try {
    await record("home");
    for (const [label, name] of [["New conversation", "new-conversation"], ["Automations", "automations"], ["Extensions", "extensions"], ["Library", "library"], ["Search", "search"]]) {
      const clicked = await click(client, label);
      await sleep(2_000);
      await record(clicked.clicked ? name : `${name}-NOT-CLICKED`);
    }
    // Back to a conversation, where the transcript and composer live.
    report.back = await evaluate(client, `(() => {
      const nodes = [...document.querySelectorAll('button, a, [role="button"]')].filter((n) => n.offsetParent !== null);
      const hit = nodes.find((n) => /Enumerate the three Musketeers/i.test(n.innerText || ""));
      if (!hit) return { opened: false };
      hit.click();
      return { opened: true };
    })()`);
    await sleep(3_000);
    await record("conversation");
  } catch (error) {
    report.failure = String((error && error.message) || error).slice(0, 300);
  } finally {
    client.close();
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

await main().catch((error) => { process.stderr.write(`${(error && error.message) || error}\n`); exit(1); });
