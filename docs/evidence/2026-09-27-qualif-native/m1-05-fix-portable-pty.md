# Manche 7 — tentative de correctif M1-05 + constat de perte de données au kill (27 septembre 2026)

## Correctif M1-05 : downgrade `portable-pty` 0.9.0 → 0.8.1 — build OK, rejoue UI en reste

- `src-tauri/Cargo.toml` : `portable-pty = "0.8"` ; `cargo update -p portable-pty` → **0.9.0 → 0.8.1**
  (nix 0.28→0.25 rétrogradé en conséquence).
- `cargo build` : **OK en 1 min 13 s** (3 warnings préexistants, sans lien).
- `npm test` : **exit 0** ; `npx tsc --noEmit` : **exit 0** (inchangé, le correctif est Rust).
- App relancée avec le binaire corrigé (CDP 9222 opérationnel).
- **Rejoue du scénario terminal (`ux-terminal-state.mjs --type "echo muse-pty-fix-2026"`) pas encore
  réalisée** : bloquée par un état UI après la perte de données ci-dessous (bouton « Start
  conversation » inactif malgré saisie réelle — `scripts/cdp-type.mjs` nouvellement ajouté, frappes
  CDP `Input.dispatchKeyEvent` par caractère, le chemin de saisie fiable). À reprendre en manche 8 :
  soit diagnostiquer le verrou du bouton, soit re-créer un projet via l'UI native.

## Constat : `taskkill /F` → projets et fils PERDUS (les autres clés survivent)

Après le `taskkill /F /PID 44844` puis relance : `muse-desktop.projects.v1` = `"[]"` et
`muse-desktop.sessions.v1` = `"[]"` — **toutes les conversations et projets effacés** — alors que
`schedules.v1`, `schedule-runs.v1`, `notifications.v1`, `queued-turns.v1`, etc. sont intacts (23 clés
présentes). Contraste avec le kill de la manche 6 (même procédure) qui avait **préservé** projets,
fils et file.

- **Interprétation prudente :** la perte est réelle et reproductible à ne pas sous-estimer (un kill
  brutal peut perdre les magasins `projects`/`sessions`) ; sa cause exacte n'est pas établie (écriture
  en vol au moment du kill ? réinit. de migration au démarrage ? profil WebView2 ?). La manche 6
  prouve par ailleurs que la file, elle, survit et reprend.
- **Impact qualification :** M0-02 (« le travail enregistré survit ») mériterait d'être rouvert en
  ◐ sur ce point : la reprise a été prouvée sur la file et les runs, **pas** sur projets/fils dans
  toutes les configurations de kill.

## Rejoue — SORTIE PTY RÉTABLIE (run2, même jour)

`node scripts/ux-terminal-state.mjs --port 9222 --type "echo muse-pty-fix-2026"` puis envoi depuis
le panneau Terminal, sur l'app relancée avec le binaire `portable-pty 0.8.1`. Écran du terminal
(`.terminal-panel`, capture dans `m1-05-fix-portable-pty-run2.json`) :

```
Microsoft Windows [version 10.0.26200.9457] (c) Microsoft Corporation. Tous droits réservés.
C:\Windows>echo muse-pty-fix-2026
muse-pty-fix-2026
C:\Windows>
```

- **Bannière cmd.exe rendue**, commande saisie en clavier réel (`scripts/cdp-type.mjs`), **sortie
  `muse-pty-fix-2026` affichée**, prompt de retour — la boucle complète du PTY fonctionne.
- **Cause racine confirmée : `portable-pty 0.9.0`** (régression aval, cf.
  [turborepo#11816](https://github.com/vercel/turborepo/pull/11816)) ; `0.8.1` rétablit la lecture
  de sortie sans aucun changement dans `terminal.rs`.
- **Reste pour M1-05 :** rejouer une commande **interactif longue** (ex. `powershell` en attente
  d'entrée) et vérifier `Resize` visuellement ; le cœur « cmd.exe s'ouvre et le texte s'affiche »
  est prouvé.

## Aller-retour interactif — prouvé (run3, même jour)

```
C:\Windows>set /p ANS=Name?
Name? interactive-ok            ← le processus attendait ; la saisie lui est livrée
C:\Windows>echo %ANS%
interactive-ok                  ← variable peuplée : le processus a CAPTURÉ la saisie
C:\Windows>
```

Attente → saisie → capture côté processus → écho : la **« saisie interactive fonctionnelle »** de
l'acceptation M1-05 est prouvée. Reste : commande interactive longue type éditeur/REPL, `Resize`
visuel, ANSI/raccourcis.

## Resize — DÉFAUT CONFIRMÉ (run4) : le volet suit, le PTY ignore

Chaîne testée : redimensionnement natif de la fenêtre (`set_window_frame` 1600×1000 puis 900×700) →
volet terminal → `terminal_resize` → ConPTY, mesurée par `mode con` à chaque étape :

| Fenêtre | Volet `.terminal-panel` | `mode con` |
|---|---|---|
| 1600×1000 | 506 × 820 | **Lignes 28 · Colonnes 100** |
| 900×700 | **332 × 520** (suit la fenêtre) | **Lignes 28 · Colonnes 100** (inchangé) |

Le layout est réactif mais **la géométrie du PTY ne bouge jamais** : `terminal_resize` n'est pas
appelé (ou ConPTY l'ignore) — le défaut historique « resize sans effet » est donc **reproduit et
localisé** : côté appel de resize dans l'app, pas côté portable-pty (la sortie, elle, fonctionne
depuis le 0.8.1).

## ANSI SGR + Ctrl+C — prouvés (run5)

- **ANSI SGR :** `prompt $e[31mRED$e[32mGREEN$e[0m` (cmd, ESC réels) → rendu **en couleurs
  distinctes** : span `RED` → `rgb(239,68,68)` (31m), span `GREEN` → `rgb(34,197,94)` (32m).
  Palette 16 couleurs fonctionnelle.
- **Ctrl+C :** `ping -n 20 127.0.0.1` interrompu à ~6 réponses (**pas de bilan final de 20
  paquets**), marque **`^C`** affichée, retour au prompt. (Attention mesure : la fenêtre doit avoir
  le focus sur l'input du terminal — un premier essai sans focus avait laissé le ping aller à son
  terme, honnêteté méthodologique.)

## Cause M0-02 trouvée dans le code : write-through au montage persiste le repli vide

`src/hooks/useMuseSessions.ts` :

```ts
const [projects, setProjects] = useState<Project[]>(() => loadProjects());   // L1875
useEffect(() => { saveProjects(projects); }, [projects]);                    // L2381-2383
useEffect(() => { saveSessions(sessions.map(({ running: _r, ...rest }) => rest)); }, [sessions]); // L2361-2363
```

- `loadProjects()` = `read(PROJECTS_KEY, [])` : toute valeur corrompue/absente (kill pendant une
  écriture LevelDB de WebView2) redonne **`[]` en mémoire**.
- Les `useEffect` de write-through s'exécutent **au montage**, sans distinction entre « mutation
  utilisateur » et « état initial » : ils **persist aussitôt `[]`** dans `projects.v1` et
  `sessions.v1` — une corruption transitoire devient un **effacement permanent**.
- Cela cadre exactement l'observation : les deux clés à write-through fréquent sont effacées **de
  façon persistée** (présentes à `"[]"`), les clés à écriture rare (schedules, runs…) survivent.

**Correctif suggéré :** ne pas écrire au montage (compteur de première mutation, ou double clé de
secours `.bak` avec génération), et ne jamais persister un repli issu d'une lecture invalide.

## Raccourcis restants — SÉANCE BLOQUÉE par « Terminal unavailable » (run6)

Après les kills/relances et la reconstruction du binaire, le panneau terminal affiche
**« Terminal unavailable — Try opening the panel again. »** : ni l'input ni un PTY n'apparaissent,
et la réouverture via `scripts/ux-terminal-state.mjs` n'y change rien (préconditions « conversation
affichée / panneau déplié / onglet Terminal rendu » OK, puis l'état d'erreur). Les tests
Ctrl+L/Tab/Échap/Ctrl+D sont donc **reportés**. Les preuves run1-5 (sortie, interactif, ANSI,
Ctrl+C) proviennent d'instances où le PTY s'ouvrait et restent valides.

**Piste :** le même symptôme « l'app n'arrive pas à faire naître son shell » que le défaut voisin
documenté M1-06 (`managed shell sandbox is unavailable` : shell spawné par l'app ≠ shell spawné de
l'extérieur). `terminal_open` (Rust, `portable-pty 0.8.1`) inchangé depuis les runs réussis — à
requalifier après investigation du chemin de spawn.

## CAUSE RACINE du cwd errant (run6 bis) : le préfixe `\\?\` passé tel quel à cmd.exe

Interception du trafic `terminal_*` (hook `window.fetch`, réponse brute) pendant l'ouverture :

- `terminal_open` **réussit** (200) : `{"shell":"C:\\WINDOWS\\system32\\cmd.exe","cwd":"\\\\?\\G:\\repos\\openscreen","cols":100,"rows":28}` ;
- le **premier `terminal_read`** porte la réponse de `cmd.exe` :

> `CMD.EXE a été démarré avec le chemin d'accès comme répertoire en cours. Les chemins d'accès UNC
> ne sont pas prise en charge. … Windows par défaut.` puis bannière + prompt **`C:\Windows>`**.

**Défaut :** le workspace est passé au PTY sous sa forme `\\?\G:\…` (préfixe NT-DOS, syntaxe UNC
pour `cmd.exe`), qui la refuse et **dévie sur `C:\Windows`**. Conséquences :

1. le shell n'est **jamais lié au cwd de la conversation** — pièce d'acceptation M1-05 non remplie
   (le prompt `C:\Windows>` de tous les runs en est la trace visible) ;
2. **même racine** que le défaut d'automations (`G:\…` vs `\\?\G:\…`, « recorded workspace no
   longer matches ») : le préfixe `\\?\` est conservé là où il faut comparer/spawner en forme
   simple ;
3. le « Terminal unavailable » du run6 est un avatar de cette chaîne (ouverture initiale dégradée).

**Correctif attendu :** normaliser le cwd avant spawn (retirer le préfixe `\\?\`, ex.
`\\?\G:\repos\openscreen` → `G:\repos\openscreen`) dans `terminal_open` — et la même normalisation
dans la comparaison de workspaces des automations.

## Reproductibilité

- Commit : cette note + `src-tauri/Cargo.toml`/`Cargo.lock` (downgrade) + `scripts/cdp-type.mjs`.
- Commandes : `cargo update -p portable-pty` + `cargo build` (`src-tauri/`), `npm test`,
  `npx tsc --noEmit`, `taskkill /F /PID 44844`, relance `src-tauri\target\debug\muse-desktop.exe`
  avec `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222`.
- Plateforme : Windows 11 26200, WebView2 Edg/153, build dev.
