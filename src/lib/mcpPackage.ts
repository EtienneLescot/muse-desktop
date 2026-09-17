/**
 * MCP Bundle (`.mcpb`) intake.
 *
 * A bundle is a zip containing a root `manifest.json` and the server files
 * referenced by `manifest.server.entry_point`.  Parsing is deliberately
 * renderer-side and side-effect free: the native bridge receives only the
 * validated file list and performs the atomic install.  This keeps package
 * metadata in the connector SSOT while never executing or trusting a bundle
 * before a real MCP probe succeeds.
 */

import { unzipSync } from "fflate";

export const MCPB_FORMAT = "mcpb" as const;
export const MAX_MCPB_BYTES = 20 * 1024 * 1024;
export const MAX_MCPB_FILES = 256;
export const MAX_MCPB_FILE_BYTES = 4 * 1024 * 1024;
export const MAX_MCPB_TOTAL_BYTES = 16 * 1024 * 1024;
export const MAX_MCPB_ARGS = 32;
export const MAX_MCPB_TEXT = 2_000;

export type McpPackageRuntime = "node" | "python";

export interface McpPackageFile {
  path: string;
  bytes: Uint8Array;
}

export interface McpPackageManifest {
  name: string;
  version: string;
  description: string;
  runtime: McpPackageRuntime;
  entryPoint: string;
  args: string[];
}

export interface ParsedMcpPackage {
  id: string;
  sourceName: string;
  manifest: McpPackageManifest;
  files: McpPackageFile[];
  archiveBytes: number;
}

function text(value: unknown, label: string, max = MAX_MCPB_TEXT): string {
  if (typeof value !== "string") throw new Error(`MCP bundle manifest ${label} is required`);
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max || trimmed.includes("\u0000")) {
    throw new Error(`MCP bundle manifest ${label} is invalid`);
  }
  return trimmed;
}

function safeRelativePath(raw: string, label: string): string {
  const normalized = raw.replaceAll("\\", "/").trim();
  if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)) {
    throw new Error(`MCP bundle ${label} must be a relative path`);
  }
  const parts = normalized.split("/");
  if (parts.some((part) => part === "" || part === "." || part === ".." || part.includes("\u0000"))) {
    throw new Error(`MCP bundle ${label} contains an unsafe path`);
  }
  return parts.join("/");
}

function slug(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized.slice(0, 80) || "extension";
}

/** A stable identity across versions, so installing an update replaces one row. */
export function mcpPackageId(name: string): string {
  return `mcpb-${slug(name)}`;
}

function parseManifest(raw: unknown, files: Map<string, Uint8Array>): McpPackageManifest {
  if (typeof raw !== "object" || raw === null) throw new Error("MCP bundle manifest is not an object");
  const record = raw as Record<string, unknown>;
  const name = text(record.name, "name", 120);
  const version = text(record.version, "version", 80);
  // Keep the accepted version grammar deliberately conservative. It is a
  // display/update identity, not a dependency resolver.
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error("MCP bundle manifest version must use semver (for example 1.2.3)");
  }
  const description = typeof record.description === "string"
    ? record.description.trim().slice(0, MAX_MCPB_TEXT)
    : "Packaged MCP server.";
  if (description.includes("\u0000")) throw new Error("MCP bundle manifest description is invalid");
  const server = typeof record.server === "object" && record.server !== null
    ? record.server as Record<string, unknown>
    : null;
  if (server === null) throw new Error("MCP bundle manifest server is required");
  const rawType = typeof server.type === "string" ? server.type.trim().toLowerCase() : "";
  const runtime: McpPackageRuntime = rawType === "node" || rawType === "python"
    ? rawType
    : (() => { throw new Error("MCP bundle server.type must be node or python"); })();
  const entryPoint = safeRelativePath(text(server.entry_point, "server.entry_point", 400), "entry point");
  if (!files.has(entryPoint)) throw new Error("MCP bundle entry point is missing from the archive");
  const rawArgs = server.args;
  const args = rawArgs === undefined
    ? []
    : Array.isArray(rawArgs)
      ? rawArgs.map((arg, index) => text(arg, `server.args[${index}]`, 500))
      : (() => { throw new Error("MCP bundle server.args must be an array"); })();
  if (args.length > MAX_MCPB_ARGS) throw new Error(`MCP bundle has more than ${MAX_MCPB_ARGS} server arguments`);
  return { name, version, description, runtime, entryPoint, args };
}

/** Parse and validate an `.mcpb` archive without writing files or executing code. */
export function parseMcpbArchive(bytes: Uint8Array, sourceName: string): ParsedMcpPackage {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) throw new Error("MCP bundle is empty");
  if (bytes.byteLength > MAX_MCPB_BYTES) throw new Error(`MCP bundle is limited to ${MAX_MCPB_BYTES / (1024 * 1024)} MiB`);
  let archive: Record<string, Uint8Array>;
  try {
    archive = unzipSync(bytes);
  } catch {
    throw new Error("MCP bundle is not a valid zip archive");
  }
  const names = Object.keys(archive);
  if (names.length === 0 || names.length > MAX_MCPB_FILES) {
    throw new Error(`MCP bundle must contain between 1 and ${MAX_MCPB_FILES} files`);
  }
  const files = new Map<string, Uint8Array>();
  let total = 0;
  for (const rawName of names) {
    const path = safeRelativePath(rawName, "file path");
    if (path === "manifest.json") {
      const manifestBytes = archive[rawName];
      if (manifestBytes.byteLength > MAX_MCPB_FILE_BYTES) throw new Error("MCP bundle manifest is too large");
    }
    const file = archive[rawName];
    if (file.byteLength > MAX_MCPB_FILE_BYTES) throw new Error(`MCP bundle file ${path} is too large`);
    total += file.byteLength;
    if (total > MAX_MCPB_TOTAL_BYTES) throw new Error("MCP bundle contents exceed the size limit");
    if (files.has(path)) throw new Error(`MCP bundle contains duplicate path ${path}`);
    files.set(path, file);
  }
  const manifestBytes = files.get("manifest.json");
  if (!manifestBytes) throw new Error("MCP bundle must contain a root manifest.json");
  let manifestRaw: unknown;
  try {
    manifestRaw = JSON.parse(new TextDecoder().decode(manifestBytes));
  } catch {
    throw new Error("MCP bundle manifest.json is not valid JSON");
  }
  const manifest = parseManifest(manifestRaw, files);
  return {
    id: mcpPackageId(manifest.name),
    sourceName: sourceName.trim().slice(0, 240) || "MCP bundle",
    manifest,
    files: [...files.entries()].map(([path, file]) => ({ path, bytes: file })),
    archiveBytes: bytes.byteLength,
  };
}

function quoteToken(token: string): string {
  // The resulting command is later tokenized by hostMcp.ts. Escaping quotes
  // is enough because package args have already been validated as plain
  // strings and the command never goes through a shell expansion in config.
  if (token.includes('"') || token.includes("'")) {
    throw new Error("MCP bundle arguments cannot contain quote characters");
  }
  return /\s/.test(token) ? `"${token}"` : token;
}

/** Build the explicit local command used to probe/start an installed bundle. */
export function buildMcpPackageCommand(pkg: ParsedMcpPackage, installRoot: string): string {
  const root = installRoot.trim();
  if (!root || root.includes("\u0000")) throw new Error("MCP bundle install directory is invalid");
  const entry = `${root.replace(/[\\/]+$/, "")}/${pkg.manifest.entryPoint}`;
  const runtime = pkg.manifest.runtime === "node" ? "node" : "python";
  return [runtime, quoteToken(entry), ...pkg.manifest.args.map(quoteToken)].join(" ");
}
