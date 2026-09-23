import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  installHeadline,
  parseInstallStatus,
  type InstallStatus,
  type MuseTask,
} from "../lib/museInstall";
import { userFacingError } from "../lib/errorCopy";

interface Props {
  /** First step to show: install the CLI, or only sign in. */
  initialStep?: MuseTask;
  /** Called once Muse is installed and signed in. */
  onReady: () => void | Promise<void>;
  /** Optional escape hatch (used when shown over a conversation). */
  onClose?: () => void;
}

interface AuthStatusLike {
  mode?: string;
}

/**
 * macOS first run: install the Muse CLI with Meta's official installer, then
 * sign in with `muse login` — both without leaving the app. Nothing runs until
 * the user clicks; the native side owns the commands.
 */
export function MuseSetupScreen({ initialStep = "install", onReady, onClose }: Props) {
  const [step, setStep] = useState<MuseTask>(initialStep);
  const [status, setStatus] = useState<InstallStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showLog, setShowLog] = useState(false);
  const [useApiKey, setUseApiKey] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [savingKey, setSavingKey] = useState(false);
  const logRef = useRef<HTMLPreElement>(null);
  const done = useRef(false);

  const call = async (command: string) => {
    try {
      setError(null);
      const next = parseInstallStatus(await invoke(command));
      if (next) setStatus(next);
    } catch (e) {
      setError(userFacingError(String(e), "Muse could not be set up."));
    }
  };

  const saveApiKey = async () => {
    setSavingKey(true);
    setError(null);
    try {
      await invoke("muse_cli_set_api_key", { apiKey });
      setApiKey("");
      finish();
    } catch (e) {
      setError(userFacingError(String(e), "The API key could not be saved."));
    } finally {
      setSavingKey(false);
    }
  };

  const finish = () => {
    if (done.current) return;
    done.current = true;
    void onReady();
  };

  // After the CLI is installed, sign-in is the next step unless a credential
  // is already present (for example a previous install on this Mac).
  const afterInstall = async () => {
    const auth = await invoke<AuthStatusLike>("muse_auth_status").catch(() => null);
    if (auth?.mode === "none") {
      setStatus(null);
      setShowLog(false);
      setStep("login");
    } else {
      finish();
    }
  };

  useEffect(() => {
    void call("muse_cli_install_status");
  }, []);

  useEffect(() => {
    if (status?.state !== "running") return;
    const timer = window.setInterval(() => void call("muse_cli_install_status"), 400);
    return () => window.clearInterval(timer);
  }, [status?.state]);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [status?.log, showLog]);

  useEffect(() => {
    if (status === null || status.kind !== step) return;
    if (status.state === "failed") setShowLog(true);
    if (status.state !== "succeeded") return;
    if (step === "install") void afterInstall();
    else finish();
  }, [status?.state, status?.kind, step]);

  // Only the status of the current step is shown: a finished install must not
  // leak its "succeeded" state into the sign-in step.
  const current = status !== null && status.kind === step ? status : null;
  const state = current?.state ?? "idle";
  const running = state === "running";
  const startCommand = step === "install" ? "muse_cli_install_start" : "muse_cli_login_start";

  return (
    <div className="muse-setup">
      <span className="muse-logo">
        <img src="muse-logo.png" alt="" />
      </span>
      <ol className="muse-setup-steps" aria-label="Setup steps">
        <li aria-current={step === "install" ? "step" : undefined} data-done={step === "login"}>Install</li>
        <li aria-current={step === "login" ? "step" : undefined}>Sign in</li>
      </ol>
      <h2>{step === "install" ? "Set up Muse" : "Sign in to Muse"}</h2>
      <p className="muse-setup-lead" role="status" aria-live="polite">
        {state === "idle" && step === "install"
          ? "Muse-Desktop needs the Muse CLI to work. Install it once — it stays up to date on its own."
          : installHeadline(current ?? (step === "login" ? { kind: "login", state: "idle", log: "", exitCode: null, awaitingEnter: false, cliPath: "", installed: true, signInCode: null } : null))}
      </p>

      {step === "login" && useApiKey && !running && (
        <form
          className="muse-setup-key"
          onSubmit={(event) => {
            event.preventDefault();
            void saveApiKey();
          }}
        >
          <label htmlFor="muse-api-key">Meta API key</label>
          <input
            id="muse-api-key"
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            placeholder="Paste your API key"
          />
          <div className="muse-setup-actions">
            <button type="submit" className="primary" disabled={savingKey || apiKey.trim() === ""}>
              {savingKey ? "Saving…" : "Save API key"}
            </button>
            <button type="button" onClick={() => { setUseApiKey(false); setApiKey(""); setError(null); }}>
              Sign in with Meta instead
            </button>
          </div>
        </form>
      )}

      {step === "login" && current?.signInCode && running && (
        <div className="muse-setup-code" aria-label="Sign-in code">{current.signInCode}</div>
      )}

      {!(step === "login" && useApiKey && !running) && (
      <div className="muse-setup-actions">
        {running && current?.awaitingEnter ? (
          <button type="button" className="primary" onClick={() => void invoke("muse_cli_install_enter").catch(() => {})}>
            Open the Meta sign-in page
          </button>
        ) : !running && state !== "succeeded" ? (
          <button type="button" className="primary" onClick={() => void call(startCommand)}>
            {state === "failed" || state === "cancelled"
              ? "Try again"
              : step === "install" ? "Install Muse CLI" : "Sign in with Meta"}
          </button>
        ) : null}
        {running && !current?.awaitingEnter && <span className="muse-setup-spinner" aria-hidden="true" />}
        {running && (
          <button type="button" onClick={() => void call("muse_cli_install_cancel")}>Cancel</button>
        )}
        {!running && onClose && (
          <button type="button" onClick={onClose}>Not now</button>
        )}
      </div>
      )}
      {step === "login" && !useApiKey && !running && (
        <button type="button" className="link muse-setup-alt" onClick={() => { setUseApiKey(true); setError(null); }}>
          Use an API key instead
        </button>
      )}

      {error && <p className="muse-setup-error" role="alert">{error}</p>}

      {current && state !== "idle" && (
        <div className="muse-setup-details">
          <button type="button" className="link" aria-expanded={showLog} onClick={() => setShowLog((value) => !value)}>
            {showLog ? "Hide details" : "Show details"}
          </button>
          {showLog && (
            <pre ref={logRef} className="muse-setup-log" aria-label="Output">{current.log}</pre>
          )}
        </div>
      )}

      <p className="muse-setup-note">
        {step === "install" ? (
          <>Uses Meta's official installer (<code>dev.meta.ai/install.sh</code>) and installs{" "}
          <code>muse</code> in <code>~/.local/bin</code>.</>
        ) : (
          useApiKey
            ? <>Saved with <code>muse auth set</code>, which keeps it for the Muse CLI. A <code>META_API_KEY</code> environment variable takes priority over it.</>
            : <>Runs <code>muse login</code>. The Muse CLI stores the credential; Muse-Desktop never sees it.</>
        )}
      </p>
    </div>
  );
}
