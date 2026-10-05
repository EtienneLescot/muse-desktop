/**
 * M4-07: remote execution over the **system `ssh` binary** (product decision
 * of 29/09/2026). The pure half of the transport: target validation, argv
 * construction and display — everything that can be decided without a remote
 * host, and unit-tested.
 *
 * Design rules shared with `computer.rs`:
 * - the argv is never built in the renderer: this module only *proposes* the
 *   canonical argv and validates the fields; the Rust side rebuilds it from
 *   the validated fields (`remote_ssh_exec`), so a compromised renderer
 *   cannot inject arguments — values are charset-checked, and the remote
 *   command travels after a literal `--` separator, never through a shell;
 * - no secret is stored or displayed: authentication rides the user's
 *   existing key agent (default keys, agent forwarding), so there is no
 *   password field to leak. The identity file is displayed as a file name
 *   only.
 * The remote half (a live host answering) is deliberately out of scope here:
 * `remote_ssh_exec` drives the real binary, and whether a specific host
 * accepts the connection is a property of that host, not of this code.
 */
import { readStorageJson, removeStorageKey, writeStorageJson } from "./storage.ts";

export const SSH_CONNECT_TIMEOUT = 10;
/** 1–120 s: the exec is an interactive control run, not a batch job. */
export const SSH_EXEC_TIMEOUT_MIN = 1;
export const SSH_EXEC_TIMEOUT_MAX = 120;
export const SSH_EXEC_TIMEOUT_DEFAULT = 30;
/** Output bound per stream, enforced Rust-side before anything crosses IPC. */
export const SSH_OUTPUT_LIMIT = 64 * 1024;

export interface RemoteSshTarget {
  /** Stable local id (`ssh-<short>`), assigned by the caller's store. */
  id: string;
  /** Free label shown in Settings, ≤ 60 characters. */
  label: string;
  host: string;
  port: number;
  /** Login user; empty string means "the system ssh default". */
  user: string;
  /** Absolute path to a private key; empty string means "the agent default". */
  identityFile: string;
}

const HOST_CHARS = /^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/;
const NAME_CHARS = /^[A-Za-z0-9._-]+$/;
const PATH_CHARS = /^[A-Za-z0-9 ._\\/:()-]+$/;

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
 * Validate one target from untrusted input. `null` for anything that would
 * not survive argv construction: this is the gate, not a lint.
 */
export function validateSshTarget(input: unknown): RemoteSshTarget | null {
  if (typeof input !== "object" || input === null) return null;
  const raw = input as Record<string, unknown>;
  const id = cleanString(raw.id, 40);
  const label = cleanString(raw.label, 60);
  const host = cleanString(raw.host, 255);
  const user = cleanString(raw.user, 64);
  const identityFile = cleanString(raw.identityFile, 400);
  if (!id || !label || !host || !HOST_CHARS.test(host)) return null;
  if (user && !validUser(user)) return null;
  if (identityFile && !PATH_CHARS.test(identityFile)) return null;
  const port = raw.port;
  if (port !== undefined && (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535)) return null;
  return { id, label, host, port: port ?? 22, user, identityFile };
}

/**
 * The canonical argv for one remote execution: the system binary, the
 * validated target, and the command after a literal `--` separator. The Rust
 * side rebuilds this from the same fields; both must agree, hence the pure
 * function and its tests.
 */
export function buildSshArgv(sshPath: string, target: RemoteSshTarget, command: string): string[] | null {
  if (!sshPath || !target || typeof command !== "string") return null;
  const cmd = command.trim();
  if (!cmd || cmd.length > 8_000 || /[\0]/.test(cmd)) return null;
  const argv = [sshPath];
  if (target.port !== 22) argv.push("-p", String(target.port));
  if (target.identityFile) argv.push("-i", target.identityFile);
  // Never prompt, never cache: a non-interactive control run either has the
  // agent's keys or fails bounded.
  argv.push("-o", "BatchMode=yes", "-o", `ConnectTimeout=${SSH_CONNECT_TIMEOUT}`);
  argv.push(target.user ? `${target.user}@${target.host}` : target.host);
  argv.push("--", cmd);
  return argv;
}

/** What the UI may show: the identity file shrinks to its name, nothing else. */
export function describeSshTarget(target: RemoteSshTarget): string {
  const who = target.user ? `${target.user}@${target.host}` : target.host;
  const key = target.identityFile ? ` (key ${target.identityFile.split(/[\\/]/).pop()})` : "";
  return `${who}:${target.port}${key} — ${target.label}`;
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
  const user = cleanString(raw.user, 64);
  const musePath = cleanString(raw.musePath, 400);
  // The host reports the folder without a trailing slash.
  const workspacePath = cleanString(raw.workspacePath, 400).replace(/(.)\/+$/, "$1");
  const port = raw.port ?? 22;
  if (!host || !HOST_CHARS.test(host) || (user && !validUser(user))) return null;
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

/** The one-line summary for a finished exec, bounded like every other status. */
export function describeSshResult(exitCode: number | null, timedOut: boolean, stdout: string, stderr: string): string {
  if (timedOut) return `ssh did not answer within the timeout; no output kept beyond ${SSH_OUTPUT_LIMIT >> 10} KiB per stream.`;
  const tail = (stdout.trim() || stderr.trim()).split("\n").slice(-1)[0] ?? "";
  const where = exitCode === 0 ? "succeeded" : `exited ${exitCode ?? "?"}`;
  return `ssh ${where}. ${tail.slice(0, 200)}`;
}
