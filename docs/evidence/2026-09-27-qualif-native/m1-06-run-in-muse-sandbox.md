# M1-06 — Run in Muse : chaîne prouvée jusqu'au fil, exécution cassée en contexte app (27 septembre 2026)

**Trois faits nets, mesurés aujourd'hui :**

1. **La chaîne `Run in Muse` fonctionne dans l'app** : bouton activé dès qu'une commande est
   saisie (raison exacte : « Run this command through the Muse host (userShell) »), clic →
   **item `userShell` publié et affiché dans le fil en 1 s** (`Tool $ echo muse-m1-06-probe`),
   avec sa sortie en clair. L'item et sa sortie arrivent bien dans la conversation.
2. **Le host exécute réellement les commandes** — mais seulement en host externe : la sonde
   [`msp-user-shell-items.mjs`](../../../scripts/msp-user-shell-items.mjs) (post-`setup`) mesure
   `item/started` → `item/completed` en **78 ms** avec **`markerEchoed: true`** — la commande a
   tourné.
3. **Dans l'app, la même commande échoue** : `tool failed: environment failure: managed shell
   sandbox is unavailable`, sur session **fraîche** comme sur session reprise, avant et après
   redémarrage du host.

## La racine : la sandbox Windows n'était pas installée (corrigé), puis un défaut de contexte

### Étape 1 — setup manquant (cause des échecs initiaux)

```powershell
& src-tauri\target\debug\muse.exe sandbox windows check
# backend=windows_elevated status=setup_required
# diagnostic=sandbox_users_missing
# diagnostic=setup_credentials_unavailable … C:\ProgramData\muse: Le fichier spécifié est introuvable

& src-tauri\target\debug\muse.exe sandbox windows setup
# backend=windows_elevated status=ready
# sandbox_users_ready=true capabilities_ready=true wfp_ready=true
```

**Enseignement M0-10 :** la machine de dogfood exige `muse sandbox windows setup` (élevé) avant
tout shell — modèle ou utilisateur. À intégrer au parcours « premier lancement ».

### Étape 2 — discriminants écartés (tout fonctionne hors de l'app)

Sonde `msp-user-shell-items.mjs` rejouée après setup, `markerEchoed: true` dans **toutes** les
configurations :

| Configuration | Résultat |
|---|---|
| workspace `C:\Users\etien\AppData\Local\Temp` | ✓ exécute |
| workspace `G:\repos\openscreen` (celui de l'app) | ✓ exécute |
| `serve --sandbox-network restricted --trust-workspace` (flags exacts de l'app) | ✓ exécute |
| binaire `src-tauri\target\debug\muse.exe` (celui de l'app) | ✓ exécute |

Donc **ni** le workspace (lecteur `G:`), **ni** `--trust-workspace`, **ni** le binaire.

### Étape 3 — ce qui reste : le contexte de spawn depuis l'application

- Host de l'app mesuré : PID 40172, **fils de muse-desktop.exe**, créé **15:59:46** — soit
  **après** le setup (15:57) — et l'état machine restait `status=ready` pendant les échecs.
- L'erreur **a changé** après setup : `sandbox enforcement unavailable: windows_elevated
  setup_required` (avant) → `managed shell sandbox is unavailable` (après). Le host voit donc le
  setup mais sa dernière étape échoue uniquement en contexte app.
- L'app ne fixe ni environnement ni `creation_flags` sur le spawn (`main.rs` : aucun `.env(`,
  `.envs(`, `env_clear`, job object) — l'hôte hérite de l'environnement du processus Tauri.

**Constat qualifié :** un host lancé **par** muse-desktop.exe ne peut pas utiliser la sandbox
gérée ; le même binaire avec les mêmes flags lancé depuis un shell fonctionne. La piste est le
contexte de spawn (héritage du processus Tauri / chaîne npm→cmd / jeton), à investiguer côté
correctif.

## Ce que l'erreur mérite quand même d'être saluée

L'échec est modélisé et honnête — l'item affiche :

> `tool failed: environment failure: managed shell sandbox is unavailable` —
> « The execution environment is broken: the command was never started and every later command
> will fail the same way. **Do not retry and do not fabricate command output**; report this
> environment failure. »

Le contrat « erreur d'environnement ≠ capacité absente » tient jusque dans le message.

## Verdict M1-06 Windows

- **Affichage de l'item `userShell` et de sa sortie dans le fil : prouvé.**
- **« La commande aboutit et sa sortie complète est lisible » : prouvé en host externe** (sonde
  post-setup), **bloqué dans l'app** par le défaut de contexte ci-dessus.
- **Add output to prompt : non testable** tant qu'aucune commande n'aboutit dans l'app.
- Reste en plus : repeuplement live de `grantedCapabilitiesBySession` (amorcé : hydratation à la
  (re)connexion prouvée le 27/09).

## Reproductibilité

- Commit `2c11ee3`+ ; Windows 11 26200 ; sidecar/hôte `muse` 1.3.0 (`target\debug\muse.exe`).
- Séquence : `muse sandbox windows check|setup` → `node scripts/ux-run-in-muse.mjs --port 9222
  --click` (dans l'app : échec) → `MUSE_WORKSPACE=… [MUSE_SERVE_ARGS=…] node
  scripts/msp-user-shell-items.mjs` (hors app : succès, `markerEchoed: true`).
