# M2 — Worktrees : création parfaite, mais la conversation démarre dans le dépôt principal (27 septembre 2026)

**Le mécanisme `create_worktree` est irréprochable ; le raccordement à la conversation est faux.**
La case « Create a new worktree » promet *« The conversation starts in a copy on a new branch »* —
or, mesuré au fil IPC, la session démarre sur le **dépôt principal**, la branche `pr620`.

## 1. Mécanisme worktree — PASS intégral (`node scripts/ux-start-worktree.mjs --port 9222`)

```
ecran d'accueil — la case « Create a new worktree » est proposee, decochee par defaut,
  et dit ou le travail aura lieu : « Create a new worktree The conversation works directly in openscreen. »
creation sans session : muse/probe-mucri3h9
  {"repoRoot":"\\\\?\\C:\\…\\muse-desktop","path":"C:\\…\\muse-desktop\\.muse\\worktrees\\probe-mucri3h9",
   "branch":"muse/probe-mucri3h9","base":"HEAD","createdAt":…}
ok   le chemin est celui du plan (.muse/worktrees/…)
ok   la branche est celle demandee
ok   git connait ce worktree
ok   un chemin hors .muse/worktrees est refuse — "worktree path must be relative and stay inside .muse/worktrees"
ok   le worktree est retire
PASS
```

Sécurité du superviseur validée (refus hors `.muse/worktrees`, message exact) et nettoyage idempotent.

## 2. Scénario complet « coche → conversation » — FAIL sur le raccordement

Fil IPC réel (conversation « Reply with exactly the word: WT2 », openscreen) :

| # | Appel | Mesure |
|---|---|---|
| 1 | `git_worktree_create_for_workspace` `{workspace: "G:\repos\openscreen", branch: "muse/openscreen-rn3d0", relativePath: ".muse/worktrees/openscreen-rn3d0", baseRef: "HEAD"}` | ✓ répond `{path: "G:\repos\openscreen\.muse\worktrees\openscreen-rn3d0", branch: "muse/openscreen-rn3d0", base: "HEAD"}` |
| 2 | `start_session` | ✗ **`workspacePath: "G:\repos\openscreen"`** — le dépôt **principal** ; réponse `workspace: \\?\G:\repos\openscreen` |
| 3 | `git_status` | ✗ **`branch: "pr620"`** — la branche du dépôt principal, pas `muse/openscreen-rn3d0` |
| 4 | `send_input` | ✓ tour démarré normalement (`disposition: "started"`) — mais dans le dépôt principal |

`git -C G:\repos\openscreen worktree list` confirme les worktrees réellement créés et connus de git :

```
G:/repos/openscreen/.muse/worktrees/openscreen          [muse/openscreen]
G:/repos/openscreen/.muse/worktrees/openscreen-eoo86    [muse/openscreen-eoo86]
G:/repos/openscreen/.muse/worktrees/openscreen-riptv    [muse/openscreen-riptv]
G:/repos/openscreen/.muse/worktrees/openscreen-rn3d0    [muse/openscreen-rn3d0]
```

L'enregistrement local `muse-desktop.sessions.v1` de la session est lui-même cohérent avec la
réalité mesurée (`workspace: \\?\G:\repos\openscreen`, `branch: "pr620"`) — c'est bien le
`workspacePath` transmis au `start_session` qui est fautif : **le `path` renvoyé par
`git_worktree_create_for_workspace` n'est pas transmis à `start_session`**.

Capture : [`shots/m2-worktree-session.png`](shots/m2-worktree-session.png).

## 3. Sous-agents (M2-04) — pièces mesurées

- `read_session_history` renvoie des items **`childSessionId`** (session enfant réelle créée par le
  modèle) — observé sur la conversation « Count slowly… » : `{"childSessionId":"078d364d-bf81-…"}`.
- Des **voies sous-agents avec boutons stop** (`title="subagent/stop"`) sont rendues dans le fil et
  ont été capturées dans les runs `cdp-stop-terminal`.
- Reste : un scénario de fan-out dédié avec capture des voies parallèles et reprise du travail
  du parent après l'arrêt d'une voie.

## Verdict M2 Windows

- **M2-03 (« Créer automatiquement un worktree »)** : la **création** est prouvée (`git_worktree_create_for_workspace` → chemin `.muse/worktrees/…`, branche `muse/…`, base `HEAD`, refus des chemins dangereux, rollback) mais l'action atomique **« Create & open »** n'ouvre pas dans le worktree : `start_session` reçoit le dépôt principal. L'acceptation « la conversation fonctionne dans un worktree » n'est **pas** remplie (M2-02/M2-05 dans la foulée : aucun travail n'est possible « sur la branche » tant que le raccordement manque).
- **M2-05 (Local → Worktree)** : non rejoué aujourd'hui ; le défaut de raccordement ci-dessus en est le préalable.
- **M2-07 (sous-agents réels)** : pièces prouvées (items `childSessionId` dans `read_session_history`, voies sous-agents avec boutons `subagent/stop` rendues et capturées) ; scénario fan-out complet + reprise du parent reste à rejouer.

## Concurrence de lanes (M2-07) — observée, reproduction contrôlée hors de portée du modèle

- **Observée en direct le 27/09/2026** : deux lanes `msg subagent subagent-running` **simultanées**
  dans le même rendu (enfants `e8af2a61-…` et `47a01e3d-…`, « thinking… Running », 17:02:34-41) —
  l'app rend et suit bien les enfants en parallèle.
- **Reproduction contrôlée non obtenue** : malgré un ordre explicite de chevauchement (« do NOT
  wait … the two subagents must overlap »), muse-spark sérialise sa délégation — 20 échantillons
  sur 30 s (`window.__laneWatch`) : `maxLanes=1`, `maxConcurrentRunning=1`. Comportement de modèle,
  non limite de l'app. La concurrence multi-fils (chaque fil déployant son enfant) reste la
  reproduction propre à faire.

## Reproductibilité

- Commit `4453efc`+ ; Windows 11 26200, WebView2, CDP 9222 ; `muse` 1.3.0.
- Séquence : `node scripts/ux-start-worktree.mjs --port 9222` → écran d'accueil, cocher
  `label.welcome-worktree`, démarrer une conversation avec trace `window.fetch` réinstallée
  (`window.__museIpcTrace`) → lire `git_worktree_create_for_workspace` / `start_session` /
  `git_status` ; croiser `git -C G:\repos\openscreen worktree list`.
