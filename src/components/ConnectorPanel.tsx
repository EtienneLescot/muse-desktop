import { useState } from "react";
import {
  CURATED_CONNECTORS,
  localConnectorIdForName,
  type ConnectorEntry,
  type ConnectorTool,
  type LocalMcpCallResult,
  type LocalMcpProbeResult,
} from "../lib/connectors";
import type { RemoteMcpCallResult, RemoteMcpProbeResult } from "../lib/remoteMcp.ts";
import {
  authorizationModeLabel,
  connectorCallRequiresApproval,
  type AuthorizationMode,
} from "../lib/authorization";
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
  /** Opt a verified connector into new Muse session startup config. */
  onUseInMuse: (id: string, enabled: boolean) => void;
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
  /** Install a local MCP Bundle and verify its server before registering it. */
  onInstallPackage: (file: File) => Promise<boolean>;
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
  /** M3-02: real remote initialize + tools/list exchange. */
  onProbeRemote: (
    name: string,
    url: string,
    token?: string,
  ) => Promise<RemoteMcpProbeResult | null>;
  /** M3-02: call a tool on an authenticated in-memory remote session. */
  onCallRemote: (
    id: string,
    toolName: string,
    argumentsText: string,
  ) => Promise<RemoteMcpCallResult | null>;
  remoteConnectedIds: string[];
  onDisconnectRemote: (id: string) => void;
  onForgetRemoteCredential: (id: string) => Promise<void>;
  authorizationMode: AuthorizationMode;
  workspace: string | null;
  /** Active conversation that can explicitly be reconnected with this config. */
  activeSessionId?: string | null;
  canReconnectActive?: boolean;
  onReconnectActive?: (sessionId: string) => Promise<void>;
}

type PendingConnectorCall =
  | {
      transport: "local";
      command: string;
      connectorId: string | null;
      toolName: string;
      argumentsText: string;
    }
  | {
      transport: "remote";
      connectorId: string;
      toolName: string;
      argumentsText: string;
    };

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
  onUseInMuse,
  onProbeLocal,
  onCallLocal,
  onRegisterLocal,
  onInstallPackage,
  onRefreshLocal,
  onRollbackLocal,
  mcpRunningIds,
  onStartLocal,
  onStopLocal,
  onCallRegisteredLocal,
  onProbeRemote,
  onCallRemote,
  remoteConnectedIds,
  onDisconnectRemote,
  onForgetRemoteCredential,
  authorizationMode,
  workspace,
  activeSessionId = null,
  canReconnectActive = false,
  onReconnectActive,
}: Props) {
  const [remoteName, setRemoteName] = useState("");
  const [remoteUrl, setRemoteUrl] = useState("");
  const [remoteToken, setRemoteToken] = useState("");
  const [remoteProbe, setRemoteProbe] = useState<RemoteMcpProbeResult | null>(null);
  const [remoteCall, setRemoteCall] = useState<RemoteMcpCallResult | null>(null);
  const [remoteTool, setRemoteTool] = useState("");
  const [remoteArgs, setRemoteArgs] = useState("{}");
  const [remoteBusy, setRemoteBusy] = useState<"probe" | "call" | null>(null);
  const [localName, setLocalName] = useState("");
  const [localCommand, setLocalCommand] = useState("");
  const [localProbe, setLocalProbe] = useState<LocalMcpProbeResult | null>(null);
  const [localCall, setLocalCall] = useState<LocalMcpCallResult | null>(null);
  const [localSaved, setLocalSaved] = useState(false);
  const [localBusy, setLocalBusy] = useState<"probe" | "call" | null>(null);
  const [localTool, setLocalTool] = useState("");
  const [localArgs, setLocalArgs] = useState("{}");
  const [localConnectorId, setLocalConnectorId] = useState<string | null>(null);
  const [packageBusy, setPackageBusy] = useState(false);
  const [pendingCall, setPendingCall] = useState<PendingConnectorCall | null>(null);
  const [refreshingId, setRefreshingId] = useState<string | null>(null);
  const [refreshAction, setRefreshAction] = useState<"start" | "stop" | "refresh" | null>(null);
  const [refreshFeedback, setRefreshFeedback] = useState<{
    id: string;
    message: string;
    tone: "success" | "error";
  } | null>(null);
  const [reconnectingActive, setReconnectingActive] = useState(false);
  const installedIds = new Set(installed.map((e) => e.id));

  async function executeLocalCall(
    command: string,
    connectorId: string | null,
    toolName: string,
    argumentsText: string,
  ): Promise<void> {
    setLocalBusy("call");
    const result = connectorId !== null && mcpRunningIds.includes(connectorId)
      ? await onCallRegisteredLocal(connectorId, toolName, argumentsText)
      : await onCallLocal(command, toolName, argumentsText);
    setLocalCall(result);
    setLocalBusy(null);
  }

  async function executeRemoteCall(
    id: string,
    toolName: string,
    argumentsText: string,
  ): Promise<void> {
    setRemoteBusy("call");
    const result = await onCallRemote(id, toolName, argumentsText);
    setRemoteCall(result);
    setRemoteBusy(null);
  }

  async function approvePendingCall(): Promise<void> {
    const call = pendingCall;
    if (call === null) return;
    setPendingCall(null);
    if (call.transport === "local") {
      await executeLocalCall(call.command, call.connectorId, call.toolName, call.argumentsText);
    } else {
      await executeRemoteCall(call.connectorId, call.toolName, call.argumentsText);
    }
  }

  function requestLocalCall(): void {
    const call = {
      transport: "local" as const,
      command: localCommand,
      connectorId: localConnectorId,
      toolName: localTool,
      argumentsText: localArgs,
    };
    if (connectorCallRequiresApproval(authorizationMode, "local")) {
      setPendingCall(call);
      return;
    }
    void executeLocalCall(call.command, call.connectorId, call.toolName, call.argumentsText);
  }

  function requestRemoteCall(): void {
    const id = `remote-${remoteName.trim().toLowerCase().replace(/[\s_]+/g, "-")}`;
    const call = {
      transport: "remote" as const,
      connectorId: id,
      toolName: remoteTool,
      argumentsText: remoteArgs,
    };
    if (connectorCallRequiresApproval(authorizationMode, "remote")) {
      setPendingCall(call);
      return;
    }
    void executeRemoteCall(call.connectorId, call.toolName, call.argumentsText);
  }

  async function reconnectRemote(entry: ConnectorEntry): Promise<void> {
    if (entry.kind !== "remote" || !entry.url || remoteBusy !== null) return;
    setRemoteName(entry.name);
    setRemoteUrl(entry.url);
    setRemoteBusy("probe");
    setRemoteCall(null);
    const result = await onProbeRemote(entry.name, entry.url, remoteToken);
    setRemoteProbe(result);
    setRemoteTool(result?.tools[0]?.name ?? "");
    setRemoteBusy(null);
  }

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
      {activeSessionId !== null && canReconnectActive && onReconnectActive && (
        <section className="connector-session-apply" aria-label="Apply connectors to active conversation">
          <div>
            <strong>Active conversation</strong>
            <p className="muted">
              Connector opt-ins apply to new sessions by default. Reconnect this conversation to apply the current configuration now.
            </p>
          </div>
          <button
            type="button"
            disabled={reconnectingActive}
            onClick={async () => {
              setReconnectingActive(true);
              try {
                await onReconnectActive(activeSessionId);
              } finally {
                setReconnectingActive(false);
              }
            }}
          >
            {reconnectingActive ? "Reconnecting…" : "Reconnect with current connectors"}
          </button>
        </section>
      )}
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
                  onClick={requestLocalCall}
                >
                  {localBusy === "call"
                    ? "Calling…"
                    : connectorCallRequiresApproval(authorizationMode, "local")
                      ? "Review and call"
                      : "Call tool"}
                </button>
                {localCall && (
                  <pre className="local-mcp-output">{JSON.stringify(localCall.result, null, 2)}</pre>
                )}
              </>
            )}
          </div>
        )}
      </section>
      <section className="local-mcp package-mcp" aria-label="MCP Bundle package">
        <h4>Install an MCP Bundle</h4>
        <p className="muted">
          Choose a <code>.mcpb</code> package. Muse validates its manifest, installs an immutable
          revision, and probes the server before adding it to the registry.
        </p>
        <label className="package-picker">
          <span>{packageBusy ? "Installing package…" : "Choose .mcpb package"}</span>
          <input
            type="file"
            accept=".mcpb,.zip,application/zip"
            disabled={packageBusy}
            onChange={async (event) => {
              const file = event.currentTarget.files?.[0];
              event.currentTarget.value = "";
              if (!file || packageBusy) return;
              setPackageBusy(true);
              try {
                await onInstallPackage(file);
              } finally {
                setPackageBusy(false);
              }
            }}
          />
        </label>
        <small className="muted">Package code runs only after an explicit start or session opt-in.</small>
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
                  {e.package && (
                    <small className="muted">
                      MCP Bundle v{e.package.version} · {e.package.sourceName}
                    </small>
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
                {((e.kind === "local" && e.command) || e.kind === "remote") && (
                  <label className="integration-toggle" title="Attach to new Muse conversations">
                    <input
                      type="checkbox"
                      checked={e.useInMuse === true}
                      disabled={
                        e.status === "disabled" ||
                        (e.kind === "remote" && !remoteConnectedIds.includes(e.id))
                      }
                      onChange={(ev) => onUseInMuse(e.id, ev.target.checked)}
                    />
                    <small>Use in Muse</small>
                  </label>
                )}
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
                    {(e.previousTools && e.previousTools.length > 0) || e.previousPackage ? (
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
                              ? e.previousPackage
                                ? "Previous MCP Bundle revision restored."
                                : "Previous tool catalog restored."
                              : "Rollback unavailable; the current catalog was kept.",
                          });
                        }}
                      >
                        Roll back
                      </button>
                    ) : null}
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
      <h4>Remote MCP connector (one maximum)</h4>
      <p className="muted">
        Connect to a public HTTPS MCP endpoint. The bearer token stays in
        memory and is cleared when you disconnect or close the app.
      </p>
      <form
        className="integration-form"
        onSubmit={async (ev) => {
          ev.preventDefault();
          if (
            remoteName.trim().length === 0 ||
            remoteUrl.trim().length === 0 ||
            remoteBusy !== null
          )
            return;
          setRemoteBusy("probe");
          setRemoteCall(null);
          const result = await onProbeRemote(
            remoteName.trim(),
            remoteUrl.trim(),
            remoteToken,
          );
          setRemoteProbe(result);
          setRemoteTool(result?.tools[0]?.name ?? "");
          setRemoteBusy(null);
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
        <input
          type="password"
          placeholder="Bearer token (optional)"
          aria-label="Remote MCP bearer token"
          value={remoteToken}
          autoComplete="off"
          onChange={(ev) => setRemoteToken(ev.target.value)}
        />
        <button type="submit" disabled={remoteBusy !== null}>
          {remoteBusy === "probe" ? "Connecting…" : "Connect and list tools"}
        </button>
      </form>
      {remoteProbe && (
        <div className="local-mcp-result" aria-label="Remote MCP connection result">
          <p className="integration-notice" role="status">
            Connected to {remoteProbe.serverName} {remoteProbe.serverVersion} · {remoteProbe.tools.length} tool(s) · {remoteProbe.durationMs} ms
          </p>
          {remoteProbe.tools.length > 0 && (
            <>
              <label>
                Tool
                <select value={remoteTool} onChange={(ev) => setRemoteTool(ev.target.value)}>
                  {remoteProbe.tools.map((tool) => (
                    <option key={tool.name} value={tool.name}>{tool.name}</option>
                  ))}
                </select>
              </label>
              <label>
                Arguments (JSON)
                <textarea value={remoteArgs} onChange={(ev) => setRemoteArgs(ev.target.value)} rows={3} spellCheck={false} />
              </label>
              <button
                type="button"
                disabled={!remoteTool || remoteBusy !== null}
                onClick={requestRemoteCall}
              >
                {remoteBusy === "call"
                  ? "Calling…"
                  : connectorCallRequiresApproval(authorizationMode, "remote")
                    ? "Review and call"
                    : "Call tool"}
              </button>
              {remoteCall && (
                <pre className="local-mcp-output">{JSON.stringify(remoteCall.result, null, 2)}</pre>
              )}
            </>
          )}
        </div>
      )}
      {pendingCall && (
        <section className="connector-approval" aria-label="Connector call authorization" role="dialog">
          <div>
            <strong>Authorization required</strong>
            <span className="muted">
              {pendingCall.transport === "remote" ? "Remote MCP" : "Local MCP"} · {pendingCall.toolName}
            </span>
          </div>
          <p className="muted">
            This call is waiting for a one-time approval because the current posture is {authorizationModeLabel(authorizationMode)}.
          </p>
          <div className="sched-actions">
            <button type="button" className="primary" onClick={() => void approvePendingCall()}>
              Allow once
            </button>
            <button type="button" onClick={() => setPendingCall(null)}>
              Cancel
            </button>
          </div>
        </section>
      )}
      {installed.filter((entry) => entry.kind === "remote").map((entry) => (
        <div className="integration-remote-status" key={entry.id}>
          <span>
            {remoteConnectedIds.includes(entry.id) ? "Connected" : "Disconnected"}
            {entry.serverVersion ? ` · server v${entry.serverVersion}` : ""}
          </span>
          {remoteConnectedIds.includes(entry.id) && (
            <>
              <button type="button" className="integration-action" onClick={() => {
                onDisconnectRemote(entry.id);
                setRemoteProbe(null);
                setRemoteCall(null);
              }}>
                Disconnect
              </button>
              <button
                type="button"
                className="integration-action"
                onClick={() => void onForgetRemoteCredential(entry.id)}
              >
                Forget token
              </button>
            </>
          )}
          {!remoteConnectedIds.includes(entry.id) && (
            <>
              <button
                type="button"
                className="integration-action"
                disabled={remoteBusy !== null || !entry.url}
                onClick={() => void reconnectRemote(entry)}
              >
                {remoteBusy === "probe" ? "Reconnecting…" : "Reconnect"}
              </button>
              <button
                type="button"
                className="integration-action"
                onClick={() => void onForgetRemoteCredential(entry.id)}
              >
                Forget token
              </button>
            </>
          )}
        </div>
      ))}
      {remoteNotice !== null && (
        <p className="integration-notice" role="status">
          {remoteNotice}
        </p>
      )}
    </section>
  );
}
