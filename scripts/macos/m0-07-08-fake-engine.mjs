#!/usr/bin/env node
/**
 * A fake engine for the macOS M0-07 and M0-08 proofs, passed to a test
 * instance as its sidecar argv (scripts/macos/test-instance.mjs):
 *
 *   engine: ["node", "<this file>", "<control file>", "<real engine>"]
 *
 * The app appends its own `serve ...` flags after that argv. On every spawn the
 * fake reads the control file (one word, the mode) and appends one JSON line
 * to `<control file>.log` (mode, the app's flags, pid), so a proof can switch
 * the behaviour between two Reconnects of one running app:
 *
 *   proxy          runs the real engine with the app's flags, stdio passed
 *                  through (recovery: the app must reach "Connected")
 *   schema2        a well-formed initialize answer with schema.version 2
 *   nofingerprint  schema.version 1 and no schema.fingerprint
 *   badfingerprint schema.fingerprint "md5:…"
 *   wrongname      serverInfo.name "other"
 *   noserverinfo   no serverInfo at all
 *   exit           one stderr line, exit 3 before reading anything
 *   silent         reads stdin, never answers
 *   garbage        one non-JSON stdout line, then exit 3 after the first request
 *   flood          M0-07: writes <control file>.stderr to stderr and
 *                  <control file>.stdout to stdout, reads the first request,
 *                  exits 3
 *
 * Incompatible answers keep the process alive until stdin closes (the app
 * decides, not the fake).
 */
import { spawn } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";

const [control, realEngine, ...appArgs] = process.argv.slice(2);
const mode = (() => { try { return readFileSync(control, "utf8").trim(); } catch { return "exit"; } })();
try { appendFileSync(`${control}.log`, `${JSON.stringify({ at: new Date().toISOString(), pid: process.pid, mode, appArgs })}\n`); } catch { /* best effort */ }

const FINGERPRINT = "sha256:61afea3112e0906e9dc3a536144278a74cb4b36fc6e20901a91d4432ba3568e2";
const answers = {
  schema2: { serverInfo: { name: "muse", version: "9.9.9-fake" }, schema: { version: 2, fingerprint: FINGERPRINT } },
  nofingerprint: { serverInfo: { name: "muse", version: "1.4.2-fake" }, schema: { version: 1 } },
  badfingerprint: { serverInfo: { name: "muse", version: "1.4.2-fake" }, schema: { version: 1, fingerprint: "md5:0123456789abcdef" } },
  wrongname: { serverInfo: { name: "other", version: "1.4.2" }, schema: { version: 1, fingerprint: FINGERPRINT } },
  noserverinfo: { schema: { version: 1, fingerprint: FINGERPRINT } },
};

if (mode === "proxy") {
  const child = spawn(realEngine, appArgs, { stdio: "inherit", env: { ...process.env, MUSE_NO_AUTO_UPDATE: "1" } });
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, () => { try { child.kill(signal); } catch { /* gone */ } });
  child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
} else if (mode === "exit") {
  process.stderr.write("m0-08 fake engine: exiting before the handshake\n");
  process.exit(3);
} else if (mode === "flood") {
  const read = (suffix) => { try { return readFileSync(`${control}.${suffix}`); } catch { return Buffer.alloc(0); } };
  process.stderr.write(read("stderr"), () => {
    setTimeout(() => {
      process.stdout.write(read("stdout"), () => {
        const rl = createInterface({ input: process.stdin });
        rl.once("line", () => setTimeout(() => process.exit(3), 200));
        rl.once("close", () => process.exit(3));
      });
    }, 300);
  });
} else {
  if (mode === "garbage") process.stdout.write("m0-08 fake engine: this is not JSON-RPC\n");
  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    let frame = null;
    try { frame = JSON.parse(line); } catch { return; }
    if (mode === "garbage") { setTimeout(() => process.exit(3), 200); return; }
    if (mode === "silent") return;
    if (frame?.method === "initialize" && frame.id !== undefined && answers[mode]) {
      process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: answers[mode] })}\n`);
    } else if (frame?.id !== undefined && frame.method) {
      process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: frame.id, error: { code: -32601, message: `fake engine: ${frame.method} not served` } })}\n`);
    }
  });
  rl.on("close", () => process.exit(0));
}
