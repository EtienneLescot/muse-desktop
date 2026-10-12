import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { pathKey } from "../lib/paths";
import { insideWorktree, mainRootOf } from "../lib/worktrees";

/**
 * M2-04 / M2-06: the worktree environment and cleanup surfaces.
 *
 * Two groups, both live in Settings because they answer "is this worktree a
 * good place to work, and what does this repository carry":
 *  - Worktree setup (only visible inside a worktree): one bounded user
 *    command per workspace, run only after an explicit click, with
 *    ready/failed/timedOut/cancelled states, targeted cancellation and a
 *    readiness check over the detected project files.
 *  - Worktrees (visible for any git workspace): Inspect over every worktree
 *    of the repository, a per-repository retention policy, and cleanup of the
 *    checkouts that are clean, unattached and older than the retention.
 */

interface WorktreeSetupOutcome {
  status: "ready" | "failed" | "timedOut" | "cancelled";
  output: string;
  exitCode: number | null;
  durationMs: number;
  environmentKeys: string[];
  token: string;
}

interface WorktreeReadiness {
  path: string;
  status: string;
  projectFiles: string[];
  tools: Array<{ name: string; required: boolean; available: boolean }>;
  checkedAt: number;
}

interface WorktreeInspection {
  path: string;
  branch: string | null;
  head: string | null;
  isMain: boolean;
  clean: boolean;
  conflicted: boolean;
  modifiedAtMs: number;
}

const SETUP_KEY = "muse-desktop.worktree-setup.v1";
const RETENTION_KEY = "muse-desktop.worktree-retention.v1";
const RETENTION_CHOICES: Array<{ label: string; days: number | null }> = [
  { label: "Keep 7 days", days: 7 },
  { label: "Keep 14 days", days: 14 },
  { label: "Keep 30 days", days: 30 },
  { label: "Keep 90 days", days: 90 },
  { label: "Keep indefinitely", days: null },
];

function readMap<T>(key: string): Record<string, T> {
  try {
    return JSON.parse(localStorage.getItem(key) || "{}") as Record<string, T>;
  } catch {
    return {};
  }
}

function writeMap<T>(key: string, value: Record<string, T>): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* best effort */
  }
}

function ageLabel(modifiedAtMs: number): string {
  const days = Math.floor((Date.now() - modifiedAtMs) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "1 day";
  return `${days} days`;
}

export function WorktreeTools({ workspace }: { workspace: string | null }) {
  const gitWorkspace = workspace !== null && workspace.length > 0 ? workspace : null;
  const inWorktree = gitWorkspace !== null && insideWorktree(gitWorkspace);
  const repoRoot = gitWorkspace === null ? null : mainRootOf(gitWorkspace);
  const [setupCommand, setSetupCommand] = useState(() => {
    if (gitWorkspace === null) return "";
    return readMap<string>(SETUP_KEY)[gitWorkspace] ?? "";
  });
  const [setupOutcome, setSetupOutcome] = useState<WorktreeSetupOutcome | null>(null);
  const [setupRunning, setSetupRunning] = useState(false);
  const [activeToken, setActiveToken] = useState<string | null>(null);
  const [readiness, setReadiness] = useState<WorktreeReadiness | null>(null);
  const [inspections, setInspections] = useState<WorktreeInspection[] | null>(null);
  const [inspecting, setInspecting] = useState(false);
  const [retentionDays, setRetentionDays] = useState<number | null>(() => {
    if (gitWorkspace === null) return 30;
    return readMap<number | null>(RETENTION_KEY)[mainRootOf(gitWorkspace)] ?? 30;
  });
  const [cleanupResult, setCleanupResult] = useState<string | null>(null);
  const [cleaning, setCleaning] = useState(false);

  const saveSetupCommand = (value: string): void => {
    setSetupCommand(value);
    if (gitWorkspace === null) return;
    const map = readMap<string>(SETUP_KEY);
    map[gitWorkspace] = value;
    writeMap(SETUP_KEY, map);
  };

  const runSetup = async (): Promise<void> => {
    if (gitWorkspace === null || setupCommand.trim().length === 0 || setupRunning) return;
    setSetupRunning(true);
    setSetupOutcome(null);
    const token = crypto.randomUUID();
    setActiveToken(token);
    try {
      const outcome = await invoke<WorktreeSetupOutcome>("git_worktree_setup_run", {
        workspace: repoRoot,
        path: gitWorkspace,
        command: setupCommand,
        token,
      });
      setSetupOutcome(outcome);
    } catch (error) {
      setSetupOutcome({
        status: "failed",
        output: String(error).slice(0, 500),
        exitCode: null,
        durationMs: 0,
        environmentKeys: [],
        token: "",
      });
    } finally {
      setSetupRunning(false);
      setActiveToken(null);
    }
  };

  const cancelSetup = async (): Promise<void> => {
    if (activeToken === null) return;
    await invoke("git_worktree_setup_cancel", { token: activeToken }).catch(() => undefined);
  };

  const checkReadiness = async (): Promise<void> => {
    if (gitWorkspace === null || repoRoot === null) return;
    setReadiness(
      await invoke<WorktreeReadiness>("git_worktree_readiness", {
        workspace: repoRoot,
        path: gitWorkspace,
      }).catch(() => null),
    );
  };

  const inspectAll = async (): Promise<void> => {
    if (repoRoot === null || inspecting) return;
    setInspecting(true);
    setCleanupResult(null);
    try {
      const list = await invoke<WorktreeInspection[]>("git_worktree_inspect", {
        workspace: repoRoot,
      });
      setInspections(list);
    } catch (error) {
      setCleanupResult(String(error).slice(0, 300));
    } finally {
      setInspecting(false);
    }
  };

  const removeWorktree = async (path: string, force: boolean): Promise<void> => {
    if (repoRoot === null) return;
    try {
      await invoke("git_worktree_remove", { workspace: repoRoot, path, force });
      setCleanupResult(`Removed ${path}`);
      await inspectAll();
    } catch (error) {
      setCleanupResult(String(error).slice(0, 300));
    }
  };

  const cleanUp = async (): Promise<void> => {
    if (inspections === null || cleaning) return;
    setCleaning(true);
    let removed = 0;
    const errors: string[] = [];
    const attached = new Set(
      (() => {
        try {
          const sessions = JSON.parse(localStorage.getItem("muse-desktop.sessions.v1") || "[]") as Array<{
            workspace?: string;
            host_workspace?: string;
          }>;
          // M2-05: a moved conversation still resumes from its host's folder.
          return sessions.flatMap((session) =>
            [session.workspace, session.host_workspace].map((path) => pathKey(path || "")),
          );
        } catch {
          return [];
        }
      })(),
    );
    for (const inspection of inspections) {
      if (inspection.isMain) continue;
      if (!inspection.clean || inspection.conflicted) continue;
      if (attached.has(pathKey(inspection.path))) continue;
      if (retentionDays !== null && Date.now() - inspection.modifiedAtMs < retentionDays * 86_400_000)
        continue;
      try {
        await invoke("git_worktree_remove", {
          workspace: repoRoot,
          path: inspection.path,
          force: false,
        });
        removed += 1;
      } catch (error) {
        errors.push(String(error).slice(0, 120));
      }
    }
    setCleanupResult(`Removed ${removed} worktree(s).${errors.length > 0 ? ` ${errors.length} error(s): ${errors[0]}` : ""}`);
    setCleaning(false);
    await inspectAll();
  };

  if (gitWorkspace === null) return null;
  return (
    <section className="settings-group" aria-label="Worktree tools">
      <h3>Worktrees</h3>
      {inWorktree && (
        <div className="worktree-setup">
          <p className="settings-note">
            One command prepares this worktree (dependencies, builds). It runs only
            when you click, is bounded to 2,000 characters and ten minutes, and
            never starts on its own.
          </p>
          <textarea
            value={setupCommand}
            onChange={(event) => saveSetupCommand(event.target.value.slice(0, 2000))}
            placeholder="e.g. npm install"
            rows={2}
            aria-label="Worktree setup command"
          />
          <div className="worktree-setup-actions">
            <button
              type="button"
              className="review-action"
              disabled={setupRunning || setupCommand.trim().length === 0}
              onClick={() => void runSetup()}
            >
              {setupRunning ? "Running setup…" : "Run setup"}
            </button>
            {setupRunning && activeToken !== null && (
              <button type="button" className="review-action" onClick={() => void cancelSetup()}>
                Cancel setup
              </button>
            )}
            <button
              type="button"
              className="review-action"
              disabled={setupRunning}
              onClick={() => void checkReadiness()}
            >
              Check readiness
            </button>
            <span className="muted">{setupCommand.length}/2000</span>
          </div>
          {setupOutcome && (
            <p className="settings-note" role="status">
              Setup {setupOutcome.status} in {(setupOutcome.durationMs / 1000).toFixed(1)}s
              {setupOutcome.exitCode !== null ? ` · exit ${setupOutcome.exitCode}` : ""}
              <pre className="worktree-setup-output">{setupOutcome.output.slice(-1200)}</pre>
            </p>
          )}
          {readiness && (
            <p className="settings-note" role="status">
              Readiness: <strong>{readiness.status}</strong>
              {readiness.projectFiles.length > 0
                ? ` · ${readiness.projectFiles.join(", ")}`
                : " · no project file detected"}
              {readiness.tools.map((tool) => (
                <span key={tool.name}>
                  {" "}
                  · {tool.name} {tool.available ? "available" : "missing"}
                </span>
              ))}
            </p>
          )}
        </div>
      )}
      <p className="settings-note">
        Inspect every worktree of {repoRoot ?? "this repository"} — real Git status,
        per-worktree age, and cleanup of the checkouts that are clean, not attached
        to a conversation and older than the retention you pick.
      </p>
      <div className="worktree-cleanup-actions">
        <button
          type="button"
          className="review-action"
          disabled={inspecting || cleaning}
          onClick={() => void inspectAll()}
        >
          {inspecting ? "Inspecting…" : "Inspect all"}
        </button>
        <select
          value={retentionDays === null ? "never" : String(retentionDays)}
          onChange={(event) => {
            const raw = event.target.value;
            const days = raw === "never" ? null : Number(raw);
            setRetentionDays(days);
            if (repoRoot !== null) {
              const map = readMap<number | null>(RETENTION_KEY);
              map[repoRoot] = days;
              writeMap(RETENTION_KEY, map);
            }
          }}
          aria-label="Worktree retention"
        >
          {RETENTION_CHOICES.map((choice) => (
            <option key={choice.label} value={choice.days === null ? "never" : String(choice.days)}>
              {choice.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="review-action"
          disabled={cleaning || inspecting || inspections === null}
          onClick={() => void cleanUp()}
          title="Removes clean, unattached worktrees older than the retention"
        >
          {cleaning ? "Cleaning…" : "Clean up"}
        </button>
      </div>
      {cleanupResult && (
        <p className="settings-note" role="status">
          {cleanupResult}
        </p>
      )}
      {inspections !== null && (
        <ul className="worktree-inspections">
          {inspections.map((inspection) => {
            const attached = attachedWorktree(gitWorkspace, inspection.path);
            return (
              <li key={inspection.path} className={inspection.isMain ? "worktree-main" : undefined}>
                <code>{inspection.path}</code>
                <span>
                  {inspection.isMain
                    ? "main checkout"
                    : `${inspection.branch ?? "(detached)"} · ${
                        inspection.conflicted ? "conflicted" : inspection.clean ? "clean" : "dirty"
                      } · ${ageLabel(inspection.modifiedAtMs)}`}
                  {attached && !inspection.isMain ? " · attached to a conversation" : ""}
                </span>
                {!inspection.isMain && (
                  <button
                    type="button"
                    onClick={() => void removeWorktree(inspection.path, !inspection.clean)}
                  >
                    {inspection.clean ? "Remove" : "Force remove"}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function attachedWorktree(activeWorkspace: string, path: string): boolean {
  // A worktree is attached when the active conversation itself runs in it —
  // other conversations are detected through the persisted session workspaces.
  const normalized = pathKey(path);
  if (pathKey(activeWorkspace) === normalized) return true;
  try {
    const sessions = JSON.parse(
      localStorage.getItem("muse-desktop.sessions.v1") || "[]",
    ) as Array<{ workspace?: string; host_workspace?: string }>;
    return sessions.some((session) =>
      [session.workspace, session.host_workspace].some(
        (candidate) => pathKey(candidate || "") === normalized,
      ),
    );
  } catch {
    return false;
  }
}
