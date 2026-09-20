/**
 * Source-level loader for the campaign CLI scripts under `scripts/`.
 *
 * `scripts/msp-probe.mjs` and the four `scripts/cdp-*.mjs` drivers are
 * executables, not modules: they export nothing and they run their CLI entry
 * point at load time (`await main()` at top level). Importing one inside a test
 * process is therefore not an option —
 *
 *   - `msp-probe.mjs` checks for `src-tauri/binaries/muse-*.exe` and, when it is
 *     present, spawns a real `muse serve` host; when it is absent it sets
 *     `process.exitCode = 1`, which would fail the whole `node --test` run even
 *     though every test passed;
 *   - `cdp-drive.mjs` and friends call `fetch("http://127.0.0.1:9222/json/list")`
 *     and `exit(1)` when it fails, which kills the test runner.
 *
 * Until those scripts export their pure helpers, the tests reach them the only
 * way that is left: read the script text, extract one declaration by name, and
 * evaluate exactly that declaration. Nothing else in the file is executed, no
 * child process is spawned and no socket is opened, so this stays hermetic —
 * and it is still the real shipped code, not a copy.
 *
 * Failure is deliberately loud: a missing name, an unbalanced declaration or a
 * declaration that no longer compiles throws, so a rename or a refactor fails
 * the test instead of quietly skipping it.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Read one script from `scripts/` as UTF-8 text. */
export function readScript(script: string): string {
  return readFileSync(resolve(REPO_ROOT, "scripts", script), "utf8");
}

/**
 * Evaluate the named top-level declarations of a script and return them.
 *
 * `bindings` become parameters of the wrapper function, which is how a
 * declaration that depends on an outer binding (`PORT`, `argv`, `fetch`) is
 * tested with a controlled value instead of the ambient one.
 */
export function loadDeclarations<T>(
  script: string,
  names: readonly string[],
  bindings: Record<string, unknown> = {},
): T {
  const source = readScript(script);
  const declarations = names.map((name) => extractDeclaration(source, name));
  const body = `${declarations.join("\n")}\nreturn { ${names.join(", ")} };`;
  try {
    return new Function(...Object.keys(bindings), body)(...Object.values(bindings)) as T;
  } catch (error) {
    throw new Error(`cannot load ${names.join(", ")} from scripts/${script}: ${describe(error)}`);
  }
}

/** Slice one declaration out of a script, starting at its keyword. */
function extractDeclaration(source: string, name: string): string {
  const marker = new RegExp(
    `^(?:export\\s+)?(?:async\\s+)?(?:const|let|var|function)\\s+${escapeRegExp(name)}\\b`,
    "m",
  );
  const match = marker.exec(source);
  if (!match) throw new Error(`declaration ${name} is not defined in this script`);
  const declaration = source.slice(match.index, declarationEnd(source, match.index)).trim();
  if (!declaration) throw new Error(`declaration ${name} is empty`);
  return declaration;
}

/** Index just past the `;` or the top-level block that closes a declaration. */
function declarationEnd(source: string, start: number): number {
  let depth = 0;
  let index = start;
  while (index < source.length) {
    const char = source[index];
    if (char === "/" && source[index + 1] === "/") {
      const newline = source.indexOf("\n", index);
      if (newline < 0) break;
      index = newline + 1;
      continue;
    }
    if (char === "/" && source[index + 1] === "*") {
      const close = source.indexOf("*/", index + 2);
      if (close < 0) break;
      index = close + 2;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      index = literalEnd(source, index);
      continue;
    }
    if (char === "(" || char === "[" || char === "{") {
      depth += 1;
      index += 1;
      continue;
    }
    if (char === ")" || char === "]") {
      depth -= 1;
      index += 1;
      continue;
    }
    if (char === "}") {
      depth -= 1;
      index += 1;
      if (depth <= 0) break;
      continue;
    }
    if (char === ";" && depth === 0) {
      index += 1;
      break;
    }
    index += 1;
  }
  // A brace-bodied function or arrow is followed by an optional `;`.
  const trailing = /^[ \t]*;/.exec(source.slice(index));
  return index + (trailing ? trailing[0].length : 0);
}

/** Index just past the string or template literal that opens at `start`. */
function literalEnd(source: string, start: number): number {
  const quote = source[start];
  let index = start + 1;
  while (index < source.length) {
    const char = source[index];
    if (char === "\\") {
      index += 2;
      continue;
    }
    if (char === quote) return index + 1;
    if (quote !== "`" && char === "\n") return index + 1;
    if (quote === "`" && char === "$" && source[index + 1] === "{") {
      index = interpolationEnd(source, index + 2);
      continue;
    }
    index += 1;
  }
  return source.length;
}

/** Index just past the `}` that closes an interpolation opened before `start`. */
function interpolationEnd(source: string, start: number): number {
  let depth = 0;
  let index = start;
  while (index < source.length) {
    const char = source[index];
    if (char === '"' || char === "'" || char === "`") {
      index = literalEnd(source, index);
      continue;
    }
    if (char === "(" || char === "[" || char === "{") {
      depth += 1;
      index += 1;
      continue;
    }
    if (char === ")" || char === "]") {
      depth -= 1;
      index += 1;
      continue;
    }
    if (char === "}") {
      if (depth === 0) return index + 1;
      depth -= 1;
      index += 1;
      continue;
    }
    index += 1;
  }
  return source.length;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
