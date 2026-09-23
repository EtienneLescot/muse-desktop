# Capacité du host : 32 sessions chargées, jamais déchargées

**Constat utilisateur (23/09/2026, Windows).** Environ 30 conversations, dont 27 hors projet.
L'app affiche deux erreurs :

- en passant en YOLO : `YOLO saved locally, but 28 conversations could not update the host.` ;
- au démarrage d'une conversation : `MSP error -32030: host loaded-session capacity is exhausted
  [commandRejected] (runtime_busy) [retryable=true]`.

## Mesures (sidecar Muse 1.3, workspaces temporaires)

- **32 sessions chargées au maximum par host.** Le 33e `session/start` est refusé avec l'erreur
  exacte de la capture (`node scripts/msp-loaded-capacity.mjs`). `initialize` n'annonce aucune
  limite.
- **Le host ne décharge jamais une session inactive.** 32 sessions chargées, dont 16 passées par
  `view/unsubscribe`, capacité `sessionListStream` négociée. Pendant 6 minutes, `session/list`
  donne `idle: 32` toutes les 30 s, aucun `session/closed` n'arrive, et chaque nouveau
  `session/start` est refusé.
- **Aucun déchargement côté client** : pas de `session/unload` ni de `session/close`, et le schéma
  renvoie à la politique d'inactivité du host (tdd SS2.8).
- `session/setApprovalMode` en `allowAll` est accepté sur une session chargée, même au plafond.

Conséquence : la limite porte sur les conversations **chargées depuis le lancement du host**.
Ouvrir 32 conversations l'une après l'autre suffit, sans jamais en avoir plusieurs ouvertes à la
fois. Seul un nouveau processus libère la place.

## Causes côté app

1. La reprise au boot rechargeait **toutes** les conversations stockées, ce qui remplissait le
   host dès le lancement.
2. Même sans cela, chaque conversation ouverte restait chargée jusqu'à la fin du processus.

## Correctif

- **Reprise à l'ouverture** (`selectResumeOnOpen`) : seule la conversation ouverte est reprise,
  au boot puis à chaque ouverture.
- **Remplacement du host plein** (`recycle_full_host`, `main.rs`). Quand `session/start` ou
  `session/resume` reçoit `-32030 runtime_busy` :
  - le host de ce dossier est remplacé par un processus neuf, puis la demande est rejouée une fois ;
  - les conversations qu'il portait reçoivent `host_exited` avec un message dédié, puis sont
    reprises en silence quand l'utilisateur les rouvre ;
  - **le remplacement est refusé si l'une d'elles travaille**, pour ne pas tuer un tour. Le message
    explique alors d'attendre qu'elle finisse.
- Le message YOLO cite la première raison de refus du host. La cause des 28 échecs de la capture
  n'a pas pu être lue : l'app était fermée.

## Limites

- Pas encore rejoué dans l'app : ni un démarrage au-delà de 32, ni la reprise après remplacement.
- Un plantage réel du host garde le Reconnect manuel. Seul le remplacement volontaire déclenche
  une reprise automatique, pour qu'un plantage ne tourne pas en boucle.
