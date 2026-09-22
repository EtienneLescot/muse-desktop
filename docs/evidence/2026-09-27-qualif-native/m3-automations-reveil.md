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

## Fuseau et DST (M3-07) — résolution mesurée, avertissement absent

Deux automatisations `Once` créées via le formulaire pour des heures locales **dégénérées** :

| Cas | Saisie | Affiché et persisté | Verdict |
|---|---|---|---|
| **Trou** (28/03/2027, 02:30 n'existe pas — passage à l'heure d'été 02:00→03:00) | `2027-03-28T02:30` | « At **28/03/2027 03:30:00** · Europe/Paris », `trigger.at = 1806197400000` (= 01:30Z = 03:30 CEST) | résolu par saut d'une heure ✓ |
| **Doublon** (31/10/2027, 02:30 existe deux fois — retour à l'heure d'hiver) | `2027-10-31T02:30` | « At **31/10/2027 02:30:00** · Europe/Paris », `trigger.at = 1824942600000` (= 00:30Z = **premier** passage, CEST) | choix déterministe ✓ |

`timeZone: "Europe/Paris"` persistée **par planification** (heure murale ancrée sur le fuseau IANA,
insensible à un changement de fuseau système ultérieur). **Manque par contre l'affichage d'un
avertissement :** ni le saut d'heure ni le choix sur le doublon ne sont signalés à l'utilisateur —
l'acceptation « l'application **affiche** et persiste les avertissements de planification » n'est
que moitié remplie (la persistance est prouvée, l'affichage non).

## Cible sur conversation existante (M3-06) — refus honnête + défaut de comparaison de chemins

Automatisation `Qualif M3 existing busy` créée avec `threadReuse: {"kind":"session","sessionId":"01a0c929-…"}`
(fil « Count slowly… ») et lancée à la main (**Run**) pendant qu'un tour y tournait :

```
run-muct4y1i-5yagz7  status: failed  sessionId: ""
error: "the recorded workspace no longer matches the target conversation"
```

- **Refus propre** : aucun état partiel (`sessionId: ""`), erreur explicite, run marqué `failed`
  avec **notification persistée** (`kind: "run-failed"`, `dedupeKey: run-…:run-failed:<ts>`) —
  aucun état incohérent du côté de l'acceptation « refusée sans état incohérent ».
- **Mais la cause du refus est un défaut de comparaison de chemins**, pas l'occupation du fil :
  l'automatisation enregistre `workspace: "G:\repos\openscreen"` alors que la conversation cible
  porte `workspace: "\\\\?\\G:\\repos\\openscreen"` (la forme brute renvoyée par `start_session`).
  **Même répertoire, deux orthographes → échec systématique.** Conséquence : cibler une
  conversation existante ne peut **jamais** réussir en l'état, et la seconde moitié de l'acceptation
  (« réutilise ensuite le même fil ») ne peut pas être jouée tant que la comparaison n'est pas
  normalisée. À corriger côté app (comparaison normalisée ou stockage d'une seule forme).

## Redémarrage en plein run (M3-07) — « Review needed » absent, état « Running » périmé

Run `run-mucta00t-3dqgz3` (« Qualif M3 restart », `threadReuse: new`) laissé en statut `running`
puis **`taskkill /F`** de l'app. Après relance : le run **affiche toujours « Running »** (« 22/09/2026
17:10:49 · conversation started ») alors que le tour et son host sont morts — **aucun marquage
« Review needed »**, aucune réconciliation visible. L'acceptation « runs non terminaux marqués
**Review needed** après redémarrage et bloqués jusqu'à réconciliation explicite » **n'est pas
remplie** : l'état affiché devient incohérent (« Running » pour un travail mort). À corriger /
rejouer quand le marquage existera.

## Réveil natif `AutomationWake` (M3-06) — tâche absente, statut de l'app honnête

`schtasks /query /tn "Muse-Desktop\AutomationWake"` → **« Le fichier spécifié est introuvable »**
(tâche non enregistrée sur cette machine). Le statut affiché par l'app — **« Native wake-up is
unavailable; keep Muse open for automations. »** — est donc **honnête et exact**. Conséquence : le
mécanisme `--automation-wakeup` n'est pas qualifiable ici tant que l'enregistrement de la tâche
(nouvelle installation ? `scheduler_schedules_write` ?) n'a pas lieu ; c'est le point d'entrée de
qualification restant.

## Reproductibilité

- Commit `aff5467`+ ; Windows 11 26200, WebView2, CDP 9222 ; `muse` 1.3.0.
- Séquence : panneau **Automations** → formulaire (nom, instructions, Once, `datetime-local` à
  +3 min, cible New conversation) → **Create automation** → attendre l'échéance → lire la carte de
  run, `muse-desktop.schedule-runs.v1` et les Notifications.
