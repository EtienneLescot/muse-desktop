#!/usr/bin/env node
/**
 * Confirm the running app now spawns its host with `--trust-workspace`.
 *
 * The Rust test covers the argument list, but the host is spawned from
 * `ensure_host` and a wiring mistake there would leave the flag unused while the
 * unit test still passed. This reads the live host's own command line.
 *
 * Usage: node scripts/ux-host-trust-flag.mjs
 */
import { execFileSync } from "node:child_process";

const script = `
Get-CimInstance Win32_Process -Filter "Name = 'muse.exe'" |
  Select-Object -ExpandProperty CommandLine
`;
let lines = [];
try {
  lines = execFileSync("powershell", ["-NoProfile", "-Command", script], { encoding: "utf8" })
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
} catch (error) {
  console.log(`  lecture impossible : ${String(error).slice(0, 120)}`);
}

if (lines.length === 0) {
  console.log("  aucun processus muse.exe en cours : l'application est-elle lancee ?");
  process.exit(0);
}

console.log(`  ${lines.length} processus muse.exe`);
let trusted = 0;
for (const line of lines) {
  const has = line.includes("--trust-workspace");
  if (has) trusted += 1;
  const serve = line.includes("serve") ? "serve" : "(pas serve)";
  console.log(`  ${serve.padEnd(11)} --trust-workspace : ${has ? "OUI" : "NON"}`);
}
console.log(`\n  ${trusted}/${lines.length} host(s) lancent avec les regles du dossier chargees`);
