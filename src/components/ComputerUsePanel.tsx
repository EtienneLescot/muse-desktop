import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { installHeadline, parseInstallStatus, type InstallStatus } from "../lib/museInstall";
import { isTauriRuntime } from "../lib/env";
import {
  COMPUTER_LEVELS,
  DRIVER_HOME,
  driverInstallCommand,
  LEVEL_INFO,
  describeComputerUse,
  failedProbes,
  levelToolCount,
  type ComputerLevel,
  type ComputerStatus,
} from "../lib/computerUse";

interface Props {
  status: ComputerStatus | null;
  busy: boolean;
  onRefresh: () => Promise<ComputerStatus | null>;
  onSetLevel: (level: ComputerLevel) => Promise<void>;
  onDisable: () => Promise<void>;
}

/**
 * Computer use, in one place.
 *
 * This is the whole permission model the user sees: one switch, three levels,
 * and the state of the grant. It replaces a list of "apps" — `browser`,
 * `finder`, `terminal`, `editor` — of which three were read by no code at all
 * and none described what the agent could actually do.
 *
 * The engine is the open-source CUA driver, and the app is the trusted launcher:
 * Rust writes a capability manifest, starts the driver in its `bounded` mode
 * with it, and the driver itself refuses anything outside that manifest. What
 * this panel shows is therefore the truth about the current grant, including the
 * case where the grant has lapsed while the service is still up.
 */
export function ComputerUsePanel({ status, busy, onRefresh, onSetLevel, onDisable }: Props) {
  const [copied, setCopied] = useState(false);
  const [install, setInstall] = useState<InstallStatus | null>(null);
  const [installError, setInstallError] = useState<string | null>(null);
  const [showLog, setShowLog] = useState(false);
  const refreshed = useRef(false);
  const installing = install?.kind === "cua" && install.state === "running";

  const installCall = async (command: string) => {
    try {
      setInstallError(null);
      const next = parseInstallStatus(await invoke(command));
      if (next) setInstall(next);
    } catch (error) {
      setInstallError(String(error));
    }
  };

  useEffect(() => {
    if (!installing) return;
    const timer = window.setInterval(() => void installCall("muse_cli_install_status"), 500);
    return () => window.clearInterval(timer);
  }, [installing]);

  useEffect(() => {
    if (install?.kind !== "cua") return;
    if (install.state === "failed") setShowLog(true);
    if (install.state === "succeeded" && !refreshed.current) {
      refreshed.current = true;
      void onRefresh();
    }
  }, [install?.kind, install?.state, onRefresh]);
  const active = status?.grantState === "active";
  const probes = failedProbes(status);

  if (status !== null && !status.available) {
    return (
      <section className="computer-use" aria-labelledby="computer-use-title">
        <header>
          <strong id="computer-use-title">Computer use</strong>
          <span className="computer-use-state computer-use-state-off">Not installed</span>
        </header>
        <p className="computer-use-summary">{describeComputerUse(status)}</p>
        <p className="computer-use-note">
          Muse Desktop drives this computer through{" "}
          <a href={DRIVER_HOME} target="_blank" rel="noreferrer">
            cua-driver
          </a>
          , an open-source (MIT) driver. It is not bundled: installing it is your
          decision. Install runs the driver's official installer; nothing runs
          until you click.
        </p>
        <div className="computer-use-actions">
          {isTauriRuntime() && !installing && (
            <button
              type="button"
              className="primary"
              onClick={() => {
                refreshed.current = false;
                void installCall("cua_driver_install_start");
              }}
            >
              {install?.kind === "cua" && install.state === "failed" ? "Try again" : "Install cua-driver"}
            </button>
          )}
          {installing && (
            <button type="button" onClick={() => void installCall("muse_cli_install_cancel")}>
              Cancel
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard?.writeText(driverInstallCommand()).then(
                () => setCopied(true),
                () => setCopied(false),
              );
            }}
          >
            {copied ? "Copied" : "Copy install command"}
          </button>
          <button type="button" onClick={() => void onRefresh()} disabled={busy || installing}>
            Check again
          </button>
        </div>
        {install?.kind === "cua" && install.state !== "idle" && (
          <div className="computer-use-install" role="status" aria-live="polite">
            <p>{installHeadline(install)}</p>
            <button type="button" className="link" aria-expanded={showLog} onClick={() => setShowLog((value) => !value)}>
              {showLog ? "Hide details" : "Show details"}
            </button>
            {showLog && <pre className="muse-setup-log">{install.log}</pre>}
          </div>
        )}
        {installError && <p className="error" role="alert">{installError}</p>}
        <code className="computer-use-command">{driverInstallCommand()}</code>
      </section>
    );
  }

  return (
    <section className="computer-use" aria-labelledby="computer-use-title">
      <header>
        <strong id="computer-use-title">Computer use</strong>
        <span
          className={`computer-use-state computer-use-state-${active ? "on" : status?.grantState === "expired" || status?.grantState === "permissions" ? "expired" : "off"}`}
        >
          {active ? "Granted" : status?.grantState === "expired" ? "Grant expired" : status?.grantState === "permissions" ? "Needs macOS permission" : "Off"}
        </span>
      </header>
      <p className="computer-use-summary">{describeComputerUse(status)}</p>

      {status?.grantState === "permissions" && (
        <div className="computer-use-note computer-use-note-warning" role="status">
          <p>{describeComputerUse(status)}</p>
          <div className="computer-use-actions">
            <button type="button" onClick={() => void onRefresh()} disabled={busy}>
              Check again
            </button>
          </div>
        </div>
      )}

      {status?.grantState === "expired" && (
        <p className="computer-use-note computer-use-note-warning" role="status">
          The grant is time-boxed, and inactivity ends it before the service does.
          Turning computer use on again grants it anew.
        </p>
      )}

      <fieldset className="computer-use-levels" disabled={busy}>
        <legend className="sr-only">What Muse may do</legend>
        {COMPUTER_LEVELS.map((level) => (
          <label key={level} className="computer-use-level">
            <input
              type="radio"
              name="computer-use-level"
              value={level}
              checked={(active || status?.grantState === "permissions") && currentLevel(status) === level}
              onChange={() => void onSetLevel(level)}
            />
            <span>
              <strong>{LEVEL_INFO[level].label}</strong>
              <small>{LEVEL_INFO[level].summary}</small>
              <small className="computer-use-count">
                {levelToolCount(status, level)} tools
              </small>
            </span>
          </label>
        ))}
      </fieldset>

      {active && (
        <div className="computer-use-actions">
          <button type="button" onClick={() => void onDisable()} disabled={busy}>
            Turn off and revoke
          </button>
          <button type="button" onClick={() => void onRefresh()} disabled={busy}>
            Refresh
          </button>
        </div>
      )}

      {probes.length > 0 && (
        <ul className="computer-use-probes" aria-label="Driver problems">
          {probes.map((probe) => (
            <li key={probe.label}>
              <strong>{probe.label}</strong> {probe.message || probe.status}
            </li>
          ))}
        </ul>
      )}

      <p className="computer-use-note">
        The agent acts outside your project folder: the workspace sandbox protects
        the folder, not the desktop. Its cursor is visible on screen while it works.
        {status?.manifestDigest ? ` Granted manifest ${status.manifestDigest}.` : ""}
      </p>
    </section>
  );
}

/** The level the current manifest grants, inferred from its tool count. */
function currentLevel(status: ComputerStatus | null): ComputerLevel | null {
  if (status === null) return null;
  const manifest = status.manifest as { allow?: { tools?: unknown } } | null;
  const tools = manifest?.allow?.tools;
  if (!Array.isArray(tools)) return null;
  const count = tools.length;
  const exact = COMPUTER_LEVELS.find((level) => levelToolCount(status, level) === count);
  return exact ?? null;
}
