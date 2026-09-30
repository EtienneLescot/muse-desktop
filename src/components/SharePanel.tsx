import { useEffect, useState } from "react";
import type { ShareBundle, ShareState } from "../lib/sharing";
import {
  SHARE_DURATION_MAX_HOURS,
  SHARE_DURATION_MIN_HOURS,
  loadShareEndpoint,
  saveShareEndpoint,
  validateShareEndpoint,
  type ShareEndpoint,
} from "../lib/sharePublish";

interface Props {
  shareState: ShareState;
  /** The conversation the snapshot buttons act on. */
  activeSessionId: string | null;
  onShareSession: (sessionId: string, format: "markdown" | "json") => boolean;
  onPublish: (bundleId: string, durationHours: number) => Promise<string | null>;
  onRevokePublished: (bundleId: string) => Promise<boolean>;
  publishError: string | null;
}

const DURATIONS: Array<{ label: string; hours: number }> = [
  { label: "24 h", hours: 24 },
  { label: "7 days", hours: 24 * 7 },
  { label: "30 days", hours: 24 * 30 },
];

function isLive(bundle: ShareBundle, now: number): boolean {
  return Boolean(
    !bundle.revoked && bundle.publishedUrl && (bundle.publishedExpiresAt ?? 0) > now,
  );
}

/**
 * M4-06 share panel: the self-hosted mini-server endpoint (URL + token, the
 * user runs the service — no account, no identity layer) and the bundle list
 * with publish (the server's real 201 URL) and revoke (observable 404 from
 * any client). Local export stays available without any endpoint.
 */
export function SharePanel({ shareState, activeSessionId, onShareSession, onPublish, onRevokePublished, publishError }: Props) {
  const [endpoint, setEndpoint] = useState<ShareEndpoint | null>(() => loadShareEndpoint());
  const [urlInput, setUrlInput] = useState<string>(() => loadShareEndpoint()?.baseUrl ?? "");
  const [tokenInput, setTokenInput] = useState<string>("");
  const [endpointError, setEndpointError] = useState<string | null>(null);
  const [busyBundle, setBusyBundle] = useState<string | null>(null);
  const [duration, setDuration] = useState<number>(24);
  const [now, setNow] = useState<number>(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);

  const saveEndpoint = () => {
    const candidate = validateShareEndpoint({ baseUrl: urlInput, token: tokenInput });
    if (!candidate) {
      setEndpointError("An http(s) base URL without credentials, query or fragment; the token is optional.");
      return;
    }
    setEndpointError(null);
    setEndpoint(candidate);
    saveShareEndpoint(candidate);
  };

  const clearEndpoint = () => {
    setEndpoint(null);
    setUrlInput("");
    setTokenInput("");
    saveShareEndpoint(null);
  };

  const bundles = Object.values(shareState.bundles).sort((a, b) => b.createdAt - a.createdAt);

  const publish = async (bundle: ShareBundle) => {
    if (!endpoint) return;
    setBusyBundle(bundle.bundleId);
    await onPublish(bundle.bundleId, duration);
    setBusyBundle(null);
  };

  const revoke = async (bundle: ShareBundle) => {
    if (!endpoint || !bundle.publishedUrl) return;
    setBusyBundle(bundle.bundleId);
    const ok = await onRevokePublished(bundle.bundleId);
    setBusyBundle(null);
    if (!ok) return;
  };

  return (
    <section className="share-panel" aria-label="Sharing">
      <header className="settings-runtime-head">
        <div>
          <h3>Share conversations</h3>
          <p className="settings-note">
            Publishes a bundle to a share service <strong>you run yourself</strong> (LAN, VPS, NAS) —
            no account, no identity layer; revocation is served by that service and is observable
            from any client. Reference server: <code>node scripts/share-server.mjs</code>.
          </p>
        </div>
      </header>

      <div className="share-endpoint">
        <label className="share-endpoint-row">
          <span>Service URL</span>
          <input
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            placeholder="http://192.168.1.20:8787"
            aria-label="Share service URL"
            spellCheck={false}
          />
        </label>
        <label className="share-endpoint-row">
          <span>Publish token</span>
          <input
            value={tokenInput}
            onChange={(e) => setTokenInput(e.target.value)}
            placeholder="optional — readers never need it"
            aria-label="Share service token"
            spellCheck={false}
          />
        </label>
        <div className="share-endpoint-actions">
          <button type="button" onClick={saveEndpoint}>Save service</button>
          {endpoint && <button type="button" className="share-quiet" onClick={clearEndpoint}>Forget</button>}
          {endpoint && (
            <span className="share-endpoint-ok" role="status">
              Configured: {endpoint.baseUrl}{endpoint.token ? " (token set)" : ""}
            </span>
          )}
        </div>
        {endpointError && <p className="error" role="alert">{endpointError}</p>}
      </div>

      {publishError && <p className="error" role="alert">{publishError}</p>}

      <div className="share-snapshot">
        <span className="share-bundle-meta">Snapshot the current conversation into a bundle:</span>
        <button
          type="button"
          disabled={activeSessionId === null}
          onClick={() => activeSessionId && onShareSession(activeSessionId, "markdown")}
        >
          Markdown
        </button>
        <button
          type="button"
          disabled={activeSessionId === null}
          onClick={() => activeSessionId && onShareSession(activeSessionId, "json")}
        >
          JSON
        </button>
        {activeSessionId === null && <span className="share-bundle-meta">No conversation open.</span>}
      </div>

      {bundles.length === 0 ? (
        <p className="muted">No bundle yet — share a conversation first (share creates a local bundle you can publish here).</p>
      ) : (
        <ul className="share-bundles">
          {bundles.map((bundle) => {
            const live = isLive(bundle, now);
            const expired = Boolean(!bundle.revoked && bundle.publishedUrl && !live);
            return (
              <li key={bundle.bundleId} className="share-bundle">
                <div className="share-bundle-head">
                  <strong>{bundle.title}</strong>
                  <span className="share-bundle-meta">
                    {new Date(bundle.createdAt).toLocaleString()} · {bundle.format}
                    {bundle.redacted ? " · redacted" : ""}{bundle.truncated ? " · bounded" : ""}
                  </span>
                </div>
                {live && bundle.publishedUrl && (
                  <div className="share-bundle-published">
                    <span className="share-url" title={bundle.publishedUrl}>{bundle.publishedUrl}</span>
                    <button
                      type="button"
                      onClick={() => void navigator.clipboard?.writeText(bundle.publishedUrl ?? "")}
                    >
                      Copy link
                    </button>
                    <button
                      type="button"
                      className="share-quiet"
                      disabled={busyBundle === bundle.bundleId}
                      onClick={() => void revoke(bundle)}
                    >
                      Revoke
                    </button>
                    <span className="share-bundle-meta">
                      expires {bundle.publishedExpiresAt ? new Date(bundle.publishedExpiresAt).toLocaleString() : ""}
                    </span>
                  </div>
                )}
                {expired && <p className="muted share-bundle-meta">The published link has expired — publish again to share it.</p>}
                {bundle.revoked && <p className="muted share-bundle-meta">Revoked — the link returns 404 for every client.</p>}
                {!endpoint && !bundle.publishedUrl && (
                  <p className="muted share-bundle-meta">Configure a service above to publish this bundle.</p>
                )}
                {endpoint && !bundle.revoked && !live && (
                  <div className="share-bundle-actions">
                    <select
                      value={duration}
                      onChange={(e) => setDuration(Number(e.target.value))}
                      aria-label={`Publish duration for ${bundle.title}`}
                    >
                      {DURATIONS.filter((d) => d.hours >= SHARE_DURATION_MIN_HOURS && d.hours <= SHARE_DURATION_MAX_HOURS).map((d) => (
                        <option key={d.hours} value={d.hours}>{d.label}</option>
                      ))}
                    </select>
                    <button
                      type="button"
                      disabled={busyBundle === bundle.bundleId}
                      onClick={() => void publish(bundle)}
                    >
                      {busyBundle === bundle.bundleId ? "Publishing…" : "Publish"}
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
