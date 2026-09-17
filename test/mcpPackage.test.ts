import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { zipSync } from "fflate";
import {
  buildMcpPackageCommand,
  mcpPackageId,
  parseMcpbArchive,
} from "../src/lib/mcpPackage.ts";
import { tokenizeMcpCommand } from "../src/lib/hostMcp.ts";

function bundle(manifest: unknown, extra: Record<string, string> = {}) : Uint8Array {
  const files: Record<string, Uint8Array> = {
    "manifest.json": new TextEncoder().encode(JSON.stringify(manifest)),
    "server/index.js": new TextEncoder().encode("process.stdin.resume();"),
  };
  for (const [path, content] of Object.entries(extra)) files[path] = new TextEncoder().encode(content);
  return zipSync(files);
}

const baseManifest = {
  name: "Demo Tools",
  version: "1.2.3",
  description: "A demo package",
  server: { type: "node", entry_point: "server/index.js", args: ["--stdio"] },
};

describe("MCP Bundle intake", () => {
  it("parses a valid manifest and keeps package identity stable across versions", () => {
    const parsed = parseMcpbArchive(bundle(baseManifest), "demo.mcpb");
    assert.equal(parsed.id, "mcpb-demo-tools");
    assert.equal(mcpPackageId("Demo Tools"), parsed.id);
    assert.equal(parsed.sourceName, "demo.mcpb");
    assert.equal(parsed.manifest.runtime, "node");
    assert.deepEqual(parsed.manifest.args, ["--stdio"]);
    assert.ok(parsed.files.some((file) => file.path === "server/index.js"));
  });

  it("supports python packages and creates an explicit executable command", () => {
    const parsed = parseMcpbArchive(bundle({
      ...baseManifest,
      name: "Py Tools",
      server: { type: "python", entry_point: "server/index.js" },
    }), "py-tools.mcpb");
    const command = buildMcpPackageCommand(parsed, "C:\\Muse Data\\mcp-packages\\mcpb-py-tools\\1.2.3");
    assert.match(command, /^python /);
    assert.match(command, /server[\\/]index\.js/);
    assert.deepEqual(tokenizeMcpCommand(command), [
      "python",
      "C:\\Muse Data\\mcp-packages\\mcpb-py-tools\\1.2.3/server/index.js",
    ]);
  });

  it("rejects malformed manifests and unsafe entry points", () => {
    assert.throws(
      () => parseMcpbArchive(bundle({ ...baseManifest, version: "latest" }), "bad.mcpb"),
      /semver/,
    );
    assert.throws(
      () => parseMcpbArchive(bundle({ ...baseManifest, server: { type: "node", entry_point: "../escape.js" } }), "bad.mcpb"),
      /relative path|unsafe path/,
    );
    assert.throws(
      () => parseMcpbArchive(zipSync({ "server/index.js": new TextEncoder().encode("x") }), "bad.mcpb"),
      /manifest/,
    );
  });

  it("rejects archive paths that normalize to traversal", () => {
    assert.throws(
      () => parseMcpbArchive(zipSync({
        "manifest.json": new TextEncoder().encode(JSON.stringify(baseManifest)),
        "../escape.js": new TextEncoder().encode("x"),
      }), "bad.mcpb"),
      /unsafe path/,
    );
  });
});
