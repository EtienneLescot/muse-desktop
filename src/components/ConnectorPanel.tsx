import { useState } from "react";
import {
  CURATED_CONNECTORS,
  localConnectorIdForName,
  type ConnectorEntry,
  type ConnectorTool,
  type LocalMcpCallResult,
  type LocalMcpProbeResult,
} from "../lib/connectors";
import { CapabilityBadge } from "./CapabilityBadge";

interface Props {
  installed: ConnectorEntry[];
  /** Hot-listed tool names (re-read from the registry, no restart). */
  toolNames: string[];
  /** Last remote-guard message (single-remote / VPN failure), if any. */
  remoteNotice: string | null;
  onInstall: (dirId: string) => void;
  onUninstall: (id: string) => void;
  onToggle: (id: string, enabled: boolean) => void;
  /** Returns false when the guard refused (message lands in remoteNotice). */
  onAddRemote: (name: string, url: string) => boolean;
  /** Probe an explicit local MCP stdio command. */
  onProbeLocal: (command: string) => Promise<LocalMcpProbeResult | null>;
  /** Call one tool on the probed local MCP command. */
  onCallLocal: (
    command: string,
    toolName: string,
    argumentsText: string,
  ) => Promise<LocalMcpCallResult | null>;
  onRegisterLocal: (
    name: string,
    command: string,
    tools: ConnectorTool[],
    serverVersion?: string,
  ) => boolean;
  /** Re-probe and persist tools for an existing local MCP connector. */
  onRefreshLocal: (id: string) => Promise<LocalMcpProbeResult | null>;
  /** Restore the previous verified local tool catalog. */
  onRollbackLocal: (id: string) => boolean;
  /** Currently running persistent local MCP process ids. */
  mcpRunningIds: string[];
  /** Start/stop a configured local MCP process explicitly. */
  onStartLocal: (id: string) => Promise<LocalMcpProbeResult | null>;
  onStopLocal: (id: string) => Promise<boolean>;
  /** Call a tool through a running persistent local MCP process. */
  onCallRegisteredLocal: (
    id: string,
    toolName: string,
    argumentsText: string,
  ) => Promise<LocalMcpCallResult | null>;
  workspace: string | null;
}

/**
 * US-24 connector directory + US-26 remote guard.
 *
 * - Curated local connectors install in 1 click (no manual JSON).
 * - Installed entries list their tools live (hot-list, no restart).
 * - Remote endpoints go through the single-remote + public-internet
 *   guard; refusals explain themselves (incl. the VPN failure message).
 */
export function ConnectorPanel({
  installed,
  toolNames,
  remoteNotice,
  onInstall,
  onUninstall,
  onToggle,
  onAddRemote,
  onProbeLocal,
  onCallLocal,
  onRegisterLocal,
  onRefreshLocal,
  onRollbackLocal,
  mcpRunningIds,
  onStartLocal,
  onStopLocal,
  onCallRegisteredLocal,
  workspace,
}: Props) {
  const [remoteName, setRemoteName] = useState("");
  const [remoteUrl, setRemoteUrl] = useState("");
  const [localName, setLocalName] = useState("");
  const [localCommand, setLocalCommand] = useState("");
  const [localProbe, setLocalProbe] = useState<LocalMcpProbeResult | null>(null);
  const [localCall, setLocalCall] = useState<LocalMcpCallResult | null>(null);
  const [localSaved, setLocalSaved] = useState(false);
  const [localBusy, setLocalBusy] = useState<"probe" | "call" | null>(null);
  const [localTool, setLocalTool] = useState("");
  const [localArgs, setLocalArgs] = useState("{}");
  const [localConnectorId, setLocalConnectorId] = useState<string | null>(null);
  const [refreshingId, setRefreshingId] = useState<string | null>(null);
  const [refreshAction, setRefreshAction] = useState<"start" | "stop" | "refresh" | null>(null);
  const [refreshFeedback, setRefreshFeedback] = useState<{
    id: string;
    message: string;
    tone: "success" | "error";
  } | null>(null);
  const installedIds = new Set(installed.map((e) => e.id));

  return (
    <section className="integration-panel" aria-label="Connectors">
      <h3>Connectors</h3>
      <p className="muted">
        <CapabilityBadge
          status="local"
          reason="The curated catalog is local; explicit local MCP probes use the real stdio handshake."
        />{" "}
        Curated catalog plus an explicit local MCP probe.
      </p>
      <section className="local-mcp" aria-label="Local MCP server">
        <h4>Local MCP server</h4>
        <p className="muted">
          Enter a command to initialize and list tools. It runs only after you
          click Probe, from the selected workspace.
        </p>
        <form
          className="integration-form"
          onSubmit={async (event) => {
            event.preventDefault();
            if (!localCommand.trim() || localBusy !== null) return;
            setLocalBusy("probe");
            setLocalCall(null);
            const result = await onProbeLocal(localCommand);
            setLocalProbe(result);
            setLocalTool(result?.tools[0]?.name ?? "");
            setLocalConnectorId(null);
            setLocalSaved(false);
            setLocalBusy(null);
          }}
        >
          <input
            type="text"
            value={localName}
            onChange={(event) => {
              setLocalName(event.target.value);
              setLocalSaved(false);
              setLocalConnectorId(null);
            }}
            placeholder="Server name"
            aria-label="Local MCP server name"
            maxLength={120}
          />
          <input
            type="text"
            value={localCommand}
            onChange={(event) => {
              setLocalCommand(event.target.value);
              setLocalSaved(false);
              setLocalConnectorId(null);
            }}
            placeholder="node ./my-mcp-server.js"
            aria-label="Local MCP command"
            spellCheck={false}
            maxLength={2000}
          />
          <button type="submit" disabled={!localCommand.trim() || localBusy !== null}>
            {localBusy === "probe" ? "Probing…" : "Probe"}
          </button>
        </form>
        <small className="muted">Workspace: {workspace ?? "none selected"}</small>
        {localProbe && (
          <div className="local-mcp-result">
            <p className="integration-notice" role="status">
              Connected to {localProbe.serverName} {localProbe.serverVersion} · {localProbe.tools.length} tool(s) · {localProbe.durationMs} ms
            </p>
            {localProbe.tools.length > 0 && (
              <>
                <button
                  type="button"
                  disabled={!localName.trim() || localSaved}
                  onClick={() => {
                    const saved = onRegisterLocal(
                      localName,
                      localCommand,
                      localProbe.tools,
                      localProbe.serverVersion,
                    );
                    if (saved) {
                      setLocalSaved(true);
                      setLocalConnectorId(localConnectorIdForName(localName));
                    }
                  }}
                >
                  {localSaved ? "Saved" : "Save connector"}
                </button>
                <label>
                  Tool
                  <select value={localTool} onChange={(event) => setLocalTool(event.target.value)}>
                    {localProbe.tools.map((tool) => (
                      <option key={tool.name} value={tool.name}>{tool.name}</option>
                    ))}
                  </select>
                </label>
                <label>
                  Arguments (JSON)
                  <textarea value={localArgs} onChange={(event) => setLocalArgs(event.target.value)} rows={3} spellCheck={false} />
                </label>
                <button
                  type="button"
                  disabled={!localTool || localBusy !== null}
                  onClick={async () => {
                    setLocalBusy("call");
                    const result =
                      localConnectorId !== null && mcpRunningIds.includes(localConnectorId)
                        ? await onCallRegisteredLocal(localConnectorId, localTool, localArgs)
                        : await onCallLocal(localCommand, localTool, localArgs);
                    setLocalCall(result);
                    setLocalBusy(null);
                  }}
                >
                  {localBusy === "call" ? "Calling…" : "Call tool"}
                </button>
                {localCall && (
                  <pre className="local-mcp-output">{JSON.stringify(localCall.result, null, 2)}</pre>
                )}
              </>
            )}
          </div>
        )}
      </section>
      <ul className="integration-list">
        {CURATED_CONNECTORS.map((c) => {
          const done = installedIds.has(c.id);
          return (
            <li key={c.id} className="integration-row">
              <span className="integration-main">
                <strong>{c.name}</strong>
                <small>{c.description}</small>
                <small className="muted">
                  {c.tools.map((t) => t.name).join(" · ")}
                </small>
              </span>
              {done ? (
                <span className="integration-flag">configured</span>
              ) : (
                <button type="button" onClick={() => onInstall(c.id)}>
                  Add
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {installed.length > 0 && (
        <>
          <h4>
            Configured
            {toolNames.length > 0 && ` — ${toolNames.length} tool(s)`}
          </h4>
          <ul className="integration-list">
            {installed.map((e) => (
              <li key={e.id} className="integration-row">
                <span className="integration-main">
                  <strong>
                    {e.name}
                    {e.kind === "remote" && <small> (remote)</small>}
                  </strong>
                  <small className="muted">
                    {e.status === "disabled"
                      ? "disabled"
                      : e.tools.length > 0
                        ? e.tools.map((t) => t.name).join(" · ")
                        : (e.guardMessage ?? "no tools listed")}
                  </small>
                  {e.kind === "local" && e.serverVersion && (
                    <small className="muted">Server v{e.serverVersion}</small>
                  )}
                </span>
                <label
                  className="integration-toggle"
                  title={e.status === "disabled" ? "Enable" : "Disable"}
                >
                  <input
                    type="checkbox"
                    checked={e.status !== "disabled"}
                    onChange={(ev) => onToggle(e.id, ev.target.checked)}
                  />
                </label>
                {e.kind === "local" && e.command && (
                  <>
                    <button
                      type="button"
                      className="integration-action"
                      disabled={refreshingId !== null}
                      onClick={async () => {
                        setRefreshingId(e.id);
                        setRefreshAction(mcpRunningIds.includes(e.id) ? "stop" : "start");
                        setRefreshFeedback(null);
                        if (mcpRunningIds.includes(e.id)) {
                          const stopped = await onStopLocal(e.id);
                          setRefreshFeedback({
                            id: e.id,
                            tone: stopped ? "success" : "error",
                            message: stopped
                              ? "Persistent server stopped."
                              : "Stop failed; the server may still be running.",
                          });
                        } else {
                          const result = await onStartLocal(e.id);
                          if (result !== null && localConnectorId === e.id) {
                            setLocalProbe(result);
                            setLocalTool((current) =>
                              result.tools.some((tool) => tool.name === current)
                                ? current
                                : result.tools[0]?.name ?? "",
                            );
                          }
                          if (result === null) {
                            setRefreshFeedback({
                              id: e.id,
                              tone: "error",
                              message: "Start failed. Check the command and workspace.",
                            });
                          } else if (result.tools.length === 0) {
                            setRefreshFeedback({
                              id: e.id,
                              tone: "error",
                              message: "The server started but returned no tools.",
                            });
                          } else {
                            setRefreshFeedback({
                              id: e.id,
                              tone: "success",
                              message: `Persistent server running · ${result.tools.length} tools`,
                            });
                          }
                        }
                        setRefreshingId(null);
                        setRefreshAction(null);
                      }}
                    >
                      {refreshingId === e.id
                        ? refreshAction === "stop"
                          ? "Stopping…"
                          : "Starting…"
                        : mcpRunningIds.includes(e.id)
                          ? "Stop server"
                          : "Start server"}
                    </button>
                    <button
                      type="button"
                      className="integration-action"
                      disabled={refreshingId !== null}
                      onClick={async () => {
                        setRefreshingId(e.id);
                        setRefreshAction("refresh");
                        setRefreshFeedback(null);
                        const result = await onRefreshLocal(e.id);
                        if (result !== null && localConnectorId === e.id) {
                          setLocalProbe(result);
                          setLocalTool((current) =>
                            result.tools.some((tool) => tool.name === current)
                              ? current
                              : result.tools[0]?.name ?? "",
                          );
                        }
                        if (result === null) {
                          setRefreshFeedback({
                            id: e.id,
                            tone: "error",
                            message: "Refresh failed. The previous tool list was kept.",
                          });
                        } else if (result.tools.length === 0) {
                          setRefreshFeedback({
                            id: e.id,
                            tone: "error",
                            message: "The server returned no tools. The previous list was kept.",
                          });
                        } else {
                          setRefreshFeedback({
                            id: e.id,
                            tone: "success",
                            message: `Tools refreshed · ${result.tools.length} discovered · ${result.durationMs} ms`,
                          });
                        }
                        setRefreshingId(null);
                        setRefreshAction(null);
                      }}
                    >
                      {refreshingId === e.id ? "Refreshing…" : "Refresh tools"}
                    </button>
                    {e.previousTools && e.previousTools.length > 0 && (
                      <button
                        type="button"
                        className="integration-action"
                        disabled={refreshingId !== null}
                        onClick={() => {
                          const rolledBack = onRollbackLocal(e.id);
                          setRefreshFeedback({
                            id: e.id,
                            tone: rolledBack ? "success" : "error",
                            message: rolledBack
                              ? "Previous tool catalog restored."
                              : "Rollback unavailable; the current catalog was kept.",
                          });
                        }}
                      >
                        Roll back
                      </button>
                    )}
                  </>
                )}
                <button type="button" onClick={() => onUninstall(e.id)}>
                  Remove
                </button>
                {refreshFeedback?.id === e.id && (
                  <small
                    className={`integration-refresh-feedback ${refreshFeedback.tone}`}
                    role="status"
                  >
                    {refreshFeedback.message}
                  </small>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
      <h4>Remote connector (one maximum)</h4>
      <form
        className="integration-form"
        onSubmit={(ev) => {
          ev.preventDefault();
          if (remoteName.trim().length === 0 || remoteUrl.trim().length === 0)
            return;
          if (onAddRemote(remoteName.trim(), remoteUrl.trim())) {
            setRemoteName("");
            setRemoteUrl("");
          }
        }}
      >
        <input
          type="text"
          placeholder="Name"
          aria-label="Remote connector name"
          value={remoteName}
          onChange={(ev) => setRemoteName(ev.target.value)}
        />
        <input
          type="url"
          placeholder="https://…"
          aria-label="Public HTTPS connector URL"
          value={remoteUrl}
          onChange={(ev) => setRemoteUrl(ev.target.value)}
        />
        <button type="submit">Add</button>
      </form>
      {remoteNotice !== null && (
        <p className="integration-notice" role="status">
          {remoteNotice}
        </p>
      )}
    </section>
  );
}
