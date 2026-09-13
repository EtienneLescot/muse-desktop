import { useState, type ChangeEvent } from "react";
import {
  diffProjectSettings,
  MAX_PROJECTS,
  threadsInProject,
  type Project,
  type ProjectSettings,
  type ThreadProjectMap,
} from "../lib/projects";

interface ProjectsPanelProps {
  projects: Project[];
  threadProjects: ThreadProjectMap;
  projectError: string | null;
  activeSessionId: string | null;
  globalSettings: ProjectSettings;
  onCreate: (name: string, instructions: string) => void;
  onDelete: (id: string) => void;
  onUpdate: (id: string, patch: { name?: string; instructions?: string }) => void;
  onAttach: (sessionId: string, projectId: string | null) => void;
  onSetGlobal: (patch: Partial<ProjectSettings>) => void;
  onSetOverride: (
    projectId: string,
    key: keyof ProjectSettings,
    value: ProjectSettings[keyof ProjectSettings] | undefined,
  ) => void;
  settingsFor: (projectId: string | null) => ProjectSettings;
}

const SETTING_KEYS: (keyof ProjectSettings)[] = [
  "model",
  "sandbox",
  "networkDefault",
  "autoCompact",
];

function formatSetting(key: keyof ProjectSettings, value: string | boolean): string {
  if (key === "autoCompact") return value === true ? "on" : "off";
  return String(value);
}

/**
 * US-3 + US-30 projects panel: create (max 5, client-side), per-project
 * instructions, thread attach/detach for the active thread, and the small
 * settings panel (global defaults + per-project overrides with diff).
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
  onSetGlobal,
  onSetOverride,
  settingsFor,
}: ProjectsPanelProps) {
  const [name, setName] = useState("");
  const [instructions, setInstructions] = useState("");

  function submit(): void {
    if (name.trim().length === 0) return;
    onCreate(name, instructions);
    setName("");
    setInstructions("");
  }

  return (
    <div className="projects-panel">
      <div className="session-list-header">
        <span>
          Projects ({projects.length}/{MAX_PROJECTS})
        </span>
      </div>
      <div className="project-create">
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="New project name"
          aria-label="New project name"
          maxLength={80}
        />
        <textarea
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
          placeholder="Instructions prepended to sent input (optional)"
          aria-label="New project instructions"
          rows={2}
        />
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
          {projectError}
        </p>
      )}
      {projects.length === 0 && (
        <p className="muted">No projects yet. Group threads and share instructions.</p>
      )}
      <ul className="project-items">
        {projects.map((p) => (
          <ProjectRow
            key={p.id}
            project={p}
            threadCount={threadsInProject(threadProjects, p.id).length}
            activeAttached={activeSessionId !== null && threadProjects[activeSessionId] === p.id}
            hasActiveThread={activeSessionId !== null}
            globalSettings={globalSettings}
            effective={settingsFor(p.id)}
            onDelete={() => onDelete(p.id)}
            onUpdate={(patch) => onUpdate(p.id, patch)}
            onAttachActive={() => {
              if (activeSessionId !== null) onAttach(activeSessionId, p.id);
            }}
            onDetachActive={() => {
              if (activeSessionId !== null) onAttach(activeSessionId, null);
            }}
            onSetOverride={(key, value) => onSetOverride(p.id, key, value)}
          />
        ))}
      </ul>
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
                onSetGlobal({ sandbox: e.target.value as ProjectSettings["sandbox"] })
              }
              aria-label="Global sandbox"
            >
              <option value="read-only">read-only</option>
              <option value="workspace">workspace</option>
              <option value="full">full</option>
            </select>
          </label>
          <label className="project-setting">
            <span>Network</span>
            <select
              value={globalSettings.networkDefault}
              onChange={(e) =>
                onSetGlobal({
                  networkDefault: e.target.value as ProjectSettings["networkDefault"],
                })
              }
              aria-label="Global network default"
            >
              <option value="allow">allow</option>
              <option value="prompt">prompt</option>
              <option value="deny">deny</option>
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
  onUpdate: (patch: { name?: string; instructions?: string }) => void;
  onAttachActive: () => void;
  onDetachActive: () => void;
  onSetOverride: (
    key: keyof ProjectSettings,
    value: ProjectSettings[keyof ProjectSettings] | undefined,
  ) => void;
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
  onAttachActive,
  onDetachActive,
  onSetOverride,
}: ProjectRowProps) {
  const [draftName, setDraftName] = useState(project.name);
  const [draftInstructions, setDraftInstructions] = useState(project.instructions);
  const diff = diffProjectSettings(globalSettings, project.settings);
  const dirty =
    draftName.trim() !== project.name || draftInstructions.trim() !== project.instructions;

  return (
    <li className="project-item">
      <details>
        <summary>
          <span className="project-name">{project.name}</span>
          <span className="muted">
            {threadCount} thread{threadCount === 1 ? "" : "s"}
          </span>
          {diff.length > 0 && (
            <span className="project-diff-flag" title="Has settings overrides">
              override
            </span>
          )}
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
          <label className="project-setting">
            <span>Instructions</span>
            <textarea
              value={draftInstructions}
              onChange={(e) => setDraftInstructions(e.target.value)}
              aria-label={`Instructions for project ${project.name}`}
              rows={2}
            />
          </label>
          <div className="project-actions">
            <button
              onClick={() =>
                onUpdate({ name: draftName, instructions: draftInstructions })
              }
              disabled={!dirty}
              title="Save name and instructions"
            >
              Save
            </button>
            {hasActiveThread &&
              (activeAttached ? (
                <button onClick={onDetachActive} title="Detach the active thread">
                  Detach thread
                </button>
              ) : (
                <button onClick={onAttachActive} title="Attach the active thread">
                  Attach thread
                </button>
              ))}
            <button
              onClick={onDelete}
              title={`Delete project ${project.name} (threads become ungrouped)`}
            >
              Del
            </button>
          </div>
          <div className="project-settings">
            <span className="muted">Overrides (inherit global unless set)</span>
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
            <p className="muted">Fully inherits global settings.</p>
          ) : (
            <ul className="project-diff" aria-label="Global versus project settings diff">
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
    } else {
      onSet(next as boolean);
    }
  }

  function onText(e: ChangeEvent<HTMLInputElement | HTMLSelectElement>): void {
    const v = e.target.type === "checkbox" && "checked" in e.target
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
        <option value="read-only">read-only</option>
        <option value="workspace">workspace</option>
        <option value="full">full</option>
      </select>
    ) : settingKey === "networkDefault" ? (
      <select
        value={String(effectiveValue)}
        onChange={onText}
        aria-label={`Project network (global ${globalValue})`}
      >
        <option value="allow">allow</option>
        <option value="prompt">prompt</option>
        <option value="deny">deny</option>
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
