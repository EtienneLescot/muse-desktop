#!/usr/bin/env node
/**
 * M4-06 reference implementation of the **self-hosted share mini-server**
 * (product decision of 29/09/2026): a single-file, zero-dependency Node
 * service the user runs on their own machine (LAN, VPS, NAS). Muse publishes
 * a bundle with a token and a duration; anyone with the URL can read it; the
 * publisher revokes it; revocation is observable from any client (404).
 *
 *   SHARE_TOKEN=… node scripts/share-server.mjs [--port 8787] [--state file.json]
 *
 * Wire contract (shared with `src/lib/sharePublish.ts`):
 *   PUT    /muse-share/<id>   publish  (Bearer; 201 {"url"}; 413 too large)
 *   DELETE /muse-share/<id>   revoke   (Bearer; 204; then GET = 404 for everyone)
 *   GET    /muse-share/<id>   read     (no token; 200 bundle | 404 unknown/expired/revoked)
 *   GET    /health            liveness
 * No account, no identity layer: the token is the publish/revoke credential,
 * a reader needs nothing. State is in-memory with an optional JSON file so a
 * restart keeps the published set; expiry is checked on every read.
 */
import { createServer } from "node:http";
import { readFileSync, writeFileSync, renameSync } from "node:fs";

const args = process.argv.slice(2);
const portFlag = args.indexOf("--port");
const PORT = portFlag >= 0 ? Number(args[portFlag + 1]) : Number(process.env.SHARE_PORT ?? 8787);
const stateFlag = args.indexOf("--state");
const STATE_FILE = stateFlag >= 0 ? args[stateFlag + 1] : (process.env.SHARE_STATE_FILE ?? "");
const TOKEN = process.env.SHARE_TOKEN ?? "";
const BODY_LIMIT = 240 * 1024;
const PATH_RE = /^\/muse-share\/(share-[A-Za-z0-9_-]{4,64})$/;

const bundles = new Map();
if (STATE_FILE) {
  try {
    for (const [id, entry] of Object.entries(JSON.parse(readFileSync(STATE_FILE, "utf8")))) bundles.set(id, entry);
  } catch {
    // A missing or corrupt state file starts an empty server; publishes recreate it.
  }
}
let stateDirty = false;
function persist() {
  if (!STATE_FILE || !stateDirty) return;
  const temp = `${STATE_FILE}.tmp`;
  writeFileSync(temp, JSON.stringify(Object.fromEntries(bundles)));
  renameSync(temp, STATE_FILE);
  stateDirty = false;
}

function authorized(req) {
  if (!TOKEN) return true;
  return req.headers.authorization === `Bearer ${TOKEN}`;
}

function serve(req, res) {
  const url = new URL(req.url ?? "/", "http://local");
  if (url.pathname === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, published: bundles.size }));
    return;
  }
  const match = PATH_RE.exec(url.pathname);
  if (!match) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
    return;
  }
  const id = match[1];

  if (req.method === "PUT" || req.method === "POST") {
    if (!authorized(req)) {
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "forbidden" }));
      return;
    }
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > BODY_LIMIT) {
        res.writeHead(413, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "bundle too large" }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (res.writableEnded) return;
      let parsed;
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "invalid json" }));
        return;
      }
      if (typeof parsed?.bundle?.bundleId !== "string" || typeof parsed?.bundle?.body !== "string" || typeof parsed?.expiresAt !== "number") {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "incomplete export" }));
        return;
      }
      bundles.set(id, { bundle: parsed.bundle, expiresAt: parsed.expiresAt, revoked: false });
      stateDirty = true;
      persist();
      res.writeHead(201, { "content-type": "application/json" });
      res.end(JSON.stringify({ url: `${publicBase(req)}/muse-share/${id}` }));
    });
    return;
  }

  if (req.method === "DELETE") {
    if (!authorized(req)) {
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "forbidden" }));
      return;
    }
    const entry = bundles.get(id);
    if (!entry) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }
    entry.revoked = true;
    stateDirty = true;
    persist();
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === "GET") {
    const entry = bundles.get(id);
    if (!entry || entry.revoked || Date.now() > entry.expiresAt) {
      // Revocation and expiry are observable from any client: the same 404.
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(entry));
    return;
  }

  res.writeHead(405, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "method not allowed" }));
}

function publicBase(req) {
  const forwardedHost = req.headers["x-forwarded-host"];
  const host = typeof forwardedHost === "string" ? forwardedHost.split(",")[0].trim() : (req.headers.host ?? `127.0.0.1:${PORT}`);
  const proto = req.headers["x-forwarded-proto"] === "https" ? "https" : "http";
  return `${proto}://${host}`;
}

const server = createServer(serve);
server.listen(PORT, "0.0.0.0", () => {
  const actual = server.address();
  const shown = typeof actual === "object" && actual !== null ? actual.port : PORT;
  console.log(`share mini-server listening on :${shown} (token ${TOKEN ? "set" : "NOT set — anyone may publish"})`);
});
process.on("SIGINT", () => {
  persist();
  server.close(() => process.exit(0));
});
