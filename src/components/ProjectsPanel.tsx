import { useEffect, useState, type ChangeEvent } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import {
  diffProjectSettings,
  MAX_PROJECTS,
  projectWorkspaces,
  projectsNeedingWorkspace,
  threadsInProject,
  type Project,
  type ProjectSettings,
  type ThreadProjectMap,
  type WorkspaceRootObservation,
} from "../lib/projects";
import { userFacingError } from "../lib/errorCopy";
import {
  describeRules,
  formatRuleBytes,
  governingRule,
  ruleStatusLabel,
  type HarnessRules,
} from "../lib/harnessRules";
import {
  reasoningEffortChoices,
  isReasoningEffort,
  reasoningEffortLabel,
} from "../lib/reasoning";

interface ProjectsPanelProps {
  projects: Project[];
  threadProjects: ThreadProjectMap;
  projectError: string | null;
  activeSessionId: string | null;
  globalSettings: ProjectSettings;
  onCreate: (name: string, workspaces?: string[]) => void;
  onDelete: (id: string) => void;
  onUpdate: (
    id: string,
    patch: { name?: string; instructions?: string; workspace?: string; workspaces?: string[] },
  ) => void;
  onAttach: (sessionId: string, projectId: string | null) => void;
  onStartConversation: (project: Project, workspace?: string) => Promise<void>;
  onSetGlobal: (patch: Partial<ProjectSettings>) => void;
  onSetOverride: (
    projectId: string,
    key: keyof ProjectSettings,
    value: ProjectSettings[keyof ProjectSettings] | undefined,
  ) => void;
  settingsFor: (projectId: string | null) => ProjectSettings;
  onCheckWorkspace: (path: string) => Promise<WorkspaceRootObservation | null>;
  /**
   * Read-only: which rule files the CLI loads for a folder. Projects do not
   * own instructions — the folder does, and the host injects them — so the
   * panel shows what the backend reads instead of offering a second store.
   */
  onReadRules: (path: string) => Promise<HarnessRules | null>;
  /**
   * Hide the global-defaults editor: global settings live in the Settings
   * panel (sidebar footer). Per-project overrides stay — they are
   * project-scoped, not global.
   */
  hideGlobalSettings?: boolean;
}

const SETTING_KEYS: (keyof ProjectSettings)[] = [
  "model",
  "sandbox",
  "networkDefault",
  "autoCompact",
  "reasoningEffort",
];

function formatSetting(
  key: keyof ProjectSettings,
  value: string | boolean,
): string {
  if (key === "autoCompact") return value === true ? "on" : "off";
  // The inherited value is shown next to the override: naming the tier beats
  // echoing the wire spelling ("Very high" rather than "xhigh").
  if (key === "reasoningEffort" && isReasoningEffort(value)) {
    return reasoningEffortLabel(value);
  }
  return String(value);
}

/**
 * US-3 + US-30 projects panel: create (max 5, client-side), the folder's real
 * rules (read-only, as the CLI loads them), thread attach/detach for the active
 * thread, and the small settings panel (global defaults + per-project overrides
 * with diff).
 */
export function ProjectsPanel({
  projects,
  threadProjects,
  projectError,
  activeSessionId,
  globalSettings,
  onCreate,
  onDelete,
  onUpdate,
  onAttach,
  onStartConversation,
  onSetGlobal,
  onSetOverride,
  settingsFor,
  onCheckWorkspace,
  onReadRules,
  hideGlobalSettings = false,
}: ProjectsPanelProps) {
  const [name, setName] = useState("");
  const [workspacePaths, setWorkspacePaths] = useState<string[]>([]);
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const [migrationBusy, setMigrationBusy] = useState(false);
  const [migrationError, setMigrationError] = useState<string | null>(null);
  const [workspaceChecks, setWorkspaceChecks] = useState<Record<string, WorkspaceRootObservation>>({});
  const [checkingWorkspaceId, setCheckingWorkspaceId] = useState<string | null>(null);
  const projectsWithoutRoots = projectsNeedingWorkspace(projects);

  async function pickWorkspace(): Promise<void> {
    try {
      setWorkspaceError(null);
      if (!("__TAURI_INTERNALS__" in window)) {
        setWorkspaceError("The folder picker is available in the desktop app.");
        return;
      }
      const selected = await open({ directory: true, multiple: true });
      const picked = Array.isArray(selected)
        ? selected
        : typeof selected === "string" ? [selected] : [];
      if (picked.length > 0) {
        setWorkspacePaths((current) => Array.from(new Set([...current, ...picked.map((path) => path.trim()).filter(Boolean)])));
      }
    } catch (error) {
      setWorkspaceError(userFacingError(`folder picker failed: ${String(error)}`));
    }
  }

  async function migrateNextProject(): Promise<void> {
    const next = projectsNeedingWorkspace(projects)[0];
    if (!next || migrationBusy) return;
    setMigrationError(null);
    if (!("__TAURI_INTERNALS__" in window)) {
      setMigrationError("The guided folder migration is available in the desktop app.");
      return;
    }
    setMigrationBusy(true);
    try {
      const selected = await open({ directory: true, multiple: false });
      if (typeof selected === "string" && selected.trim().length > 0) {
        onUpdate(next.id, { workspace: selected });
      }
    } catch (error) {
      setMigrationError(userFacingError(`folder migration failed: ${String(error)}`));
    } finally {
      setMigrationBusy(false);
    }
  }

  async function checkProjectWorkspaces(project: Project, requestedRoots?: readonly string[]): Promise<void> {
    const roots = (requestedRoots ?? projectWorkspaces(project))
      .map((root) => root.trim())
      .filter((root, index, all) => root.length > 0 && all.indexOf(root) === index);
    if (roots.length === 0 || checkingWorkspaceId !== null) return;
    setCheckingWorkspaceId(project.id);
    try {
      for (const path of roots) {
        const observation = await onCheckWorkspace(path);
        if (observation !== null) {
          const key = `${project.id}:${path}`;
          setWorkspaceChecks((current) => ({ ...current, [key]: observation }));
        }
      }
    } finally {
      setCheckingWorkspaceId(null);
    }
  }

  function submit(): void {
    if (name.trim().length === 0) return;
    onCreate(name, workspacePaths.length > 0 ? workspacePaths : undefined);
    setName("");
    setWorkspacePaths([]);
  }

  return (
    <div className="projects-panel">
      <div className="session-list-header">
        <span>
          Projects ({projects.length}/{MAX_PROJECTS})
        </span>
      </div>
      {projectsWithoutRoots.length > 0 && (
        <section className="project-migration" aria-labelledby="project-migration-title">
          <div>
            <strong id="project-migration-title">
              {projectsWithoutRoots.length} project{projectsWithoutRoots.length === 1 ? "" : "s"} need a folder
            </strong>
            <p>
              These projects were created before project roots were saved. Choose a folder to make
              new conversations deterministic; existing conversation folders stay unchanged.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void migrateNextProject()}
            disabled={migrationBusy}
          >
            {migrationBusy ? "Choosing folder…" : "Choose next folder"}
          </button>
          {migrationError && <span className="project-migration-error" role="status">{migrationError}</span>}
        </section>
      )}
      <div className="project-create">
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Project name"
          aria-label="Project name"
          maxLength={80}
        />
        <div className="project-workspace-picker">
          <button type="button" onClick={() => void pickWorkspace()}>
            {workspacePaths.length > 0 ? "Add project folders" : "Choose project folders"}
          </button>
          <span title={workspacePaths.join("\n")}>
            {workspacePaths.length > 0
              ? `${workspacePaths.length} folder${workspacePaths.length === 1 ? "" : "s"} selected`
              : "No project folder (uses default)"}
          </span>
          {workspacePaths.length > 0 && (
            <button type="button" onClick={() => setWorkspacePaths([])}>Clear</button>
          )}
        </div>
        {workspaceError && <p className="project-error" role="alert">{workspaceError}</p>}
        <button
          onClick={submit}
          disabled={name.trim().length === 0 || projects.length >= MAX_PROJECTS}
          title={
            projects.length >= MAX_PROJECTS
              ? "Project quota reached"
              : "Create project"
          }
        >
          + Add project
        </button>
      </div>
      {projectError !== null && (
        <p className="project-error" role="alert">
          {userFacingError(projectError)}
        </p>
      )}
      {projects.length === 0 && (
        <p className="muted">
          No projects yet. Group your conversations and give them a folder and
          preferences.
        </p>
      )}
      <ul className="project-items">
        {projects.map((p) => (
          <ProjectRow
            key={p.id}
            project={p}
            threadCount={threadsInProject(threadProjects, p.id).length}
            activeAttached={
              activeSessionId !== null &&
              threadProjects[activeSessionId] === p.id
            }
            hasActiveThread={activeSessionId !== null}
            globalSettings={globalSettings}
            effective={settingsFor(p.id)}
            onDelete={() => onDelete(p.id)}
            onUpdate={(patch) => onUpdate(p.id, patch)}
            onStartConversation={(workspace) => onStartConversation(p, workspace)}
            onAttachActive={() => {
              if (activeSessionId !== null) onAttach(activeSessionId, p.id);
            }}
            onDetachActive={() => {
              if (activeSessionId !== null) onAttach(activeSessionId, null);
            }}
            onSetOverride={(key, value) => onSetOverride(p.id, key, value)}
            checkingWorkspace={checkingWorkspaceId === p.id}
            onCheckWorkspace={(paths) => void checkProjectWorkspaces(p, paths)}
            onReadRules={onReadRules}
            workspaceObservations={Object.fromEntries(
              projectWorkspaces(p).map((root) => [root, workspaceChecks[`${p.id}:${root}`]]),
            )}
          />
        ))}
      </ul>
      {!hideGlobalSettings && (
        <details className="project-global">
          <summary>Global settings (project defaults)</summary>
          <div className="project-settings">
            <label className="project-setting">
              <span>Model</span>
              <input
                type="text"
                value={globalSettings.model}
                onChange={(e) => onSetGlobal({ model: e.target.value })}
                aria-label="Global model"
              />
            </label>
            <label className="project-setting">
              <span>Sandbox</span>
              <select
                value={globalSettings.sandbox}
                onChange={(e) =>
                  onSetGlobal({
                    sandbox: e.target.value as ProjectSettings["sandbox"],
                  })
                }
                aria-label="Global sandbox"
              >
                <option value="read-only">Read only</option>
                <option value="workspace">Project</option>
                <option value="full">Full access</option>
              </select>
            </label>
            <label className="project-setting">
              <span>Network</span>
              <select
                value={globalSettings.networkDefault}
                onChange={(e) =>
                  onSetGlobal({
                    networkDefault: e.target
                      .value as ProjectSettings["networkDefault"],
                  })
                }
                aria-label="Global network default"
              >
                <option value="allow">Allow</option>
                <option value="prompt">Ask</option>
                <option value="deny">Deny</option>
              </select>
            </label>
            <label className="project-setting">
              <span>Auto-compact</span>
              <input
                type="checkbox"
                checked={globalSettings.autoCompact}
                onChange={(e) => onSetGlobal({ autoCompact: e.target.checked })}
                aria-label="Global auto-compact"
              />
            </label>
          </div>
        </details>
      )}
    </div>
  );
}

interface ProjectRowProps {
  project: Project;
  threadCount: number;
  activeAttached: boolean;
  hasActiveThread: boolean;
  globalSettings: ProjectSettings;
  effective: ProjectSettings;
  onDelete: () => void;
  onUpdate: (patch: { name?: string; instructions?: string; workspace?: string; workspaces?: string[] }) => void;
  onStartConversation: (workspace?: string) => Promise<void>;
  onAttachActive: () => void;
  onDetachActive: () => void;
  onSetOverride: (
    key: keyof ProjectSettings,
    value: ProjectSettings[keyof ProjectSettings] | undefined,
  ) => void;
  workspaceObservations: Readonly<Record<string, WorkspaceRootObservation | undefined>>;
  checkingWorkspace: boolean;
  onCheckWorkspace: (paths: string[]) => void;
  onReadRules: (path: string) => Promise<HarnessRules | null>;
}

function ProjectRow({
  project,
  threadCount,
  activeAttached,
  hasActiveThread,
  globalSettings,
  effective,
  onDelete,
  onUpdate,
  onStartConversation,
  onAttachActive,
  onDetachActive,
  onSetOverride,
  workspaceObservations,
  checkingWorkspace,
  onCheckWorkspace,
  onReadRules,
}: ProjectRowProps) {
  const [draftName, setDraftName] = useState(project.name);
  const [draftWorkspaces, setDraftWorkspaces] = useState(() => projectWorkspaces(project));
  const [selectedWorkspace, setSelectedWorkspace] = useState(() => projectWorkspaces(project)[0] ?? "");
  const [rules, setRules] = useState<HarnessRules | null>(null);
  const [rulesError, setRulesError] = useState<string | null>(null);
  const [readingRules, setReadingRules] = useState(false);
  const [copiedLegacy, setCopiedLegacy] = useState(false);
  useEffect(() => {
    const roots = projectWorkspaces(project);
    setDraftWorkspaces(roots);
    setSelectedWorkspace((current) => roots.includes(current) ? current : roots[0] ?? "");
  }, [project.id, project.workspace, project.workspaces?.join("\u0000")]);
  const diff = diffProjectSettings(globalSettings, project.settings);
  const dirty =
    draftName.trim() !== project.name ||
    JSON.stringify(draftWorkspaces) !== JSON.stringify(projectWorkspaces(project));
  const hasWorkspace = draftWorkspaces.length > 0;
  const rulesRoot = draftWorkspaces[0] ?? "";
  const governing = governingRule(rules);
  const legacyInstructions = (project.instructions ?? "").trim();

  async function readRules(): Promise<void> {
    if (rulesRoot.length === 0 || readingRules) return;
    setReadingRules(true);
    setRulesError(null);
    try {
      const read = await onReadRules(rulesRoot);
      if (read === null) {
        setRulesError("The rules could not be read from this folder.");
        return;
      }
      setRules(read);
    } catch (error) {
      setRulesError(userFacingError(error));
    } finally {
      setReadingRules(false);
    }
  }

  return (
    <li className={`project-item${hasWorkspace ? "" : " project-item-unrooted"}`}>
      <details
        onToggle={(event) => {
          // Reading on first open keeps the panel free of one native call per
          // project on mount, and the answer is only useful once it is visible.
          if (event.currentTarget.open && rules === null && !readingRules) void readRules();
        }}
      >
        <summary>
          <span className="project-name">{project.name}</span>
          <span className="muted">
            {threadCount} conversation{threadCount === 1 ? "" : "s"}
          </span>
          {diff.length > 0 && (
            <span className="project-diff-flag" title="Has settings overrides">
              override
            </span>
          )}
          {!hasWorkspace && <span className="project-root-flag">folder needed</span>}
        </summary>
        <div className="project-detail">
          <label className="project-setting">
            <span>Name</span>
            <input
              type="text"
              value={draftName}
              onChange={(e) => setDraftName(e.target.value)}
              aria-label={`Rename project ${project.name}`}
              maxLength={80}
            />
          </label>
          {legacyInstructions.length > 0 && (
            <div className="project-legacy-instructions" role="status">
              <strong>This project still has client-side instructions</strong>
              <p>
                They used to be prepended to every request. The agent's
                instructions are the rules of the folder it runs in, read by the
                CLI itself, so these are no longer sent anywhere. Copy them into
                the folder's <code>AGENTS.md</code> if you still want them.
              </p>
              <pre>{legacyInstructions}</pre>
              <div className="project-legacy-actions">
                <button
                  type="button"
                  onClick={() => {
                    void navigator.clipboard?.writeText(legacyInstructions).then(
                      () => setCopiedLegacy(true),
                      () => setCopiedLegacy(false),
                    );
                  }}
                >
                  {copiedLegacy ? "Copied" : "Copy"}
                </button>
                <button
                  type="button"
                  onClick={() => onUpdate({ instructions: "" })}
                  title="Forget these instructions for good"
                >
                  Dismiss
                </button>
              </div>
            </div>
          )}
          <div className="project-setting project-rules-setting">
            <span>Rules</span>
            <div className="project-rules-body">
            {rulesRoot.length === 0 ? (
              <p className="muted">
                Rules live in the folder the CLI runs in. Choose a folder to see
                which files would be loaded.
              </p>
            ) : readingRules ? (
              <p className="muted" role="status">Reading rules…</p>
            ) : rulesError !== null ? (
              <p className="project-error" role="alert">{rulesError}</p>
            ) : rules === null ? (
              <button type="button" onClick={() => void readRules()}>Check rules</button>
            ) : (
              <>
                <p className="project-rules-summary" role="status">{describeRules(rules)}</p>
                <ul className="project-rule-list" aria-label={`Rules for ${project.name}`}>
                  {rules.files.map((file) => (
                    <li key={file.id} className={`project-rule-row project-rule-${file.status}`}>
                      <span className="project-rule-name">{file.name}</span>
                      <span className="project-rule-scope">
                        {file.scope === "project" ? "folder" : "personal"}
                      </span>
                      <span className="project-rule-status">{ruleStatusLabel(file.status)}</span>
                      {file.present && (
                        <span className="muted">{formatRuleBytes(file.bytes)}</span>
                      )}
                      <small className="project-rule-detail">
                        {/* The path, not just the file name: two rows named
                            AGENTS.md with different scopes are otherwise
                            indistinguishable. */}
                        <code className="project-rule-path" title={file.path}>{file.path}</code>{" "}
                        {file.detail}
                      </small>
                    </li>
                  ))}
                </ul>
                {governing !== null && governing.preview.trim().length > 0 && (
                  <details className="project-rule-preview">
                    <summary>Show what the agent reads</summary>
                    <pre>{governing.preview}{governing.truncated ? "\n…" : ""}</pre>
                    <small>{governing.path}</small>
                  </details>
                )}
                <button type="button" onClick={() => void readRules()} disabled={readingRules}>
                  Refresh rules
                </button>
              </>
            )}
            </div>
          </div>
          <div className="project-setting project-workspace-setting">
            <span>Folders</span>
            <ul className="workspace-root-list" aria-label={`Folders for project ${project.name}`}>
              {draftWorkspaces.length === 0 && <li className="workspace-path">No project folder (uses default)</li>}
            {draftWorkspaces.map((root, index) => {
              const observation = workspaceObservations[root];
              return (
                <li className="workspace-root-row" key={`${root}-${index}`}>
                  <span className="workspace-path" title={root}>{root}</span>
                  {observation && (
                    <span
                      className={`workspace-health workspace-health-${observation.exists && observation.isDirectory ? "ready" : "missing"}`}
                      role="status"
                      title={observation.reason}
                    >
                      {observation.exists
                        ? observation.isDirectory
                          ? "Available"
                          : "Not a folder"
                        : "Missing"}
                    </span>
                  )}
                  <button type="button" onClick={() => setDraftWorkspaces((current) => current.filter((_, i) => i !== index))}>
                    Remove
                  </button>
                </li>
              );
            })}
            </ul>
            <button
              type="button"
              onClick={async () => {
                try {
                  if (!("__TAURI_INTERNALS__" in window)) return;
                  const selected = await open({ directory: true, multiple: true });
                  const picked = Array.isArray(selected)
                    ? selected
                    : typeof selected === "string" ? [selected] : [];
                  if (picked.length > 0) {
                    setDraftWorkspaces((current) => Array.from(new Set([...current, ...picked.map((path) => path.trim()).filter(Boolean)])));
                  }
                } catch {
                  // Keep the current value when the native picker is cancelled or unavailable.
                }
              }}
            >
              {draftWorkspaces.length > 0 ? "Add folder" : "Choose folders"}
            </button>
            {draftWorkspaces.length > 0 && (
              <button type="button" onClick={() => setDraftWorkspaces([])}>Clear all</button>
            )}
            {hasWorkspace && (
              <button type="button" onClick={() => onCheckWorkspace(draftWorkspaces)} disabled={checkingWorkspace}>
                {checkingWorkspace ? "Checking folders…" : "Check folders"}
              </button>
            )}
          </div>
          <div className="project-actions">
            <button
              onClick={() =>
                onUpdate({
                  name: draftName,
                  workspaces: draftWorkspaces,
                })
              }
              disabled={!dirty}
              title="Save project details"
            >
              Save
            </button>
            {hasWorkspace && (
              <>
                <label className="project-start-root">
                  <span>Start in</span>
                  <select
                    value={selectedWorkspace}
                    onChange={(event) => setSelectedWorkspace(event.target.value)}
                    aria-label={`Conversation folder for ${project.name}`}
                  >
                    {draftWorkspaces.map((root) => (
                      <option key={root} value={root}>{root}</option>
                    ))}
                  </select>
                </label>
              <button
                onClick={() => void onStartConversation(selectedWorkspace)}
                disabled={dirty}
                title="Start a conversation in this project folder"
              >
                New conversation here
              </button>
              </>
            )}
            {hasActiveThread &&
              (activeAttached ? (
                <button
                  onClick={onDetachActive}
                  title="Detach the active conversation from this project"
                >
                  Detach conversation
                </button>
              ) : (
                <button
                  onClick={onAttachActive}
                  title="Attach the active conversation to this project"
                >
                  Attach conversation
                </button>
              ))}
            <button
              onClick={onDelete}
              title={`Delete project ${project.name} (threads become ungrouped)`}
            >
              Delete project
            </button>
          </div>
          <div className="project-settings">
            <span className="muted">Project preferences</span>
            {SETTING_KEYS.map((key) => (
              <OverrideRow
                key={key}
                settingKey={key}
                globalValue={globalSettings[key]}
                overrideValue={project.settings?.[key]}
                effectiveValue={effective[key]}
                onSet={(value) => onSetOverride(key, value)}
              />
            ))}
          </div>
          {diff.length === 0 ? (
            <p className="muted">This project inherits the global preferences.</p>
          ) : (
            <ul
              className="project-diff"
              aria-label="Global versus project settings diff"
            >
              {diff.map((d) => (
                <li key={d.key}>
                  {d.key}: {formatSetting(d.key, d.global)} →{" "}
                  {formatSetting(d.key, d.project)}
                </li>
              ))}
            </ul>
          )}
        </div>
      </details>
    </li>
  );
}

interface OverrideRowProps {
  settingKey: keyof ProjectSettings;
  globalValue: string | boolean;
  overrideValue: string | boolean | undefined;
  effectiveValue: string | boolean;
  onSet: (value: ProjectSettings[keyof ProjectSettings] | undefined) => void;
}

function OverrideRow({
  settingKey,
  globalValue,
  overrideValue,
  effectiveValue,
  onSet,
}: OverrideRowProps) {
  function commit(next: string | boolean): void {
    // Editing back to the global value clears the override (inherits).
    if (next === globalValue) {
      onSet(undefined);
    } else if (settingKey === "model") {
      onSet(next as string);
    } else if (settingKey === "sandbox") {
      onSet(next as ProjectSettings["sandbox"]);
    } else if (settingKey === "networkDefault") {
      onSet(next as ProjectSettings["networkDefault"]);
    } else if (settingKey === "reasoningEffort") {
      onSet(next as ProjectSettings["reasoningEffort"]);
    } else {
      onSet(next as boolean);
    }
  }

  function onText(e: ChangeEvent<HTMLInputElement | HTMLSelectElement>): void {
    const v =
      e.target.type === "checkbox" && "checked" in e.target
        ? (e.target as HTMLInputElement).checked
        : e.target.value;
    commit(v);
  }

  const editor =
    settingKey === "model" ? (
      <input
        type="text"
        value={String(effectiveValue)}
        onChange={onText}
        aria-label={`Project model (global ${globalValue})`}
      />
    ) : settingKey === "sandbox" ? (
      <select
        value={String(effectiveValue)}
        onChange={onText}
        aria-label={`Project sandbox (global ${globalValue})`}
      >
        <option value="read-only">Read only</option>
        <option value="workspace">Project</option>
        <option value="full">Full access</option>
      </select>
    ) : settingKey === "networkDefault" ? (
      <select
        value={String(effectiveValue)}
        onChange={onText}
        aria-label={`Project network (global ${globalValue})`}
      >
        <option value="allow">Allow</option>
        <option value="prompt">Ask</option>
        <option value="deny">Deny</option>
      </select>
    ) : settingKey === "reasoningEffort" ? (
      <select
        value={String(effectiveValue)}
        onChange={onText}
        aria-label={`Project reasoning effort (global ${globalValue})`}
      >
        {/* Driven by the shared list: a hand-written copy of it here is how
            the picker lost `max` in the first place. A persisted value that is
            no longer offered (wire-only `none`) is kept listed. */}
        {reasoningEffortChoices(isReasoningEffort(effectiveValue) ? effectiveValue : undefined).map(
          (effort) => (
            <option key={effort} value={effort}>
              {reasoningEffortLabel(effort)}
            </option>
          ),
        )}
      </select>
    ) : (
      <input
        type="checkbox"
        checked={effectiveValue === true}
        onChange={onText}
        aria-label={`Project auto-compact (global ${formatSetting(settingKey, globalValue)})`}
      />
    );

  return (
    <label className="project-setting">
      <span>
        {settingKey}
        <small> g:{formatSetting(settingKey, globalValue)}</small>
      </span>
      {editor}
      {overrideValue !== undefined && (
        <button
          type="button"
          onClick={() => onSet(undefined)}
          title="Clear override and inherit the global value"
        >
          Inherit
        </button>
      )}
    </label>
  );
}
