/**
 * M4-07: the remote engine over the **system `ssh` binary** (product decision
 * of 29/09/2026). The pure half: the target's validation, its workspace key
 * and how it is shown — everything that can be decided without a remote host,
 * and unit-tested.
 *
 * The argv is never built in the renderer: the conversation's `ssh://` key is
 * all `remote_ssh.rs` receives, and it re-parses the key, charset-checks every
 * field and rebuilds the argv, so a compromised renderer cannot inject an
 * argument. No secret is stored or displayed: authentication rides the user's
 * existing key agent, so there is no password field to leak.
 */
import { readStorageJson, removeStorageKey, writeStorageJson } from "./storage.ts";

const HOST_CHARS = /^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/;
const NAME_CHARS = /^[A-Za-z0-9._-]+$/;

/** A dash-leading user would make `user@host` an ssh option (`-E…` writes a log file). */
function validUser(user: string): boolean {
  return NAME_CHARS.test(user) && !user.startsWith("-");
}

function cleanString(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  // Control characters can smuggle argument boundaries on some platforms.
  if (trimmed.length === 0 || trimmed.length > max || /[\0\r\n]/.test(trimmed)) return "";
  return trimmed;
}

/**
 * `cleanString` for an optional field: "" when absent, `null` when present
 * but refused, so an invalid user never falls back to the default one.
 */
function optionalString(value: unknown, max: number): string | null {
  if (typeof value !== "string" || value.trim() === "") return "";
  return cleanString(value, max) || null;
}

/**
 * M4-07 remote engine: a conversation whose Muse host is `muse serve` on
 * another machine, reached through the system ssh. The whole target is the
 * conversation's workspace key, `ssh://[user@]host:port/abs/path` plus
 * `?muse=<binary>` when it is not the default, so a reconnect needs only the
 * conversation record and a remote host never collides with a local folder.
 * `RemoteEngine` in `remote_ssh.rs` re-parses and rebuilds that key.
 */
export const REMOTE_ENGINE_STORAGE_KEY = "muse-desktop.remote-engine.v1";
/** Where the official installer puts Muse; the remote shell expands `~`. */
export const DEFAULT_REMOTE_MUSE = "~/.local/bin/muse";

export interface RemoteEngineTarget {
  /** Login user; empty string means "the system ssh default". */
  user: string;
  host: string;
  port: number;
  /** Remote binary: absolute, or `~/`-relative. */
  musePath: string;
  /** Absolute folder on the remote host: the conversation's workspace there. */
  workspacePath: string;
}

/** One plain word for the remote login shell: no space, quote or metacharacter. */
const REMOTE_PATH = /^(?:\/|~\/)[A-Za-z0-9._/-]*$/;

/** Validate the remote engine form or its stored copy; `null` for anything Rust would refuse. */
export function validateRemoteEngine(input: unknown): RemoteEngineTarget | null {
  if (typeof input !== "object" || input === null) return null;
  const raw = input as Record<string, unknown>;
  const host = cleanString(raw.host, 255);
  const user = optionalString(raw.user, 64);
  const musePath = cleanString(raw.musePath, 400);
  // The host reports the folder without a trailing slash.
  const workspacePath = cleanString(raw.workspacePath, 400).replace(/(.)\/+$/, "$1");
  const port = raw.port ?? 22;
  if (!host || !HOST_CHARS.test(host) || user === null || (user && !validUser(user))) return null;
  if (!REMOTE_PATH.test(musePath) || !workspacePath.startsWith("/") || !REMOTE_PATH.test(workspacePath)) return null;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { user, host, port, musePath, workspacePath };
}

/** The workspace key a remote conversation is started and stored under. */
export function remoteWorkspaceUri(target: RemoteEngineTarget): string {
  const who = target.user ? `${target.user}@${target.host}` : target.host;
  const muse = target.musePath === DEFAULT_REMOTE_MUSE ? "" : `?muse=${target.musePath}`;
  return `ssh://${who}:${target.port}${target.workspacePath}${muse}`;
}

export function isRemoteWorkspace(workspace: string | null | undefined): boolean {
  return typeof workspace === "string" && workspace.startsWith("ssh://");
}

/** The target a workspace key names, as `RemoteEngine::parse` reads it; `null` for anything else. */
function parseRemoteWorkspaceUri(workspace: string): RemoteEngineTarget | null {
  const match = /^ssh:\/\/(?:([^@/]*)@)?([^:/]+)(?::(\d+))?(\/[^?]*)(?:\?muse=(.*))?$/.exec(workspace);
  if (match === null) return null;
  const [, user = "", host, port = "22", workspacePath, musePath = DEFAULT_REMOTE_MUSE] = match;
  return validateRemoteEngine({ user, host, port: Number(port), workspacePath, musePath });
}

/**
 * What an `authRequired` failure says in a remote conversation: signing in
 * on this computer does not reach the remote engine's credentials.
 */
export function remoteSignInHint(workspace: string | null | undefined): string | null {
  const target = parseRemoteWorkspaceUri(workspace ?? "");
  if (target === null) return null;
  const port = target.port === 22 ? "" : `-p ${target.port} `;
  const who = target.user ? `${target.user}@${target.host}` : target.host;
  return `Muse on ${target.host} is not signed in, and signing in on this computer does not reach it. From a terminal, run ssh ${port}${who}, then ${target.musePath} login.`;
}

/** Why a worktree cannot be made for this conversation, or `null`. */
export function worktreeUnavailableReason(workspace: string | null | undefined): string | null {
  return isRemoteWorkspace(workspace) ? "Not available for remote conversations: a worktree is a local git copy." : null;
}

/** "Remote: user@host": the picker appends the folder, as for any project. */
export function describeRemoteEngine(target: RemoteEngineTarget): string {
  return `Remote: ${target.user ? `${target.user}@${target.host}` : target.host}`;
}

export function loadRemoteEngine(): RemoteEngineTarget | null {
  return validateRemoteEngine(readStorageJson<unknown>(REMOTE_ENGINE_STORAGE_KEY, null));
}

/** `null` forgets the target; conversations already started keep their key. */
export function saveRemoteEngine(target: RemoteEngineTarget | null): boolean {
  return target === null
    ? removeStorageKey(REMOTE_ENGINE_STORAGE_KEY)
    : writeStorageJson(REMOTE_ENGINE_STORAGE_KEY, target);
}
