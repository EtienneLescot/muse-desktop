#!/usr/bin/env node

/**
 * Enumerate every session the host knows, with its metadata.
 *
 * `session/list` is the authoritative source: it is the host's own view, not a
 * guess from the filesystem. It also reports the storage `path` of each session
 * and several fields no other surface exposes (`status`, `activeTurnId`,
 * `turnCount`, `providerId`, `modelId`, `branch`, `firstUserPrompt`).
 *
 * Read-only: this script never deletes or writes anything.
 *
 * Usage:
 *   node scripts/msp-list-sessions.mjs
 *   node scripts/msp-list-sessions.mjs --json
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const AS_JSON = process.argv.includes("--json");
const LIMIT = Number(process.env.MUSE_LIST_LIMIT ?? 200);
const SIDECAR = process.env.MUSE_SIDECAR ?? "src-tauri/binaries/muse-x86_64-pc-windows-msvc.exe";

function startHost() {
  const child = spawn(SIDECAR, ["serve", "--sandbox-network", "restricted"], { stdio: ["pipe", "pipe", "pipe"] });
  const reader = createInterface({ input: child.stdout });
  let nextId = 1;
  const pending = new Map();
  const notifications = [];

  reader.on("line", (line) => {
    let frame;
    try { frame = JSON.parse(line); } catch { return; }
    if (frame.id === undefined) {
      if (typeof frame.method === "string") notifications.push(frame.method);
      return;
    }
    const settle = pending.get(frame.id);
    if (!settle) return;
    pending.delete(frame.id);
    settle(frame);
  });

  const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
  const request = (method, params = {}, timeoutMs = 30_000) =>
    new Promise((resolve) => {
      const id = nextId++;
      pending.set(id, resolve);
      send({ jsonrpc: "2.0", id, method, params });
      setTimeout(() => {
        if (pending.has(id)) { pending.delete(id); resolve({ error: { message: `${method}: timeout` } }); }
      }, timeoutMs);
    });

  return { child, send, request, notifications };
}

async function main() {
  const host = startHost();
  try {
    const init = await host.request("initialize", {
      clientInfo: { name: "muse_list_sessions", version: "1.0.0" },
      schema: 1,
      capabilities: {},
    });
    if (init.error) throw new Error(`initialize: ${init.error.message}`);
    // The handshake is not complete without this notification: every later call
    // answers `Not initialized` otherwise.
    host.send({ jsonrpc: "2.0", method: "initialized", params: {} });
    await new Promise((resolve) => setTimeout(resolve, 600));

    const listed = await host.request("session/list", { limit: LIMIT });
    if (listed.error) throw new Error(`session/list: ${JSON.stringify(listed.error).slice(0, 200)}`);

    const sessions = Array.isArray(listed.result?.sessions) ? listed.result.sessions : [];
    const report = {
      schema: "muse-desktop.msp-list-sessions.v1",
      server: init.result?.serverInfo?.version ?? null,
      durability: init.result?.sessionDurability ?? null,
      count: sessions.length,
      fields: sessions.length ? Object.keys(sessions[0]).sort() : [],
      sessions: sessions.map((s) => ({
        sessionId: String(s.sessionId ?? ""),
        title: String(s.title ?? "").slice(0, 52),
        status: s.status ?? null,
        turnCount: s.turnCount ?? null,
        workspaceRoot: String(s.workspaceRoot ?? "").replace(/^\\\\\?\\/, ""),
        branch: s.branch ?? null,
        path: String(s.path ?? ""),
        updatedAt: s.updatedAt ?? null,
      })),
    };

    if (AS_JSON) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      return;
    }

    process.stdout.write(`host ${report.server ?? "?"} · durabilité ${report.durability ?? "?"} · ${report.count} session(s)\n`);
    process.stdout.write(`champs : ${report.fields.join(", ")}\n\n`);
    process.stdout.write("session   tours  statut       branche      espace de travail              titre\n");
    for (const s of report.sessions) {
      process.stdout.write(
        `${s.sessionId.slice(0, 8)}  ${String(s.turnCount ?? "?").padStart(5)}  ${String(s.status ?? "?").padEnd(11)}  ${String(s.branch ?? "-").padEnd(11)}  ${String(s.workspaceRoot).slice(-28).padEnd(29)}  ${s.title}\n`,
      );
    }
    const campaign = report.sessions.filter((s) => s.sessionId.startsWith("01a0"));
    process.stdout.write(`\npréfixe 01a0 (identifiants de cette campagne) : ${campaign.length}\n`);
    process.stdout.write(`autres identifiants                          : ${report.count - campaign.length}\n`);
  } finally {
    host.child.kill();
  }
}

await main().catch((error) => { process.stderr.write(`${(error && error.message) || error}\n`); process.exit(1); });
