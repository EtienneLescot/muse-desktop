#!/usr/bin/env node
/**
 * Prove what `--trust-workspace` actually changes.
 *
 * The flag is documented as "load its skills and rules", so it must have an
 * observable effect on project-scoped discovery. A comparison against a folder
 * with NO project skills returns two empty lists — a difference of nothing, which
 * proves nothing. This builds a throwaway workspace that does contain a project
 * skill, then asks the CLI both ways.
 *
 * Usage: node scripts/msp-trust-workspace-effect.mjs
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MUSE = process.env.MUSE_CLI ?? "muse";
const workspace = join(tmpdir(), `muse-trust-probe-${Date.now()}`);

try {
  // A workspace with one project skill and an AGENTS.md, which is what the CLI
  // documents as "project rules".
  mkdirSync(join(workspace, ".agents", "skills", "probe-skill"), { recursive: true });
  writeFileSync(
    join(workspace, ".agents", "skills", "probe-skill", "SKILL.md"),
    "---\nname: probe-skill\ndescription: A skill that exists only to be discovered.\n---\n\nDo nothing.\n",
  );
  writeFileSync(join(workspace, "AGENTS.md"), "# Probe rules\n\n- This file exists to be read as project rules.\n");

  const run = (args) => {
    // On Windows the CLI is a `.cmd` shim, which spawnSync cannot execute
    // directly — it fails with a null status and no output, which read as
    // "indeterminate" rather than as a broken harness.
    const result = spawnSync(MUSE, args, { encoding: "utf8", shell: process.platform === "win32" });
    return { status: result.status, out: (result.stdout ?? "").trim(), err: (result.stderr ?? "").trim() };
  };

  console.log(`  workspace de test : ${workspace}`);
  console.log(`  contenu : .agents/skills/probe-skill/SKILL.md + AGENTS.md\n`);

  const without = run(["skills", "list", "--source", "all", "--workspace", workspace, "--json"]);
  console.log("  --- SANS --trust-workspace ---");
  console.log(`  code ${without.status}`);
  console.log(`  ${without.out.slice(0, 700) || without.err.slice(0, 300)}`);

  const withTrust = run(["skills", "list", "--source", "all", "--workspace", workspace, "--trust-workspace", "--json"]);
  console.log("\n  --- AVEC --trust-workspace ---");
  console.log(`  code ${withTrust.status}`);
  console.log(`  ${withTrust.out.slice(0, 700) || withTrust.err.slice(0, 300)}`);

  const count = (raw) => {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed.skills) ? parsed.skills.length : null;
    } catch {
      return null;
    }
  };
  const a = count(without.out);
  const b = count(withTrust.out);
  console.log(`\n  skills decouvertes : sans=${a} avec=${b}`);
  console.log(
    a === null || b === null
      ? "  VERDICT INDETERMINE : une sortie n'est pas du JSON exploitable"
      : b > a
        ? "  VERDICT : le flag CHANGE la decouverte — les skills de projet ne sont pas lues sans lui"
        : "  VERDICT : aucun effet observable sur la decouverte des skills",
  );
} finally {
  if (existsSync(workspace)) {
    try { rmSync(workspace, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}
