# M3 — Automations : exécution à l'heure prévue, notification et dégradation wake-up honnête (27 septembre 2026)

**Scénario complet joué en application réelle :** une automatisation « Once » créée à 16:31 pour
16:34:00 s'est exécutée à **16:34:11**, a créé une **nouvelle conversation**, capturé la réponse
**« WOKEN »**, publié une **notification** avec actions, et marqué l'occurrence comme consommée —
le tout avec une dégradation **wake-up** affichée sans ambiguité.

## Scénario et mesures

Panneau **Automations** (`aria-label="Automations"`), formulaire : nom `Qualif M3 wake`,
instructions `Reply with exactly the word: WOKEN`, fréquence **Once**, `22/09/2026 16:34:00`,
cible **New conversation**.

### Persistance (`muse-desktop.schedules.v1`)

```json
{"id":"sched-mucruycl-53csyg","name":"Qualif M3 wake","instructions":"Reply with exactly the word: WOKEN",
 "trigger":{"kind":"once","at":1790087640000},"threadReuse":{"kind":"new"},
 "workspace":"G:\\repos\\openscreen","model":"default","authorizationMode":"yolo",
 "missedPolicy":"latest","timeZone":"Europe/Paris","enabled":true}
```

La taxonomie du contrat est là : déclencheur ponctuel/cron, réutilisation de fil (`new`),
**isolation d'espace de travail par run** (`workspace`), modèle, **mode d'autorisation**, politique
de manqué (`latest`), **fuseau horaire** (M3-01/02/03/05).

### Exécution (`muse-desktop.schedule-runs.v1`) — M3-06

```json
{"id":"run-mucryvm8-17vwjr","occurrenceAt":1790087640000,
 "occurrenceKey":"sched-mucruycl-53csyg:1790087640000","attempt":1,
 "createdAt":1790087651216,"startedAt":1790087651944,"finishedAt":1790087663738,
 "status":"completed","sessionId":"01a0c989-e029-7a01-8467-4a097c50bc2d",
 "resultPreview":"WOKEN","unread":true}
```

- **À l'heure prévue à quelques secondes près** : planifié 16:34:00 → créé 16:34:11 (granularité de
  tic du scheduler), exécuté en **12 s**, `completed` dès la première tentative.
- **Nouvelle conversation réelle** : `threadReuse: new`, `sessionId` créé, ligne d'état
  « conversation started » dans la carte de run (M3-01).
- **Idempotence d'occurrence** : `occurrenceKey` = `scheduleId:occurrenceAt` — un redémarrage ne
  peut pas rejouer la même occurrence (M3-04 crash-restart).
- **Cycle de vie visible** : onglets `Queued / Running / Completed / Failed / Archived` + contrôles
  `Inspect run`, `Open conversation`, `Mark read`, `Archive` (M3-04).

### Notification — M3-09

```
Notifications 1 — Unread (1)
« Automation completed: Qualif M3 wake — NEW — WOKEN — 22/09/2026 16:34:23 »
   [Open conversation] [Mark read]
```

L'acceptation exacte du ticket est remplie : notification avec **résultat du run**, **ouverture de
la conversation concernée** et **marquage lu/non lue**. (La bannière système Windows exige le
bouton « Enable notifications in system settings » — paramètre OS, à rejouer avec l'autorisation.)

### Wake-up natif — M3-08 (dégradation honnête mesurée)

Trois états observés, tous explicites :

1. aucune automatisation active : « Native wake-up cleared; no enabled automation is scheduled. »
2. automatisation active : **« Native wake-up is unavailable; keep Muse open for automations. »**
3. lease scheduler : « Native scheduler active — This desktop instance owns the native scheduler
   lease. Checked 16:34:11 » (`scheduler_claim` au fil : `{"ownerId":"scheduler-…","leaseTtlMs":30000,
   "acquired":true,"native":true}`).

L'app **explique la disponibilité de l'API de réveil et ce qu'elle exige** (« keep Muse open ») —
l'acceptation « la machine ne peut pas réveiller, l'app le dit » est remplie ; la fermeture propre
de l'app au drop du lease reste à rejouer avec le relancement.

## Verdict M3 Windows

- **M3-06 (exécuter sans clic préalable)** : **prouvé en app ouverte** (16:34:00 → run créé 16:34:11,
  `completed` en 12 s, nouvelle conversation, réponse capturée). Le **mécanisme de réveil natif**
  (`Muse-Desktop\AutomationWake`, relance `--automation-wakeup`) est déclaré par l'app elle-même
  **indisponible** ici (« Native wake-up is unavailable; keep Muse open for automations. ») —
  reste sa qualification (poste verrouillé, sommeil, crash) sur les trois OS, jamais jouée.
- **M3-07 (sommeil, reprise, doublons, échecs)** : pièces prouvées — **bail natif exclusif actif**
  (`scheduler_claim` : `acquired: true, native: true`, TTL 30 s, ownerId visible), **claim
  anti-doublon** (`occurrenceKey = scheduleId:occurrenceAt` persisté), politique `missedPolicy:
  latest` et curseur d'occurrence (`No further runs` après consommation d'un trigger `once`). Reste :
  crash/relancement avec runs non terminaux (**Review needed**), retries/épuisement, sommeil.
- **M3-08 (examiner les résultats des runs)** : carte de run complète mesurée — `resultPreview:
  "WOKEN"`, `attempt`, `unread`, filtres `Queued/Running/Completed/Failed/Archived`, actions
  `Inspect run` / `Open conversation` / `Mark read` / `Archive` + retry manuel présent. Reste :
  résumé métier et fin de run native (dépend du host).
- **M3-09 (notification utile)** : **prouvé** en app — « Automation completed: … WOKEN » avec
  résultat, **ouverture de la conversation** et **marquage lu/non lue** (Unread 1 → actions).
  Reste : le prompt de permission natif (`tauri-plugin-notification`, bannière système).
- **M3-01/02/03/05** : taxonomy complète persistée (Once/Cron, new conversation, workspace isolé,
  `Europe/Paris`) — la variante « solliciter une conversation existante pendant un tour en cours »
  (M3-03) et les **avertissements de fuseau** (M3-05) restent à rejouer.

Capture : [`shots/m3-automation-run.png`](shots/m3-automation-run.png).

## Reproductibilité

- Commit `aff5467`+ ; Windows 11 26200, WebView2, CDP 9222 ; `muse` 1.3.0.
- Séquence : panneau **Automations** → formulaire (nom, instructions, Once, `datetime-local` à
  +3 min, cible New conversation) → **Create automation** → attendre l'échéance → lire la carte de
  run, `muse-desktop.schedule-runs.v1` et les Notifications.
