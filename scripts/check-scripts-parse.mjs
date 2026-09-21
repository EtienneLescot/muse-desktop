#!/usr/bin/env node
/**
 * Guard: every page-driving script in `scripts/` must at least parse, and must
 * not repeat the template-literal trap that `node --check` cannot see.
 *
 * Ten separate debugging detours in this campaign came from the same mistake: a
 * backtick written inside a comment that lives INSIDE an outer template
 * literal. It terminates the string early and surfaces as "SyntaxError: missing
 * ) after argument list" reported far from the real line.
 *
 * `node --check` is the right detector for the syntax-error form of that bug, and
 * it is what this script runs first. But it is blind to the *balanced* form: two
 * backticks inside the page-side literal (around a selector, say) parse cleanly
 * and then fail at runtime as "VIS.msg is not a function" - a detour that cost
 * another round. So the second check is a small scanner that reports a backtick
 * found in a comment-looking line while a template literal is open.
 *
 * The scanner is a heuristic, not a lexer: it does not model regex literals, so
 * a regex containing a quote or a backtick can shift its state. It only ever
 * reports "a backtick inside something that looks like a comment inside a
 * template", which is worth a look even in the rare false positive.
 *
 * Usage: node scripts/check-scripts-parse.mjs
 * Exit code 0 = all parse and none hits the trap, 1 otherwise.
 */
import { execFileSync } from "node:child_process";
import { globSync, readFileSync } from "node:fs";
import { exit } from "node:process";

/** Lines that look like comments in the source text. */
function commentLookingLines(source) {
  return source.split("\n").map((line) => /^\s*(\/\/|\/\*|\*)/.test(line));
}

/**
 * Report the 1-based line of every backtick found while a template literal is
 * open and the line looks like a comment. Pure text scanning, no evaluation.
 */
export function backticksInCommentedTemplates(source) {
  const commentLine = commentLookingLines(source);
  const hits = [];
  // Each frame is "code" (including a ${ } substitution), "template",
  // "line-comment", "block-comment" or "string".
  const stack = [{ kind: "code" }];
  let line = 0;
  let i = 0;
  const top = () => stack[stack.length - 1];
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === "\n") {
      if (top().kind === "line-comment") stack.pop();
      line += 1;
      i += 1;
      continue;
    }
    const frame = top();
    if (frame.kind === "line-comment") {
      i += 1;
      continue;
    }
    if (frame.kind === "block-comment") {
      if (ch === "*" && next === "/") {
        stack.pop();
        i += 2;
      } else {
        i += 1;
      }
      continue;
    }
    if (frame.kind === "string") {
      if (ch === "\\") {
        i += 2;
      } else {
        if (ch === frame.quote) stack.pop();
        i += 1;
      }
      continue;
    }
    if (frame.kind === "template") {
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === "`") {
        if (commentLine[line]) {
          // This is the bug, not a closing delimiter: keep the template open so
          // the rest of the file is read the way its author intended, and report
          // the line once.
          hits.push(line + 1);
          i += 1;
          continue;
        }
        stack.pop();
        i += 1;
        continue;
      }
      if (ch === "$" && next === "{") {
        stack.push({ kind: "code", substitution: true });
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    // Code.
    if (ch === "/" && next === "/") {
      stack.push({ kind: "line-comment" });
      i += 2;
      continue;
    }
    if (ch === "/" && next === "*") {
      stack.push({ kind: "block-comment" });
      i += 2;
      continue;
    }
    if (ch === "`") {
      if (commentLine[line]) hits.push(line + 1);
      stack.push({ kind: "template" });
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      stack.push({ kind: "string", quote: ch });
      i += 1;
      continue;
    }
    if (ch === "}" && frame.substitution) {
      stack.pop();
      i += 1;
      continue;
    }
    i += 1;
  }
  return [...new Set(hits)].sort((a, b) => a - b);
}

/**
 * The scanner is only worth trusting if it can fail, so it is exercised on two
 * snippets before the directory is scanned: the trap it must catch, and the
 * legitimate shape it must leave alone (a backtick in a real comment, outside
 * any template).
 */
function scannerSelfTest() {
  const trapped = "const PAGE = `(() => {\n  // uses `.msg` here\n  return 1; })()`;\n";
  const clean = "// uses `.msg` here\nconst PAGE = `(() => 1)()`;\n";
  const caught = backticksInCommentedTemplates(trapped);
  const spared = backticksInCommentedTemplates(clean);
  const ok = caught.length === 1 && caught[0] === 2 && spared.length === 0;
  if (!ok) {
    console.log(
      `  KO  auto-test du scanner : piege detecte sur les lignes [${caught.join(", ")}] (attendu [2]), ` +
        `commentaire hors gabarit signale sur [${spared.join(", ")}] (attendu aucun)`,
    );
  }
  return ok;
}

if (!scannerSelfTest()) {
  console.log("\nle scanner de gabarits ne fonctionne pas : aucun resultat n'est fiable");
  exit(1);
}

const files = globSync("scripts/*.mjs").sort();
const broken = [];
const trapped = [];
for (const file of files) {
  const source = readFileSync(file, "utf8");
  try {
    execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
  } catch (error) {
    const stderr = String(error.stderr ?? error.message);
    // Keep the first meaningful line: node prints the file, then the message.
    const detail = stderr.split("\n").map((l) => l.trim()).filter((l) => l.length > 0).slice(0, 3).join(" | ");
    broken.push({ file, detail: detail.slice(0, 200) });
  }
  // A script that does not parse cannot be scanned meaningfully.
  if (broken.some((b) => b.file === file)) continue;
  const hits = backticksInCommentedTemplates(source);
  if (hits.length > 0) trapped.push({ file, hits });
}

let failed = false;
for (const b of broken) {
  console.log(`  KO  ${b.file}\n      ${b.detail}`);
  failed = true;
}
for (const t of trapped) {
  console.log(
    `  KO  ${t.file}\n      backtick in a comment-looking line at ${t.hits.join(", ")} while a template literal is open — ` +
      `use quotes instead, it will terminate the page-side string`,
  );
  failed = true;
}

if (!failed) {
  console.log(`${files.length} scripts analyses, tous valides`);
  exit(0);
}
console.log(`\n${broken.length + trapped.length} probleme(s) sur ${files.length} fichiers`);
exit(1);
