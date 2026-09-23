#!/usr/bin/env node
/**
 * Verify computer use end to end, through the app's own bridge.
 *
 * Claims under test, in the order that matters:
 *   1. the driver is found and probed by Rust, not by the renderer;
 *   2. the grant levels map onto the driver's real tool surface;
 *   3. enabling really starts a service with our manifest, and the manifest is
 *      enforced by the driver — an ungranted tool must be refused;
 *   4. the MCP entry handed to the Muse host is the one this app built, aimed at
 *      this app's own endpoint, and it disappears when the grant lapses;
 *   5. disabling revokes and stops.
 *
 * The script leaves the app as it found it: if computer use was off, it turns it
 * off again at the end.
 *
 * Usage: node scripts/ux-computer-use.mjs [--port 9227] [--level observe]
 */
const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const PORT = Number(arg("--port", "9227"));
const LEVEL = arg("--level", "observe");
const sleep = (ms) => new Promise((d) => setTimeout(d, ms));

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === "page" && !String(t.url).startsWith("chrome-error"));
if (!page) {
  console.error("pas de page");
  process.exit(1);
}
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let id = 1;
const pending = new Map();
ws.addEventListener("message", (e) => {
  const f = JSON.parse(typeof e.data === "string" ? e.data : "");
  if (f.id === undefined) return;
  const p = pending.get(f.id);
  if (p) {
    pending.delete(f.id);
    p(f);
  }
});
const cmd = (m, p) =>
  new Promise((res) => {
    const i = id++;
    pending.set(i, res);
    ws.send(JSON.stringify({ id: i, method: m, params: p }));
  });
async function ev(expression) {
  const r = await cmd("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || "exception");
  return r.result?.result?.value;
}
const invoke = (method, args = {}) =>
  ev(`(async () => {
    try { return await window.__TAURI_INTERNALS__.invoke(${JSON.stringify(method)}, ${JSON.stringify(args)}); }
    catch (e) { return { __error: String(e).slice(0, 300) }; } })()`);

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail === undefined ? "" : ` — ${detail}`}`);
  if (!ok) failures += 1;
};

const before = await invoke("computer_status");
if (before.__error) {
  console.error(`computer_status a renvoye une erreur : ${before.__error}`);
  process.exit(1);
}
console.log("\netat initial");
console.log("  " + JSON.stringify({
  driverVersion: before.driverVersion,
  available: before.available,
  levels: before.levelCounts,
  grantState: before.grantState,
  unclassified: before.unclassified,
}));

console.log("\nverifications");
check("le driver est trouve", before.available === true, String(before.driverPath));
check("la version est lue", typeof before.driverVersion === "string", String(before.driverVersion));
check(
  "agir couvre plus qu observer",
  before.levelCounts.observe > 0 &&
    before.levelCounts.observe < before.levelCounts.act,
  JSON.stringify(before.levelCounts),
);
check(
  "aucun outil du driver n'est non classe",
  Array.isArray(before.unclassified) && before.unclassified.length === 0,
  JSON.stringify(before.unclassified),
);
check(
  "les sondes du driver sont rendues",
  Array.isArray(before.doctor?.probes) && before.doctor.probes.length > 0,
  `${before.doctor?.probes?.length ?? 0} sondes`,
);

// Enable.
console.log(`\nactivation au niveau ${LEVEL}`);
const enabled = await invoke("computer_enable", { level: LEVEL });
if (enabled.__error) {
  console.error(`computer_enable a echoue : ${enabled.__error}`);
  process.exit(1);
}
console.log("  " + JSON.stringify({
  grantState: enabled.grantState,
  tools: enabled.manifest?.allow?.tools?.length,
  digest: enabled.manifestDigest,
}));
check("le grant est actif", enabled.grantState === "active");
check(
  "le manifeste est borne et porte le niveau demande",
  enabled.manifest?.mode === "bounded" &&
    enabled.manifest?.allow?.tools?.length === before.levelCounts[LEVEL],
  `${enabled.manifest?.allow?.tools?.length} outils`,
);
check("une empreinte est publiee", typeof enabled.manifestDigest === "string");

// The entry the host would receive.
const entry = await invoke("computer_mcp_server", { grantState: enabled.grantState });
check(
  "l'entree MCP vise notre propre canal",
  entry?.transport === "stdio" &&
    Array.isArray(entry.args) &&
    entry.args.includes("--socket") &&
    String(entry.args[entry.args.length - 1]).includes("muse-desktop-computer"),
  JSON.stringify(entry),
);
const noEntry = await invoke("computer_mcp_server", { grantState: "expired" });
check("un grant expire ne donne aucune entree", noEntry === null || noEntry === undefined);

// The grant the renderer would actually hand to a conversation.
console.log("\netat apres activation");
const after = await invoke("computer_status");
console.log("  " + JSON.stringify({ grantState: after.grantState, digest: after.manifestDigest }));

// Enforcement, measured through this app's own service: an allowed tool answers,
// a tool outside the manifest is refused by the driver itself. This is the claim
// the whole feature rests on, so it is checked rather than asserted in prose.
if (after.grantState === "active" && before.driverPath) {
  const { spawnSync } = await import("node:child_process");
  const call = (tool) =>
    spawnSync(before.driverPath, ["call", tool, "{}", "--socket", "\\\\.\\pipe\\muse-desktop-computer"], {
      encoding: "utf8",
      timeout: 30_000,
    });
  const allowed = call("get_screen_size");
  const refused = call("click");
  const refusedText = `${refused.stdout ?? ""}${refused.stderr ?? ""}`;
  console.log("\napplication du manifeste par le driver");
  console.log(`  get_screen_size : ${(allowed.stdout ?? "").replace(/\s+/g, " ").trim().slice(0, 80)}`);
  console.log(`  click           : ${refusedText.replace(/\s+/g, " ").trim().slice(0, 120)}`);
  check(
    "un outil accorde repond",
    allowed.status === 0 && /width|height/.test(allowed.stdout ?? ""),
  );
  check(
    "un outil hors manifeste est refuse par le driver",
    refused.status !== 0 && /outside the capability manifest/.test(refusedText),
  );
}

// Disable, and confirm the manifest file is gone with it.
const disabled = await invoke("computer_disable");
check("la revocation ramene l'etat a l'arret", disabled.grantState === "stopped");
check("le manifeste est retire", !disabled.manifestDigest);
const restored = await invoke("computer_status");
check(
  "l'etat final est celui du depart",
  restored.grantState === before.grantState,
  `${before.grantState} -> ${restored.grantState}`,
);

ws.close();
console.log(failures === 0 ? "\nPASS" : `\n${failures} verification(s) en echec`);
process.exit(failures === 0 ? 0 : 1);
