# M0-02 — Mort du host → reconnexion → reprise avec historique (27 septembre 2026)

**Les trois critères de M0-02 sont prouvés sur Windows**, contre un **host durable** (`muse
serve` sans `--no-session-log`). Cela clôt la « reprise de conversation » côté Windows — le
verdict « M0-02 is a client-side gap » de `msp-resume-free-session.mjs` (21/09) était daté : le
chemin client `resume_session` + `read_session_history` **fonctionne** au HEAD `362c8bb`.

## Protocole (exécuté ce jour, webview empaquetée en dev)

1. Conversation ouverte avec historique, host vivant (`muse.exe serve --sandbox-network
   restricted --trust-workspace`, host **durable**).
2. **`taskkill /F` du host** en plein fonctionnement.
3. Observation de l'interface, puis clic sur **« Reconnect »** (`title="Reconnect this saved
   conversation to its workspace engine"`).
4. Envoi d'un message dans la conversation reprise.

## Résultats

### 1. Statut terminal honnête quand la mort du processus est connue ✓

Immédiatement après la mort du host, la conversation affiche :

> **Muse stopped because the host process ended. Reconnect to continue.**

Aucun spinner figé, aucune promesse : l'état est terminale et l'action est nommée.

### 2. Reprise réelle : `resume_session` + hydratation complète ✓

Clic sur Reconnect → trace IPC (le host mort est **relancé** automatiquement) :

| Appel | Résultat clé |
|---|---|
| `resume_session` | `session_durability: "durable"`, **`loaded: true`**, `granted_capabilities: ["userShell"]`, `model_id: "muse-spark-1.3-contributor"` |
| `set_approval_mode` | posture reappliquée (`effectiveMode: allowAll`) |
| `read_session_history` | **historique complet** relu (userMessage + assistant items, `turnId` par entrée) |
| `list_pending_requests` | `{approvals: [], userInputs: []}` |
| `read_queue_snapshot`, `list_models`, `list_skills` | catalogue et skills réhydratés (`is_active: true` sur le modèle effectif) |

### 3. Conservation des messages ✓ + reprise d'exécution ✓

Le transcript d'avant la mort est conservé, l'historique est relu depuis le host relancé, et
**la conversation accepte et exécute un nouveau tour** : « Reply with exactly the word:
RESUMED » → réponse **RESUMED** reçue, sous-agents en `Running`.

## Ce que ça change pour la roadmap

- **M0-02 Windows : les 3 critères sont prouvés** — « reprise d'un tour réellement rejouée contre
  un host durable », « conservation des messages » (enfin observée sur une exécution native),
  « statut terminal honnête ».
- L'entrée « M0-02 — reprise bloquée par le sidecar » des comptes rendus du 21/09 est
  **périmée** : elle mesurait un host `--no-session-log` (mémoire seule), où la reprise est
  structurellement impossible — voir [`session-log-expique-tout.md`](session-log-expique-tout.md).
- macOS/Linux : aucun scénario de reprise exécuté (colonne inchangée).

## Reproductibilité

- Commit `362c8bb`, Windows 11 26200, WebView2, sidecar `muse-bin-1.3.0-R3401.1`.
- Commandes : `taskkill /PID <host> /F` puis pilotage CDP (`scripts/cdp-drive.mjs`) :
  clic Reconnect → trace `resume_session` → envoi « Reply with exactly the word: RESUMED ».
