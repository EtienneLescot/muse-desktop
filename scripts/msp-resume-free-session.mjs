#!/usr/bin/env node

/**
 * The decisive M0-02 test: resume a persisted session from a NEW host, with no
 * application holding it.
 *
 * Round 51 established that:
 *   - `session/read` works on a persisted session (`ok`), contrary to the gap
 *     report which called it `unsupported`;
 *   - `session/resume` answered `sessionInUse`, never `sessionNotFound`, on those
 *     sessions — but the app was running and holding them, so the free case was
 *     never observed.
 *
 * This script produces that free case: create a session, complete one trivial
 * turn so it is persisted, kill the host, start a fresh host, then resume and
 * read. If resume works, M0-02 is a client-side gap; if it fails, the sidecar
 * owns it.
 *
 * Usage:
 *   node scripts/msp-resume-free-session.mjs
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const SIDECAR = process.env.MUSE_SIDECAR ?? "src-tauri/binaries/muse-x86_64-pc-windows-msvc.exe";
const WORKSPACE = process.env.MUSE_WORKSPACE ?? "C:\\Users\\etien\\Documents\\repos\\muse-desktop";
const TURN_WAIT_MS = Number(process.env.MUSE_TURN_WAIT_MS ?? 150_000);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** UUIDv7: the host refuses a v4 (`expected UUIDv7`). */
function uuidv7() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const now = BigInt(Date.now());
  bytes[0] = Number((now >> 40n) & 0xffn);
  bytes[1] = Number((now >> 32n) & 0xffn);
  bytes[2] = Number((now >> 24n) & 0xffn);
  bytes[3] = Number((now >> 16n) & 0xffn);
  bytes[4] = Number((now >> 8n) & 0xffn);
  bytes[5] = Number(now & 0xffn);
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function startHost(label) {
  const child = spawn(SIDECAR, ["serve", "--sandbox-network", "restricted"], { stdio: ["pipe", "pipe", "pipe"] });
  const reader = createInterface({ input: child.stdout });
  let nextId = 1;
  const pending = new Map();
  const notifications = [];
  reader.on("line", (line) => {
    let frame;
    try { frame = JSON.parse(line); } catch { return; }
    if (frame.id === undefined) { if (typeof frame.method === "string") notifications.push(frame.method); return; }
    const settle = pending.get(frame.id);
    if (!settle) return;
    pending.delete(frame.id);
    settle(frame);
  });
  const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
  const request = (method, params = {}, timeoutMs = 40_000) =>
    new Promise((resolve) => {
      const id = nextId++;
      pending.set(id, resolve);
      send({ jsonrpc: "2.0", id, method, params });
      setTimeout(() => {
        if (pending.has(id)) { pending.delete(id); resolve({ error: { message: `${method}: timeout` } }); }
      }, timeoutMs);
    });
  const init = await request("initialize", {
    clientInfo: { name: "muse_resume_free", version: "1.0.0" },
    schema: 1,
    capabilities: {},
  });
  if (init.error) throw new Error(`${label}: initialize — ${init.error.message}`);
  send({ jsonrpc: "2.0", method: "initialized", params: {} });
  await sleep(600);
  return { label, child, request, notifications, durability: init.result?.sessionDurability ?? null };
}

const outcome = (response) => (response.error
  ? { failed: true, kind: response.error.data?.kind ?? null, message: String(response.error.message).slice(0, 90) }
  : { failed: false });

async function main() {
  const report = { schema: "muse-desktop.msp-resume-free-session.v1", steps: [] };

  // --- Host A: a session that completes one real turn, so it persists.
  const a = await startHost("A");
  report.hostADurability = a.durability;
  const started = await a.request("session/start", { workspaceRoot: WORKSPACE, commandId: uuidv7() });
  const sessionId = started.result?.session?.sessionId ?? started.result?.sessionId ?? null;
  report.sessionId = sessionId;
  if (!sessionId) {
    report.verdict = "session/start returned no id";
    a.child.kill();
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }

  const turn = await a.request("turn/start", {
    sessionId,
    commandId: uuidv7(),
    input: [{ type: "text", text: "Reply with exactly: PERSIST" }],
  }, TURN_WAIT_MS);
  report.steps.push({ step: "A: turn started", ...outcome(turn) });

  // Wait for the turn to settle: persistence happens by writing the session.
  let sawTerminal = false;
  for (let waited = 0; waited < TURN_WAIT_MS && !sawTerminal; waited += 3_000) {
    await sleep(3_000);
    if (a.notifications.some((m) => /^turn\/(completed|stopped|retracted)$/.test(m))) sawTerminal = true;
  }
  report.steps.push({ step: "A: turn settled", terminalNotification: sawTerminal, notifications: [...new Set(a.notifications)] });

  // --- Kill A: the host dies, as after an app close or a crash.
  a.child.kill();
  await sleep(3_000);

  // --- Host B: fresh process, no application holding anything.
  const b = await startHost("B");
  report.hostBDurability = b.durability;

  const listed = await b.request("session/list", { limit: 200 });
  const sessions = Array.isArray(listed.result?.sessions) ? listed.result.sessions : [];
  const match = sessions.find((s) => String(s.sessionId) === sessionId) ?? null;
  report.steps.push({
    step: "B: session listed by a NEW host",
    found: Boolean(match),
    count: sessions.length,
    status: match?.status ?? null,
    turnCount: match?.turnCount ?? null,
  });

  if (match) {
    report.resume = outcome(await b.request("session/resume", { sessionId, commandId: uuidv7() }));
    report.steps.push({ step: "B: session/resume", ...report.resume });

    const read = await b.request("session/read", { sessionId, excludeItems: false });
    report.read = outcome(read);
    report.steps.push({
      step: "B: session/read",
      ...report.read,
      shapes: read.error ? null : Object.keys(read.result ?? {}).sort(),
    });
  }

  report.verdict = !match
    ? "the session did not persist — no turn was written"
    : report.resume.failed
      ? `resume refused on a FREE persisted session: ${report.resume.kind ?? "unknown"} — the sidecar owns this gap`
      : "resume SUCCEEDED on a free persisted session — M0-02 is a client-side gap";

  b.child.kill();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

await main().catch((error) => { process.stderr.write(`${(error && error.message) || error}\n`); process.exit(1); });
