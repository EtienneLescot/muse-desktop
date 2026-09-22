# M0-04 — Stop → terminal, avec trace du `turnId` transmis (27 septembre 2026)

**Le chantier 5 du [plan client du 20 septembre](../../plans/2026-09-20-travail-client-restant.md) est tranché.** La
question était : « reproduire l'arrêt depuis l'interface et vérifier le `turnId` effectivement
transmis ». Réponse, mesurée sur le fil IPC réel : **le `turnId` est transmis, non vide, et l'état
Stop se résout en ~1 s.** Le `Stopping…` figé de la campagne du 20/09 **ne se reproduit pas** au
HEAD (`362c8bb`).

## La mesure

```powershell
node scripts/cdp-stop-terminal.mjs
```

Scénario complet depuis la webview : nouvelle conversation → tour long admis → **bouton Stop de
l'interface** → observation de la résolution → **relance** (« reprendre »).

| Fait | Mesure |
|---|---|
| `turnId` observé sur le fil | **oui** (`send_input` → `turnId` du tour) |
| Bouton Stop cliqué | **oui** (bouton « Stop » de la ligne composer en état working) |
| Appels `cancel_session` | **2/2 avec `turnId` non vide** |
| Résolution de l'état Stop | **1 006 ms** après le clic |
| Relance après arrêt | **oui** — le tour suivant démarre (`stream-health-working`, « work item started ») |

La trace IPC, qui tranche (identifiants de la session en cours) :

```json
{ "cmd": "cancel_session",
  "payload": { "sessionId": "01a0c947-b83b-7032-9298-fe305b3eab42",
               "turnId": "01a0c947-ba9b-7349-8cc5-98420f17f846" },
  "result": "null" }
```

`turnId` = l'identifiant de tour annoncé par `send_input` — **le renderer transmet le bon
identifiant, non vide**. L'accusé `null` est l'admission (« admission only »), puis le terminal
serveur `turn/completed` — établi par [`msp-interrupt-notifications.mjs`](session-log-expique-tout.md)
à **+36 ms** — fait sortir l'interface de l'état Stop.

## Les trois possibilités du plan client, tranchées

| Hypothèse (chantier 5) | Verdict |
|---|---|
| 1. le renderer n'appelle pas `interrupt_session` avec un `turnId` non vide | **réfutée** — `turnId` présent et correct à chaque appel |
| 2. le terminal arrive mais n'est pas associé au bon tour côté client | **réfutée** — résolution UI en ~1 s |
| 3. l'observation d'interface datait d'un état différent | **la plus probable** — voir ci-dessous |

**Sur le 3 :** l'observation d'origine cliquait un bouton **désactivé** dont le `title` contenait
« stop it first » (contrôle de lane sous-agent), et un autre essai rejetait le vrai bouton **à
cause de son titre** — le bouton Stop du tour porte le titre trompeur
**`"Stop the running sidecar"`**. Ce titre est un défaut de libellé restant (le bouton arrête le
**tour**, pas le sidecar), à corriger côté interface.

## Deux défauts de méthode qui ont failli produire un faux constat

Consignés pour ne pas les refaire :

1. **`__TAURI_INTERNALS__.invoke` n'est pas patchable** (Proxy qui rend l'ancien `invoke`) et
   **`chrome.webview.postMessage` n'est pas la voie de transport** (0 trame). Le transport IPC
   réel de ce build est **`window.fetch`** — chaque invoke est un fetch dont l'URL porte la
   commande (`http://ipc.localhost/{cmd}`) et le corps les arguments. Mesuré : 153 appels/65 s
   de trafic ordinaire dont les polls `poll_events` (`{"since":N}`).
2. Le bouton Stop du tour **n'apparaît qu'avec l'état working**, avec 1 à 3 s de décalage sur
   l'accusé de `send_input` ; un clic à +2,4 s ne trouve rien. Il faut **attendre** le bouton.

## Comportement de liveness observé (honnête, à connaître)

Pendant la réflexion du modèle (avant le premier delta de texte), le bandeau passe en
`stream-health-stalled` : **« No recent host update — No host event for 47s. Muse may still be
working. Last event: work item started. »**, puis revient à « response update » dès le premier
delta. Ce n'est **pas** un bug de flux : le modèle était silencieux 47 s. Le libellé reste
calme et honnête (« Muse may still be working »).

## États terminaux quand la mort du processus est connue

Voir [`m0-02-reprise-apres-mort-host.md`](m0-02-reprise-apres-mort-host.md) : le statut
« Muse stopped because the host process ended. Reconnect to continue. » est honnête et actionnable.

## Complément : la distinction « demande acceptée » / « terminal confirmé » capturée en direct

Run « outil » (`cdp-stop-terminal-outil-run1.json`, `MUSE_STOP_AFTER_MS=20000`) — état UI exact
au moment du clic Stop :

```json
{ "stopping": true, "stoppingBanner": true,
  "healthClass": "stream-health stream-health-stopping",
  "healthText": "Stopping Muse The stop request was accepted; waiting for the desktop host to confirm it." }
```

→ puis résolution en **1 018 ms**, `cancel_session` avec `turnId` correct (3ᵉ appel consécutif
conforme). Le critère « `Stopping Muse` reste une demande acceptée tant que le terminal n'est pas
confirmé » est donc **prouvé avec son libellé exact**.

**Constat d'environnement (M1-05/M0-10) :** le shell *utilisateur du modèle* (outil interne) est
refusé dans cette configuration : le flux de sortie rapporte « enforcement unavailable:
windows_elevated setup_required: sandbox users are not ready ». La phase « arrêt pendant un outil »
n'a donc pas pu être jouée avec un outil modèle long ; elle reste à rejouer avec **Run in Muse**
(`session/userShell`, lui fonctionnel — voir M1-06) comme outil long.

## Phases spéciales jouées le 27/09/2026 (suite) — trois de quatre fermées

Toutes via `scripts/cdp-stop-terminal.mjs` (`MUSE_STOP_AFTER_MS` pour cibler la phase,
`--followup` pour prouver la relance) ; rapports bruts `cdp-stop-avant-token-run1.json`,
`cdp-stop-reponse-tardive-run1.json` et `cdp-stop-reponse-tardive-run2.json`.

### Avant le premier token — prouvé (`MUSE_STOP_AFTER_MS=1500`)

Prompt à planification longue (« plan a 2500-word essay … then reply PLANNED ») ; arrêt à +1,5 s,
**avant toute sortie** (`uiBeforeStop.healthText: null` — la rangée de stream n'a pas encore
d'état ; l'état `reasoning update` du tour suivant est visible dans `uiAfterFollowup`).

```
verdict: {"turnIdObservedOnWire":true,"stopClicked":true,
          "cancelCarriedTurnId":[true,true,true,true],
          "stoppingResolved":true,"resolvedAtMs":1018}
```

- `cancel_session` porte le **`turnId`** du tour dès la phase pré-token.
- Bannière **acceptée** capturée en direct (`uiObservations[0]`, +2 ms après le clic) :
  « Stopping Muse — The stop request was accepted; waiting for the desktop host to confirm it. »
- **Résolution terminale en 1,0 s** puis **relance immédiate fonctionnelle** (`uiAfterFollowup` :
  `Muse is working … · reasoning update.`).

### Réponse tardive — prouvé (`MUSE_STOP_AFTER_MS=45000`)

Prompt très long (« 3000-word technical analysis … ») ; à **+45 s** le tour est **toujours vivant**
(bouton Stop présent, cliqué) :

```
verdict: {"turnIdObservedOnWire":true,"stopClicked":true,
          "cancelCarriedTurnId":[true,true,true,true,true,true],
          "stoppingResolved":true,"resolvedAtMs":1016}
```

Acceptation du même libellé (capturée live), `turnId` transmis, **résolution en 1,0 s**, relance
OK. Le comportement de liveness (« No recent host update… Muse may still be working ») reste le
marqueur honnête de cette fenêtre.

### Après la fin de la réponse — prouvé (`MUSE_STOP_AFTER_MS=60000`, réponse déjà terminée)

`cdp-stop-reponse-tardive-run1.json` : à +60 s la réponse était finie depuis longtemps —
**aucun bouton Stop n'existe plus** (`stopClicked: false`), l'UI est au repos
(`uiBeforeStop.healthText: null`), et le tour suivant (`--followup`) démarre immédiatement.
L'UI ne propose pas d'arrêter ce qui est déjà fini et rien ne casse.

### Reste : pendant un outil

Toujours bloqué par le défaut d'environnement (outil shell du modèle refusé — et depuis le
27/09 au soir, `muse sandbox windows setup` est fait mais **un host lancé par l'app refuse
toujours** (`managed shell sandbox is unavailable`) — voir [`m1-06-run-in-muse-sandbox.md`](m1-06-run-in-muse-sandbox.md)).
À rejouer dès que le raccordement app↔host est corrigé, avec un outil long (shell ou recherche).

## Reproductibilité

- Commit : `362c8bb` (main), `target\debug\muse-desktop.exe` via `npm run tauri -- dev`.
- Plateforme : Windows 11 (10.0.26200), WebView2, sidecar `muse-bin-1.3.0-R3401.1`.
- Script : `scripts/cdp-stop-terminal.mjs` (captures dans `shots/m0-04-*.png`).
- Sortie brute : `cdp-stop-terminal-run6.json` (verdict ci-dessus), `cdp-stop-terminal-run4.json`
  (trace des formes d'appel).

**Verdict M0-04 Windows :** « Stop résolu par un terminal serveur » est **prouvé en cours de
réponse** avec `turnId` transmis et reprise prouvée. **Phases fermées le 27/09 : avant le premier
token, réponse tardive, après la fin** (ci-dessus). Reste la phase **pendant un outil**, bloquée
par le défaut d'environnement documenté dans [`m1-06-run-in-muse-sandbox.md`](m1-06-run-in-muse-sandbox.md).
