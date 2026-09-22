# `--no-session-log` explique tout — fin des deux mystères du harness (27 septembre 2026)

**Ce document résout les deux énigmes laissées ouvertes par la campagne du 20 septembre** :
le faux négatif de `native-smoke.mjs --exercise-control --exercise-terminal`
([`harness-faux-negatif.md`](../2026-09-20-windows-sessions/harness-faux-negatif.md), « je
n'explique pas ») et la durabilité « variable » du host
([`durabilite-a-change.md`](../2026-09-20-windows-sessions/durabilite-a-change.md), « je
n'explique pas le changement »). **Une seule cause, mesurée** : le drapeau `--no-session-log`
de `muse serve`.

## La cause, en une phrase

`muse serve --help` : `--no-session-log` = **« Use memory-only sessions »**. Ce n'est pas un
simple choix de stockage : un host en mémoire seule répond `sessionDurability: "ephemeral"`
**et n'admet jamais de tours qui se matérialisent** — `turn/start` répond `accepted`, puis
la seule notification est `session/started`, sans `turn/started`, sans items, sans terminal.

`native-smoke.mjs` lançait **tous** ses hosts avec `--no-session-log`. Les sondes `msp-*.mjs`,
elles, ne l'utilisent pas. D'où les mesures contradictoires sur la même machine, le même jour.

## La mesure : `scripts/msp-session-log-effect.mjs`

Une sonde, deux hosts, identiques sauf le drapeau, même séquence exacte que le chemin de
contrôle du smoke (`turn/start` → `turn/interrupt` immédiat, observation de 20 s) :

| Mesure | logging (défaut) | `--no-session-log` |
|---|---|---|
| `sessionDurability` | **`durable`** | **`ephemeral`** |
| `turn/start` | `accepted` | `accepted` |
| `turn/started` | **oui** | **jamais** |
| Notifications | `session/started`, `session/branchChanged`, `session/statusChanged`, `turn/started`, `item/completed`, `session/statusChanged`, **`turn/completed`** | `session/started` — et rien d'autre |
| Terminal après interruption | **`turn/completed`** | **aucun** |

```json
"verdict": { "durabilityExplained": true, "controlPathExplained": true }
```

**Les deux énigmes ont la même cause, et elle est prouvée par bifurcation d'un seul drapeau.**

## Ce que ça répare dans le récit de la campagne du 20/09

| Mystère | Explication |
|---|---|
| « `sessionDurability` varie : `ephemeral` puis `durable` » | **Ne varie pas** : le smoke (mémoire seule) mesurait `ephemeral`, les autres sondes (journalisées) `durable`. |
| « Le smoke ne reçoit que `session/started`, le tour ne démarre jamais » | **C'est le mode mémoire seule** : le tour admis ne se matérialise pas dans ce mode. Le host n'est pas fautif. |
| « `turn/start` accepté mais `missing_run` » (rapport msp-probe) | Même cause. |
| Les rapports `sessionRead: unsupported`, `reconnect: sessionNotFound` du smoke | Même cause : sans journal de session, rien n'est persisté donc rien n'est relisible. |

**Conséquence méthodologique importante :** tout constat du smoke mesuré sur le chemin des
tours (`--exercise-control`, `--exercise-terminal`, `--exercise-model`, `--exercise-compaction`,
`--exercise-queue`) provient de ce mode dégénéré et doit être **remesuré sur un host
journalisé** avant d'être cité. Les constats purement contractuels (formes de paramètres,
catalogue, refus) restent valables.

## Le correctif du harness, et sa vérification

`scripts/native-smoke.mjs` lance désormais les hosts **en mode journalisé par défaut** ;
l'ancien comportement reste disponible avec `--memory-only-sessions`.

Avant (20/09, et encore ce matin) :

```json
"controls": [{ "host": "A", "status": "interrupted", "terminalNotification": "unsupported" }]
```

Après le correctif :

```powershell
node scripts/native-smoke.mjs --exercise-control --exercise-terminal
```

```json
"controls": [
  { "host": "A", "turnId": "01a0c927-25e1-74eb-…", "status": "interrupted", "terminalMethod": "turn/completed" },
  { "host": "B", "turnId": "01a0c927-25e1-7f19-…", "status": "interrupted", "terminalMethod": "turn/completed" }
]
```

**Les deux hosts, en parallèle, avec le bon `turnId`** : c'est le scénario exact qui échouait
depuis le début de la campagne. Il passe. Le `terminalMethod` attendu est `turn/completed`
sur les deux, `sessionDurability: "durable"`.

## Effet de bord assumé du correctif

Les hosts journalisés **persisttent** les sessions de test dans
`%USERPROFILE%\.local\share\muse\sessions\`. Le smoke n'est lancé qu'en opt-in sur un poste
de développement (jamais en CI), et ses prompts sont triviaux. C'est le prix de mesurer le
vrai comportement : l'ancien défaut du smoke était précisément de mesurer un host amputé.
Le nettoyage reste manuel et délibéré (cf. [`stockage-des-sessions.md`](../2026-09-20-windows-sessions/stockage-des-sessions.md)).

## Ce qui est désormais établi (contrat host, remesuré le 27/09/2026)

Les sondes dédiées ont été réexécutées ce jour sur le binaire `muse-bin-1.3.0-R3401.1` :

| Fait | Mesure du jour | Sonde |
|---|---|---|
| Reprise d'une session persistée libre | **`session/resume` succès**, `session/read` → `history`, `pendingRequests`, `session`, `viewCursor` | `msp-resume-free-session.mjs` |
| Terminal après interruption | **`turn/completed` à +36 ms**, bon `turnId`, `terminal`, `reason`, `durationMs` | `msp-interrupt-notifications.mjs` |
| `session/userShell` | items `userShell` publiés (`item/started` + `item/completed`), **sortie incluse** (marqueur restitué) | `msp-user-shell-items.mjs` |
| userShell après reprise | fonctionne après `session/resume` — le `sessionNotLoaded` du desktop vient du host qui n'a pas la session en mémoire | `msp-user-shell-after-resume.mjs` |
| Projections modèle/effort | `session/setModel` visible sur la session relue ; `session/modelChanged` et `session/reasoningEffortChanged` émis | `msp-projection-check.mjs` |
| Modes d'approbation | `onRequest`, `allowAll`, `promptUnmatched` acceptés et projetés (`session/approvalModeChanged`) | `msp-approval-mode-check.mjs` |

Aucun écart de contrat sidecar n'est établi. **Tout ce qui reste est client ou méthode.**

## Reproductibilité

```powershell
# La mesure de la cause (deux hosts, un seul drapeau de différence)
node scripts/msp-session-log-effect.mjs

# La preuve que le correctif fait passer le scénario qui échouait
node scripts/native-smoke.mjs --exercise-control --exercise-terminal
```
