# Computer use — plan complet et implémentation (22 septembre 2026)

## Décision

Muse Desktop n'implémente **pas** de contrôle du bureau. Il **embarque cua-driver** (projet open source [trycua/cua](https://github.com/trycua/cua), MIT) comme moteur, en adopte l'architecture « app-hosted service », et n'ajoute que ce que le driver n'a pas : **une surface de consentement unique**, un **manifeste de capacités** que l'application génère et approuve, et le **branchement de l'agent** via MCP.

Ce que ça remplace : la liste d'applications (`browser`, `finder`, `terminal`, `editor`) dont trois entrées n'étaient lues par aucun code, et un `desktop_control.rs` natif qui ne savait qu'observer et cliquer, sans que l'agent puisse s'en servir.

## Ce qui est mesuré sur cette machine (driver 0.28.2)

| Fait | Mesure |
|---|---|
| Driver installé et sain | `cua-driver doctor --json` → `ok: true` : binaire, `interactive session` (session 1, bureau attaché), `UI Automation` (`CoCreateInstance(CUIAutomation)` OK), 15 fenêtres |
| Surface d'outils | `cua-driver list-tools` → **76 outils** (desktop, navigateur CDP, presse-papiers, enregistrement, sessions, curseur d'agent) |
| Invocation MCP | `cua-driver manifest` → `mcp_invocation = ["<…>\cua-driver.exe", "mcp"]` |
| Démon privé sur canal nommé | `cua-driver serve --socket \\.\pipe\muse-cp` → `daemon is running`, `call get_screen_size` → `{"width":1920,"height":1080,"scale_factor":1.0}` |
| Mode borné **appliqué par le driver** | manifeste `{"version":1,"mode":"bounded","expires_after":"1h","idle_timeout":"15m","allow":{"tools":["get_screen_size"]}}` → `permission mode: bounded (trusted_startup_configuration)`, `capability manifest: configured=true, approved_at_startup=true, valid=true` + **sha256** ; `get_screen_size` passe, `list_windows` renvoie **`Permission denied: tool 'list_windows' is outside the capability manifest`** |
| Droits administrateur | non requis (documenté et constaté) |
| Licence | MIT, aucune restriction commerciale (le chemin `cua-agent[omni]` tire ultralytics AGPL — **hors périmètre**, on n'utilise que le driver) |

## Architecture

```
Muse Desktop (Tauri, session interactive, propriétaire du consentement)
  │
  ├─ 1. démarre UNE fois son propre service, sur un canal nommé à lui :
  │      cua-driver serve --socket \\.\pipe\muse-desktop-computer
  │                     --permission-mode bounded
  │                     --capability-manifest <manifeste généré par l'app>
  │                     --approve-capability-manifest
  │      (mode et manifeste figés à vie du processus ; l'agent ne peut pas les élargir)
  │
  ├─ 2. UI : un interrupteur « Computer use », l'état du driver, le résumé des
  │      autorisations, le sha256 du manifeste, et Révoquer.
  │
  └─ 3. branchement de l'agent : le host Muse reçoit, dans `config.mcpServers` :
         { transport: "stdio", command: <cua-driver.exe>, args: ["mcp", "--socket", <canal>] }
         → l'agent appelle click / type_text / get_window_state / … (76 outils)
```

Pourquoi un démon plutôt qu'un `cua-driver mcp` par session : la documentation du driver est explicite — **chaque `mcp` sans `--socket` possède son propre runtime**, les instances ne partagent rien, et « ne vous fiez pas à la découverte ambiante ». Un seul démon, un seul canal, des sessions MCP multiples : c'est le modèle « App-hosted service » que CUA documente pour une application desktop signée qui sert un agent externe.

Pourquoi le manifeste est à nous : le driver « ne rend ni modale ni bandeau d'autorisation ». Le consentement est donc notre travail — et c'est exactement ce que la mesure ci-dessus permet de faire proprement, puisque le driver **refuse** lui-même tout outil hors manifeste.

## Plan

### Phase A — l'interrupteur (UI, ne dépend d'aucun binaire)

- Le panneau Desktop devient **Computer use** : un interrupteur, pas une liste d'applications.
- Ce qu'il montre : état du driver (absent / version / sain), la session interactive, le nombre d'outils accordés, le sha256 du manifeste, et **Révoquer**.
- Trois niveaux, pas 76 cases :
  1. **Observer** — captures, fenêtres, arbre d'accessibilité (lecture seule).
  2. **Observer et agir** *(défaut)* — ajoute souris, clavier, fenêtres.
  3. **Tout** — ajoute presse-papiers, navigateur CDP et enregistrement, avec avertissement explicite sur le presse-papiers.
- Les bascules `finder`, `terminal`, `editor` disparaissent : aucun code ne les lisait. Le grant `browser` reste, mais **là où il est appliqué** (panneau Browser), et il est renommé pour ne plus se confondre avec Computer use.

### Phase B — le service natif (`src-tauri/src/computer.rs`)

- `computer_status` : trouve le binaire (PATH puis `%LOCALAPPDATA%\Programs\Cua\cua-driver\bin`), lit `--version`, `doctor --json`, `list-tools`, et l'état de **notre** canal.
- `computer_enable(level)` : écrit le manifeste dans le dossier de données de l'app, démarre le démon sur le canal privé, vérifie par `status --socket` (mode, manifeste approuvé, sha256).
- `computer_disable` : `revoke --all --socket` puis `stop --socket`.
- `computer_manifest` : le manifeste courant, pour que l'UI montre ce qui est accordé.
- Rien de tout cela n'accepte un chemin ni un argv venant du renderer : le canal, le binaire et les arguments sont construits en Rust, comme pour `muse_auth`.
- L'installation du driver **n'est pas silencieuse** : si le binaire manque, l'app affiche la commande officielle et la copie. Télécharger et exécuter un script distant est une décision de chaîne d'approvisionnement, pas un détail d'implémentation.

### Phase C — brancher l'agent

- Un helper `computerUseMcpServer(status)` produit l'entrée stdio, fusionnée dans `buildHostMcpServers` quand l'interrupteur est actif.
- Effet : **nouvelles conversations** et **conversations reprises**. Le panneau propose « Appliquer à cette conversation » (une reprise), parce que la liste MCP est fixée à `session/start`/`session/resume`.
- L'agent ne démarre **pas** de second service : il reçoit un canal, pas un binaire à lancer.

### Phase D — approbations et honnêteté

- Le plafond est le manifeste (driver) ; l'approbation geste par geste reste celle du host Muse (mode d'approbation de la conversation), à vérifier.
- La copie dit ce que le sandbox ne couvre pas : **les actions souris/clavier sortent du workspace** ; le sandbox de Muse protège le dossier, pas le bureau.
- Le curseur d'agent du driver est visible à l'écran : c'est la contrepartie honnête d'un agent qui agit.

### Phase E — vérification

- Tests Rust purs : construction du manifeste (niveaux → listes d'outils), analyse de `doctor`/`status`, garde structurelle sur la charge utile rendue au renderer.
- Script vivant : activer → vérifier `status` (mode borné, manifeste approuvé) → appeler un outil autorisé et un outil refusé → vérifier que `config.mcpServers` de la session contient le driver → désactiver → vérifier l'arrêt.
- Sonde UI : un seul interrupteur, plus de liste d'applications, état lisible.

## Hors périmètre, explicitement

- Installer le driver à la place de l'utilisateur (voir Phase B).
- Les VM/sandboxes de CUA (`Image.windows()`, Lume, Docker) : c'est l'autre moitié du projet, pour des ordinateurs jetables. Ici, l'utilisateur veut **sa** machine.
- `cua-agent`/`cua-computer` (Python) : l'agent, c'est Muse. On ne branche que le driver.
- macOS/Linux : le driver les couvre, mais rien ne sera prétendu sans mesure. `doctor` dira `supported: false` là où ce n'est pas vrai, comme `desktop_control.rs` le faisait déjà.

## État : phases A, B et C livrées et vérifiées (22 septembre 2026)

`node scripts/ux-computer-use.mjs` sur l'application vivante :

```
etat initial   {"driverVersion":"cua-driver 0.28.2","available":true,
                "levels":{"observe":19,"control":38,"everything":57},
                "grantState":"stopped","unclassified":[]}
activation     {"grantState":"active","tools":19,"digest":"65892b621c3d1839"}
entree MCP     {"transport":"stdio","command":"…\\cua-driver.exe",
                "args":["mcp","--socket","\\\\.\\pipe\\muse-desktop-computer"]}
application    get_screen_size → { "height": 1080, "width": 1920 }
               click           → Permission denied: tool 'click' is outside the capability manifest
revocation     {"grantState":"stopped"} — manifeste retiré
```

Verdict : `PASS`. Ce qui est prouvé, dans l'ordre où ça compte :

1. le driver est trouvé, versionné et sondé **par Rust** (7 sondes `doctor` rendues au renderer) ;
2. les trois niveaux portent sur la surface réelle du driver (19 / 38 / 57), **aucun outil non classé** ;
3. activer démarre un service borné avec **notre** manifeste, et **c'est le driver qui l'applique** : `get_screen_size` répond, `click` est refusé ;
4. l'entrée MCP remise au host vise **notre propre canal nommé**, et disparaît dès que le grant n'est plus actif ;
5. révoquer arrête le service et retire le manifeste.

Ce qui n'est pas encore prouvé : un tour réel où **le modèle** appelle un outil `computer_*` (il faut une conversation et des crédits), et l'application du changement de niveau à une conversation déjà ouverte — la liste MCP est fixée à `session/start`/`session/resume`, donc il faut une reprise.

## Risques connus, mesurés ou documentés

| Risque | Traitement |
|---|---|
| Une session non interactive (Session 0, service, SSH) ne voit pas le bureau | `doctor` le dit ; l'app refuse d'activer et affiche la raison |
| Deux runtimes concurrents ne partagent rien | un seul canal, possédé par l'app, jamais de découverte ambiante |
| Sessions simultanées : écran, clavier et focus partagés | à documenter dans l'UI ; un drag ne doit pas être réparti sur deux appels |
| Le grant expire en cours de route | `expires_after`/`idle_timeout` sont des constantes de l'app, affichées ; mesure de l'effet réel en Phase E |
| Chromium/Electron en arrière-plan, apps élevées | refus structuré `background_unavailable` du driver ; à relayer tel quel |
