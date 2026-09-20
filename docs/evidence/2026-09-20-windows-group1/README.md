# Preuves natives Windows — groupe 1 (20 septembre 2026)

Campagne de validation native pilotée par CUA sur l'application desktop réelle, avec un sidecar Muse Windows natif.

## Environnement

| Élément | Valeur |
|---|---|
| Commit | `064e210` (main) |
| Plateforme | Windows 10.0.26200 (x86_64), écran 1920×1080 @1x |
| Application | `target\debug\muse-desktop.exe` lancé par `npm run tauri -- dev` (runtime Tauri 2.11.5, WebView2) |
| Sidecar | **binaire Windows natif** `muse-bin-1.3.0-R3401.1.exe` copié en `src-tauri/binaries/muse-x86_64-pc-windows-msvc.exe` |
| Version moteur | Muse Code 1.3.0 (1.3.0-R3401.1) |
| Authentification | `%USERPROFILE%\.config\muse\auth.json` (provider `meta`) |
| Pilotage | cua-driver 0.28.2 (UIAutomation + Windows Graphics Capture) |
| Workspace de test | `G:\repos\openscreen` (conversations) et `C:\Users\etien\Documents\repos\muse-desktop` (Automations) |

**Nouveauté par rapport à toutes les preuves antérieures :** les validations précédentes utilisaient le pont WSL (`muse-wsl-bridge.exe`). Cette campagne exerce le **binaire Muse Windows natif** comme sidecar, depuis l'interface Tauri empaquetée en mode dev.

### Méthode de pilotage (à réutiliser)

Le contenu WebView2 **n'est pas exposé** dans l'arbre UI Automation : `get_window_state` ne renvoie que 5 éléments (titre de fenêtre et boutons système). Le pilotage se fait donc par **capture + coordonnées**, en respectant deux conversions :

- `fenêtre = preview × 1,193` (la capture 884×1030 est réduite en preview 741×863) ;
- `écran = fenêtre + (1035, 0)` (la fenêtre est positionnée à x=1035).

Les **clics** fonctionnent en livraison `background`, mais la **saisie clavier et les raccourcis n'atteignent le renderer qu'en `foreground`** (SendInput). `PostMessage` est silencieusement ignoré par WebView2 : le tool le signale lui-même (« not verified — could not read the focused field back »).

## Ce qui a été prouvé

### 1. Le binaire Windows natif est un sidecar viable (`07`, `08`)

Conversation créée depuis l'écran d'accueil. L'application affiche :

- en-tête : `G:\repos\openscreen` · `pr620` · **`Connected`** (pastille verte) ;
- en-tête de conversation : **`Ready`** ;
- une carte **`Agent 740b927b-452b-49cb-afb7-731b6a33cf3f thinking…`** en **`Running`** ;
- la ligne de liveness **`Muse is working — Last update 4s ago · work item started`** ;
- la sidebar passe à **`CONVERSATIONS (55, 1 WORKING)`**.

Puis un **tour modèle live complet a abouti** : la question « Enumerate the three Musketeers by name. » reçoit la réponse **« Athos, Porthos, and Aramis. »**, les sous-agents passent à **`Completed`**, la pastille revient à **`Ready`** et la sidebar à **`CONVERSATIONS (55)`**.

**Verdict :** la chaîne application Tauri → sidecar natif Windows → moteur → streaming → transcript fonctionne de bout en bout. C'est le prérequis qui manquait à toutes les preuves « webview empaquetée » du groupe 1.

### 2. Le host 1.3.0 n'émet pas de notification terminale (`08`)

Immédiatement après la réponse, l'application affiche **`No recent host update — No host event for 57s. Muse may still be working. Last event: work item started.`** avec les actions **Sync now** / **Reconnect** / **Stop**.

Le smoke harness confirme la cause sur ce même binaire :

```json
"controls":[{"host":"A","turnId":"…","status":"interrupted","terminalNotification":"unsupported"}]
```

**Verdict :** l'absence de terminal est une limite du host, pas un défaut de l'application — et l'application la surface honnêtement au lieu de conclure le tour artificiellement.

### 3. Détection de panne du host (`10`, `14`)

Deux hosts coexistaient (`PID 47096` et `29580`, tous deux `muse.exe serve --sandbox-network restricted`). Après `Stop-Process` sur `29580` :

- l'application reste vivante et `Responding: True` ;
- **aucun changement visible** (capture identique au bit près, même SHA-256) ;
- aucun respawn.

Après `Stop-Process` sur le **dernier** host (`47096`) : **0 host**, application toujours vivante et répondante. En revenant dans une conversation, l'application affiche :

- pastille **`Disconnected`** (gris) au lieu de `Connected` ;
- un bouton **`Reconnect`** dans l'en-tête ;
- le composer remplacé par **« Open the desktop app to continue. »** avec le bouton d'envoi **désactivé** ;
- le transcript local **intégralement conservé** (messages `08:44`, cartes Tool `search` et `Read text file README.md` toujours affichées).

**Verdict :** détection, signalement et blocage des envois sont corrects. La mort d'un host n'entraîne ni crash ni perte de transcript, et aucun respawn silencieux n'a lieu.

### 4. Récupération explicite, et son échec honnête (`15`)

Clic sur **Reconnect** → un nouveau host est lancé (`PID 43432`, `muse.exe serve --sandbox-network restricted`). La reprise de session échoue et l'application affiche :

> **This conversation could not be reconnecté. — MSP error -32020: session 01a0bd8e-e19f-76a3-856a-83f7c62a310 was not found [sessionNotFound] [retryable=false]. Your saved messages are still available.**

La pastille passe à **`Connection error`** (orange), le transcript reste affiché, l'envoi reste bloqué, et **`Reconnect` reste proposé**.

**Verdict :** c'est le comportement attendu pour un host `ephemeral` — la session n'existe pas dans un store durable, donc la reprise est impossible. L'application ne fabrique aucun faux succès. La copie d'erreur est en anglais, bornée, avec code, identifiant, catégorie et `retryable`, plus une phrase rassurante sur les messages conservés : c'est exactement la copie `userFacingError` attendue par M0-11.

### 5. Conservation du texte et absence d'envoi sans host (`19`, `20`)

Avec **zéro host disponible**, depuis l'écran d'accueil :

- le texte reste dans le composer : **« Analyze the changes and provide a code review. »** ;
- le bouton reste **`Start conversation`** (aucun envoi déclenché) ;
- le hint reste **« Your message is sent as soon as you start. »** ;
- **aucun host n'est lancé** par la tentative (compte vérifié : 0).

Le remplissage du composer par la carte de suggestion **`Review code`** a également été observé (le clic a inséré le libellé de la suggestion dans le champ).

**Verdict :** échec d'envoi non destructif et texte préservé — la propriété centrale de M0-03.

### 6. Le bail du scheduler natif est visible (`13`)

L'onglet **Automations** affiche **`Native scheduler active — This desktop instance owns the native scheduler lease. Checked 13:47:00`** ainsi que `Native wake-up — Native wake-up cleared; no enabled automation is scheduled.` La navigation vers cet onglet a confirmé que l'application reste pleinement réactive après la mort des hosts.

## Sonde de contrat host (`scripts/msp-probe.mjs`)

Le pilotage de l'interface s'étant révélé impraticable (voir « Limites de la méthode »), une sonde MSP dédiée a été écrite pour mesurer directement ce que le host expose ou non. Elle parle le protocole sur stdio à un vrai `muse serve` et ne publie que des faits bornés.

```powershell
node scripts/msp-probe.mjs --surfaces --user-shell   # aucun coût modèle
node scripts/msp-probe.mjs --interrupt --live        # consomme un tour modèle
```

**Surfaces de lecture** (session créée, aucun tour) :

| Méthode | Résultat | Conséquence |
|---|---|---|
| `session/list` | **available** | restauration paginée possible |
| `approval/listPending` | **available** — forme `{approvals, userInputs}` | **correction d'une affirmation de la roadmap** (voir ci-dessous) |
| `session/read` | unsupported | pas de relecture d'historique |
| `session/resume` | unsupported | reprise durable impossible |
| `view/page` | unsupported | pas de repli par curseur |

**`session/userShell`** : `accepted` mais **aucun `item/started`**, aucun `outputRef`, et l'historique n'est pas relisible. Le smoke harness attend déjà cette notification (ligne 738 de `native-smoke.mjs`) et ne l'obtient pas. **La restitution d'une commande shell au moteur n'est donc pas démontrable sur ce host** — M1-06 reste bloqué par le contrat, pas par le client.

**Contrat d'`initialize`** : champs retournés `experimentalApi`, `grantedCapabilities`, `museHome`, `platformFamily`, `platformOs`, `schema`, `serverInfo`, `sessionDurability`, `userAgent`. `sessionDurability` vaut `ephemeral`. `userShell` n'est accordé que s'il est demandé via `capabilities.requestedCapabilities`.

**Détails de protocole utiles, absents de la documentation du dépôt :**

- `initialize` exige `clientInfo.name` conforme à `^[a-z0-9_]+$`.
- `session/start` prend `workspaceRoot` (et non `cwd`) et répond `result.session.sessionId`.
- `session/userShell` prend `commandText` (et non `command`).
- `turn/interrupt` prend `commandId` **en plus** de `turnId`.
- Un `turn/interrupt` sur un tour admis mais sans run retourne `missing_run`.

**Limite rencontrée par la sonde :** un `turn/start` envoyé par un client MSP autonome est **accepté sans qu'aucun run ne se matérialise** (`turn/interrupt` répond `missing_run`, aucune notification au-delà de `session/started`). L'application, elle, obtient de vrais tours — elle dispose du contexte d'authentification du host, que la sonde n'a pas. Les chemins « tour live » restent donc hors de portée d'un client MSP nu.

### Correction d'une affirmation de la roadmap

La roadmap indiquait que `session/read`, `view/page` **et** `approval/listPending` répondaient `methodNotFound`, en s'appuyant sur le smoke. La mesure directe montre que **`approval/listPending` est disponible** dès qu'on lui passe un `sessionId`, et qu'il retourne `{approvals, userInputs}` — c'est un appel **sans** `sessionId` qui produit `methodNotFound`. Ce point mérite d'être revérifié côté client : la carte de récupération des demandes en attente pourrait être plus capable que ce que M0-05 suppose.

## Déblocage : pilotage CDP du DOM (round 3)

Le blocage UI décrit plus bas a été levé en activant le debug distant de WebView2 au lancement de la version de développement :

```powershell
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=9222"
npm run tauri -- dev
```

WebView2 Runtime 153 expose alors un endpoint CDP (`Edg/153.0.4234.48`). Deux outils ont été écrits :

- **`scripts/cdp-drive.mjs`** — `snapshot`, `eval`, `click`, `fill` sur le DOM réel. **Instrumentation de développement uniquement** : elle active une fonctionnalité de WebView2, elle ne modifie pas le code de l'application.
- **`scripts/cdp-scenario.mjs`** — scénario d'acceptation borné (`--live` pour consommer un tour modèle).

Le premier `snapshot` confirme `tauri: true`, l'accès aux 40 clés `muse-desktop.*` du `localStorage`, et un composer `TEXTAREA` avec son état `disabled` — c'est-à-dire tout ce que l'arbre UI Automation refusait.

### Scénario live exécuté (M0-03, M0-04, M1-10, M1-13)

| Étape | Observation |
|---|---|
| Remplissage du composer | `filled: true`, valeur posée via le setter natif + `input` |
| Soumission | bouton **`Start conversation`** cliqué (l'accueil n'utilise pas de `<form>`) |
| Tour démarré | `working: true`, corps « Starting… », `Connected` |
| **2ᵉ envoi pendant le tour** | file persistée : `muse-desktop.queued-turns.v1` → `["01a0bead-d7da-7a52-910d-77f11763e84c"]` |
| **UI de file** | panneau **« Queued messages — They will run in order — second turn: reply with just QUEUED-ACK — Remove from queue »** avec l'action d'enlèvement visible |
| **Clic Stop** | état **`Stopping…`** puis bandeau **« …waiting for the desktop host to confirm it »** |
| Après 20 s | `working: true`, **`stale: true`** — « No recent host update. Last event: work item started » |
| File après Stop | **vidée** (`queueKeys: []`) : le host a consommé le tour en file |
| Sessions | `55 → 57 → 58`, `connected: true` |

**Conclusion sur M0-04 :** l'interruption est demandée et affichée (`Stopping…`), mais **aucune notification terminale n'arrive** et l'état retombe en stale. Le critère « terminal confirmé » reste bloqué par le host, pas par le client — c'est désormais mesuré, plus inféré.

**Conclusion sur M1-10 :** l'admission en file, sa persistance, son affichage ordonné et l'action d'enlèvement sont **tous observés dans le DOM réel**. Ce qui reste non couvert est la preuve que l'enlèvement *avant lancement* retire bien le tour côté host.

**Point de mesure de M1-13 confirmé :** le journal porte bien `data-entry-count`, `data-window-start` et `data-window-end` (ici `12 / 0 / 12`). La mesure native à 2 000 entrées demande un transcript de cette taille, qui n'existe pas dans ce profil et ne peut pas être fabriqué sans fausser la preuve.

### Isolation A/B mesurée dans une seule fenêtre temporelle (M0-01, M0-14)

Contrairement à la première tentative — où la mort d'un host observée via captures n'avait produit **aucun** changement visible, résultat non concluant — la mesure DOM dans une unique fenêtre donne une preuve exploitable :

| Moment | Hosts `muse.exe` | Application | DOM |
|---|---|---|---|
| Avant | **2** — `46536` (13:58:33), `17820` (13:58:35) | vivante | `connected: true`, 58 sessions |
| Après `Stop-Process 17820` | **1** — `46536` | **vivante**, `Responding: True`, même PID | `connected: true`, `disconnected: false`, **`composerDisabled: false`**, 58 sessions, file intacte |

**Ce que cela établit :** la mort d'un host parmi deux simultanés ne tue pas l'application, ne provoque aucun respawn, ne casse aucune conversation, ne vide ni les sessions persistées ni la file, et laisse le compositeur utilisable.

**Ce que cela n'établit pas encore :** qu'une conversation servie par le host survivant **termine un tour réel après** la mort de l'autre, avec des approbations simultanées. C'est le critère de sortie restant de M0-01/M0-14.

**Limite de configuration :** le scénario « deux projets » du texte de M0-01 n'est pas directement reproductible dans ce profil — un seul projet (`openscreen`) est déclaré dans `muse-desktop.projects.v1` alors que deux workspaces coexistent dans les sessions (`muse-dogfood` ×54, `openscreen` ×4). Le sélecteur « Start in » ne propose donc qu'une racine. Faire apparaître le second projet exigerait d'écrire dans l'état de l'application, ce qui a été écarté pour ne pas fausser la preuve.

### Un tour réel démarre et progresse sur le host survivant (M0-01, M0-14)

Dernière étape du scénario A/B : après la mort de B, un nouveau tour a été lancé sur le host survivant `46536` via CDP.

| Mesure | Valeur |
|---|---|
| Hosts avant | 1 (`46536`) — B (`17820`) tué précédemment |
| État DOM avant envoi | `connected: true`, `disconnected: false`, compositeur actif |
| Après envoi + 15 s | `conn=True working=True completed=1 running=3 sessions=59` |
| Après envoi + 30 s | `conn=True working=True completed=3 running=1 sessions=59` |
| Après envoi + 90 s | `conn=True working=True completed=3 running=1 sessions=59` |
| Hosts après | 1 (`46536`) — inchangé |

**Établi :** après la mort d'un host parmi deux, la conversation servie par le survivant **crée une nouvelle session (58 → 59)**, **admet un tour réel**, **reste connectée** et **fait progresser ses sous-agents** (`Completed` de 1 à 3). Aucun respawn, aucun crash, aucune perte.

**Réserve honnête :** ce tour s'exécute alors qu'il ne reste **qu'un** host — il n'y a donc plus de B concurrent pour démontrer l'absence de contamination croisée *pendant* l'exécution. Le critère « approbations simultanées » de M0-01 n'est pas couvert, et l'attente d'un terminal a été bornée à 90 s sans confirmer la fin du tour (le host n'émet pas de notification terminale, cf. plus haut).

## Tentative M4-01/M4-02 — non atteint (round 6)

Le panneau navigateur n'a **pas** pu être exercé. Ce qui a été observé :

- l'état persistant contient bien `muse-desktop.browser.tabs.v1.session.84bb6c78`, réduit à un onglet **vide** : `[{"id":"tab-f3c1a7aa…","url":"","history":[],"historyIndex":-1}]`. Le panneau a donc déjà été ouvert, mais **n'a jamais navigué** — la qualification « navigateur natif » de M4-01 n'a aucune preuve dans ce profil.
- `muse-desktop.browser.permissions.v1` et `muse-desktop.browser.annotations.v1` valent tous deux `[]` : aucune permission ni annotation enregistrée.
- après ouverture d'une conversation (`cdp dry run`, confirmé), **aucun libellé de barre de travail** correspondant à `Browser`, `Files`, `Review`, `Terminal`, `Desktop` ou `Content` n'est détecté dans le DOM, et le clic ciblé échoue (`clicked: false`).
- aucun `iframe` n'est monté et aucun champ d'URL n'existe dans cet état.

**Conclusion :** atteindre la barre de travail demande une étape d'interaction non identifiée (les onglets y sont probablement rendus en icônes sans texte ni `aria-label` exploitable). M4-01 et M4-02 restent **non qualifiés** — ni prouvés ni infirmés. Script conservé pour une reprise : `scripts/cdp-workbar.mjs`.

## Ce qui reste ouvert dans le groupe 1

Aucun ticket du groupe 1 ne réunit encore **tous** ses critères de sortie. État précis :

| Ticket | Prouvé dans cette campagne | Encore requis |
|---|---|---|
| **M0-01** | Deux hosts simultanés ; mort d'un host sans effet sur l'autre ni sur l'application | Scénario A/B **depuis l'UI** avec approbations simultanées et un tour qui se termine sur A après la mort de B |
| **M0-14** | Idem ci-dessus ; chaîne native complète exercée | Même scénario A/B depuis la webview (c'est le critère qui ferme le parent) |
| **M0-03** | Texte préservé et aucun envoi sans host ; transcript conservé après panne | Rejet d'un envoi **avec** host vivant, double-clic, IME, fermeture/rechargement |
| **M0-04** | État stale `No recent host update` avec actions ; terminaison propre observée | Interruption (`Stopping Muse`) et terminal confirmé — **bloqué par `turn/completed` absent du host 1.3.0** |
| **M0-10** | Application démarrée et fonctionnelle ; panneau de récupération et Settings à exercer | Détection sur machine propre, matrices WSL/auth |
| **M0-11** | Titre, pastilles, hints et **copie d'erreur MSP structurée en anglais** en conditions réelles | Checklist finale des titres/erreurs secondaires |
| **M0-12** | Navigation clavier et clic confirmés ; zoom déjà validé le 20/09 | Parcours complet sans souris, lecteur d'écran, contraste |
| **M1-10** | — | Course UI file/`unqueue` avec host vivant |
| **M1-13** | — | Mesure 2 000 entrées dans la webview |
| **M4-01/M4-02** | — | Navigateur natif, onglets par `sessionId`, download same-origin, annotation, capture |
| **M4-09** | — | Installation NSIS/MSI, update, désinstallation |

## Limites de la méthode

1. **Pas d'accès déterministe à l'état.** Le contenu WebView2 n'étant pas dans l'arbre UIA, toute vérification passe par la lecture d'une capture. Il n'existe aucun moyen, depuis cet environnement, de lire le journal, le transcript ou la file de manière structurée pendant que l'application tourne (le profil est un `EBWebView` en mode dev).
2. **Saisie clavier non fiable dans une conversation existante.** Le texte a été inséré avec succès dans le composer de l'écran d'accueil, mais **pas** dans celui d'une conversation ouverte (placeholders inchangés, captures identiques au bit près). Cause non déterminée à ce stade ; contournement possible via le presse-papiers et `Ctrl+V`, non concluant ici car le composer d'une conversation en erreur de connexion est désactivé par conception.
3. **Machine non propre.** Le profil contenait 54 conversations préexistantes. L'état de « premier lancement » n'a donc pas pu être testé sur un profil vierge.
4. **Aucune écriture dans la base de code.** Les preuves sont des captures ; la seule modification du dépôt à ce commit est `docs/ROADMAP.md`.

## Artefacts

Les 20 captures référencées (`01` à `20`) sont dans ce dossier. Les plus significatives :

- `07-conversation-ouverte.png` — session connectée au sidecar natif, agent `Running`
- `08-reponse-recue.png` — tour modèle live terminé + état stale
- `14-conversation-host-mort.png` — `Disconnected`, `Reconnect`, envoi bloqué, transcript conservé
- `15-apres-reconnect.png` — échec de reprise structuré et honnête
- `20-envoi-host-mort.png` — texte préservé, aucun envoi sans host

## Reproductibilité

```powershell
# 1. Dépendances et artefact frontend
npm ci
npm run build

# 2. Sidecar natif (binaire non versionné)
Copy-Item "$env:LOCALAPPDATA\Programs\muse\muse-bin-1.3.0-R3401.1.exe" `
          "src-tauri\binaries\muse-x86_64-pc-windows-msvc.exe" -Force

# 3. Application
npm run tauri -- dev

# 4. Contrôles transport (indépendants de l'UI)
node scripts/native-smoke.mjs --exercise-control --exercise-errors --exercise-approval `
  --exercise-isolation --exercise-user-shell --exercise-reconnect --exercise-history `
  --exercise-reasoning --exercise-model --exercise-queue --exercise-compaction `
  --report smoke-win.json
```

Résultat du smoke sur ce binaire : `distinctWorkspaces: true`, `sessionDurability: "ephemeral"`,
`sessionRead: "unsupported"`, `viewPage: "unsupported"`, `terminalNotification: "unsupported"`,
`userShell` accepté mais `itemStarted: false` / `historyItem: false`,
`reasoningEffort` accepté mais `projection: "not-reported"`,
`modelSelection` accepté mais `active: false`, `compaction: "missing-run"`, queue et `turn/unqueue` acceptés.
