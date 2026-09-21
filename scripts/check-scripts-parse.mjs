#!/usr/bin/env node
/**
 * Guard: every page-driving script in `scripts/` must at least parse.
 *
 * Nine separate debugging detours in this campaign came from the same mistake:
 * a backtick written inside a comment that lives INSIDE an outer template
 * literal. It terminates the string early and surfaces as "SyntaxError: missing )
 * after argument list" reported at a line far from the real one, so each
 * occurrence cost several minutes of bisecting.
 *
 * `node --check` already parses each file with the real grammar, which is a
 * better detector than any backtick heuristic. This script just runs it over the
 * whole directory so a broken probe is caught before it is run.
 *
 * Usage: node scripts/check-scripts-parse.mjs
 * Exit code 0 = all parse, 1 = at least one file has a syntax error.
 */
import { execFileSync } from "node:child_process";
import { globSync } from "node:fs";
import { exit } from "node:process";

const files = globSync("scripts/*.mjs").sort();
const broken = [];

for (const file of files) {
  try {
    execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
  } catch (error) {
    const stderr = String(error.stderr ?? error.message);
    // Keep the first meaningful line: node prints the file, then the message.
    const detail = stderr.split("\n").map((l) => l.trim()).filter((l) => l.length > 0).slice(0, 3).join(" | ");
    broken.push({ file, detail: detail.slice(0, 200) });
  }
}

if (broken.length === 0) {
  console.log(`${files.length} scripts analyses, tous valides`);
  exit(0);
}
for (const b of broken) console.log(`  KO  ${b.file}\n      ${b.detail}`);
console.log(`\n${broken.length} fichier(s) sur ${files.length} ne compilent pas`);
exit(1);
