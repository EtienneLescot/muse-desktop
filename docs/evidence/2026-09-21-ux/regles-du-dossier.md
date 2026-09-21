# Les règles du dossier, et les vrais niveaux de réflexion (21 septembre 2026)

Deux sujets, une même cause : **le client inventait un vocabulaire que le backend n'a pas.** Il gardait des « instructions de projet » dans `localStorage` alors que le CLI lit des règles dans le dossier, et il proposait sept niveaux de réflexion alors que le contrat MSP en déclare huit — dont un mal étiqueté.

## 1. Les instructions appartiennent au harnais, pas au client

Décision : **on ne touche pas aux `AGENTS.md` de l'utilisateur.** Ce fichier lui appartient, et c'est au CLI de l'écrire (`muse init`, `/rules import`). Notre champ `instructions` de projet disparaît donc — pas remplacé par un fichier, simplement retiré — et ce qui le remplace est une **lecture** de ce que le harnais charge réellement.

### Ce que le CLI documente, dans ses propres chaînes

| Fait | Source |
|---|---|
| `muse init` écrit `<dossier>/AGENTS.md`, « read as project rules when it runs in this directory » | binaire 1.3.0 |
| `CLAUDE.md` n'est sondé **que** si `AGENTS.md` est absent | « directly probe the active workspace's `AGENTS.md`; only when it is absent, directly probe its `CLAUDE.md` fallback » |
| Règles personnelles : `~/.claude/CLAUDE.md` et `$CODEX_HOME/AGENTS.md` (défaut `~/.codex/AGENTS.md`) | message de `/rules import` |
| Ordre de précédence : utilisateur puis projet, **le fichier le plus profond gagne** | « If project rules files conflict, the deeper file wins over the shallower one » |
| Le host injecte lui-même un bloc `<rules-file scope="" path="" written-for="">` | chaîne de gabarit |
| Le CLI a une commande `/rules` — « Show which md files govern this session » | table des commandes |

### Ce que MSP n'expose pas

`muse schema generate-json-schema` (export hors ligne, exact pour ce binaire) : **46 méthodes, 28 notifications, et aucune ne parle de règles.** Le seul champ qui contient « rule » est `rulePreview`, sur les approbations. Aucune définition ne mentionne `AGENTS.md` ni `rules-file`.

Le client ne peut donc pas demander au host ce qu'il a chargé. Lire les mêmes fichiers que lui est la seule option honnête — d'où `rules_scan`, borné, en lecture seule.

### La sonde

`src-tauri/src/rules.rs` ne connaît que quatre rôles, jamais un chemin arbitraire :

| id | rôle | statut |
|---|---|---|
| `user-claude` | `~/.claude/CLAUDE.md` | `fallback` (soumis à la politique de contexte personnel) |
| `user-codex` | `$CODEX_HOME/AGENTS.md` | `fallback` |
| `project-agents` | `<dossier>/AGENTS.md` | `governs` s'il existe |
| `project-claude` | `<dossier>/CLAUDE.md` | `governs` si `AGENTS.md` absent, sinon `superseded` |

Trois garanties structurelles, chacune testée :

- **aucune écriture** — un test écrit un `AGENTS.md`, sonde deux fois, et compare octets **et** date de modification ; il vérifie aussi que le fichier de repli n'est pas créé ;
- **vocabulaire fermé** — un test épingle les quatre ids, les deux portées et les quatre statuts, parce que le renderer bascule dessus ;
- **contrat inter-langages** — un test sérialise la charge et épingle les noms de champs exacts (`observedAt`, `governing`, `truncated`…) que `src/lib/harnessRules.ts` lit. Une renommage camelCase perdu se verrait sinon comme un panneau vide.

### Mesuré sur le pont vivant

`node scripts/ux-rules-scan.mjs --workspace G:\repos\openscreen` — le dossier réel de l'utilisateur, avec ses **23 417 octets** d'`AGENTS.md` :

```
project-agents   governs     present=true   bytes=  23417  G:\repos\openscreen\AGENTS.md
user-claude      fallback    present=true   bytes=   1320  C:\Users\etien\.claude\CLAUDE.md
user-codex       fallback    present=true   bytes=      0  C:\Users\etien\.codex\AGENTS.md
project-claude   absent      present=false  bytes=      0  G:\repos\openscreen\CLAUDE.md
```

Le script vérifie depuis Node, pas depuis la charge utile, que chaque ligne correspond au disque, et que les fichiers sont **inchangés** (octets + mtime) après l'appel. Verdict : `PASS`.

Sur `muse-desktop`, aucun `AGENTS.md` : le résumé dit « No rules file in this folder; 1 personal rule file applies as a fallback. » — pas un silence, pas une invention.

### Le rendu, vérifié dans l'application

`node scripts/ux-project-rules.mjs` ouvre Projets, déplie `openscreen` et lit le DOM rendu :

- `textarea[aria-label^="Instructions for project"]` : **0** — le champ retiré a bien disparu ;
- quatre lignes, statuts `Fallback`/`Fallback`/`Loaded`/`Missing`, chacune avec son explication ;
- résumé : « AGENTS.md in this folder governs the session (22.9 KB). » ;
- **aucun chemin verbatim** ;
- débordement mesuré de 1440 à 760 px : **0 px pour le bloc de règles**, à toutes les largeurs.

Deux fuites subsistent dans le panneau à 820 px (`.workspace-root-row +32`, deux fois) et 760 px (`.project-actions +12`). Elles sont **antérieures** : mesurées à l'octet près avec le bloc de règles masqué puis affiché, elles sont identiques. Le script les imprime comme telles au lieu de les fondre dans sa vérification.

### Le piège trouvé par la mesure

La première version renvoyait `\\?\C:\Users\…\AGENTS.md`. `canonicalize()` sous Windows produit un chemin verbatim : c'est le même fichier, mais pas ce que l'utilisateur a choisi ni ce que le projet stocke — le panneau aurait affiché un chemin différent du champ « Folders » juste au-dessus. Corrigé par `display_path`, testé sur les trois formes (verbatim, UNC, POSIX).

À noter : `skills::scan` a le même défaut, non corrigé ici pour ne pas mélanger deux sujets.

## 2. Les niveaux de réflexion : sept sur huit, et une description fausse

Question posée plus tôt : « ça correspond vraiment aux différents niveaux de réflexion de Muse Spark ? » Réponse mesurée : **non.**

Le contrat (`$defs.ReasoningEffort` du schéma exporté, et `muse --help` pour `--reasoning-effort`) déclare huit valeurs :

```
none, minimal, low, medium, high, xhigh, max, ultra
```

Notre liste en avait **sept** : `max` manquait. Et deux validateurs le rejetaient de leur côté — `validate_reasoning_effort` dans Rust, et une liste recopiée à la main dans le panneau Projets. Le symptôme visible était donc un refus du client pour une valeur que le moteur accepte.

Vérifié sur un host vivant (`scripts/msp-reasoning-tiers.mjs`, huit niveaux) : **les huit répondent `accepted` et émettent `session/reasoningEffortChanged` avec la valeur envoyée**, `max` compris. Le script lit désormais la valeur annoncée plutôt que `session/read`, qui ne projette pas ce champ — il rapportait `kept: false` pour tout le monde, ce qui était un artefact de mesure, pas un downgrade.

Le CLI porte en réalité **deux** vocabulaires : `WireReasoningEffort` (huit valeurs, celui du contrat et de `--reasoning-effort`) et `ReasoningEffortV1` (sept, celui des réglages persistants, sans `max`). `none` est sur le fil mais pas dans les niveaux persistants ; `ultra` y est décrit comme « the saved client selection ». C'est ce qui explique la question posée : les deux listes existent, et nous avions recopié ni l'une ni l'autre.

Les descriptions étaient également fausses sur un point précis. Le CLI écrit :

> For Meta, the persistent effort tiers are `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, and `ultra`. `high` is the default Meta baseline; `xhigh` is the opt-in premium precision tier. `ultra` remains the saved client selection, **uses `max` reasoning on the Meta wire** (ADR 19425 D63), and currently enables proactive workflow/delegation guidance when that tool surface is available. It may proactively run multi-agent workflows and increase token usage quickly.

Autrement dit `ultra` n'est **pas** un neuvième niveau plus profond : c'est `max` **plus** de l'autonomie (workflows, délégation), avec un coût en jetons. Notre texte disait « Maximum reasoning depth; responses may take longer » — faux, et le genre de faux qui fait choisir `ultra` en croyant choisir une profondeur. Corrigé, et un test interdit le retour de cette formulation.

`none` n'est pas un niveau persistant côté CLI, mais le contrat le déclare et le host l'accepte : il reste proposé.

## Fichiers

- `src-tauri/src/rules.rs` (nouveau) + `rules_scan` dans `main.rs` ; `muse_auth::home_dir` partagé.
- `src/lib/harnessRules.ts` (nouveau) + `test/harnessRules.test.ts`.
- `src/lib/projects.ts` : `instructions` devient optionnel et déprécié, `buildProjectInput` supprimé.
- `src/lib/reasoning.ts`, `validate_reasoning_effort`, liste du panneau Projets : huit niveaux, une seule source.
- `src/components/ProjectsPanel.tsx` : bloc « Rules » en lecture seule, avis ponctuel sur les anciennes instructions.
- `scripts/ux-rules-scan.mjs` et `scripts/ux-project-rules.mjs` (nouveaux), `scripts/msp-reasoning-tiers.mjs` (mis à jour).

Tests : **220 Rust, 1102 Node, 0 échec.** Build vert.

Migration : les deux projets présents sur cette machine avaient `instructions: ""` — vérifié dans le `localStorage` de l'application lancée. Rien n'est perdu ici ; une valeur non vide resterait affichée avec **Copy** et **Dismiss**, et n'est plus jamais envoyée.

## Ce qui reste ouvert

- `workspaces[]` (multi-dossier) n'a toujours aucun équivalent backend — à retirer.
- « Start in » reste ambigu face au sélecteur de dossier.
- La case worktree au démarrage exige une variante de `git_worktree_create_session` sans session parente.
- `AuthMode::Account` n'est jamais produit par `decide()` — le mode est donc toujours soit `api_key`, soit `none`. À trancher : retirer la variante, ou distinguer un login de compte d'une clé API.
