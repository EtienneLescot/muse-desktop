# muse-desktop — Spec produit & technique

> Générée le 2026-09-13 par recherche multi-références (Codex Desktop,
> Claude Desktop, Antigravity, OpenCode, Zed + audit du code existant).
> Positionnement : client desktop dédié, optimisé et brandé **Meta Muse**,
> visant l'excellence fonctionnelle de Codex Desktop / Claude Desktop.
> Les affirmations non sourcées sont marquées **[TROU]** dans le texte.

- [Partie 1 — Spec fonctionnelle (V1/V2)](#muse-desktop--partie-1--spec-fonctionnelle-v1v2)
- [Partie 2 — Spec technique](#muse-desktop--partie-2--spec-technique-depuis-existant-audité)

---
# muse-desktop — PARTIE 1 : Spec fonctionnelle (V1/V2)

> Périmètre : client desktop Tauri+React adossé au CLI `muse serve` (sidecar). Équivalent premium brandé Meta Muse de Codex Desktop / Claude Desktop. Contexte existant prouvé : multi-sessions, streaming par polling, approbations par choix, input answerable (`input_requested`), persistance locale. Sources : preuves `audit-local`, `ref-codex`, `ref-claude`, `ref-antigravity`, `ref-opencode`, `ref-zed` + compléments inspectés (rules/approvals Codex, benchmarks IntuitionLabs, pricing CloudZero, DZone/Warp/HN/arXiv mémoire-worktree, schéma MSP, PivotSearch, issues perf Codex, docs Tauri sidecar). Tout ce qui n'est pas sourcé est marqué [TROU].

## 1. Vision & positionnement

**V1 — Command center local fiable.** `muse-desktop` = coquille premium Meta Muse autour d'un seul `muse serve` partagé, multiplexé par `sessionId` ; 1 host par workspace (changer de workspace tue/respawn l'ancien ; handshake `initialize` puis `notify initialized`) [audit-local main.rs]. Transport JSON-RPC 2.0 ligne-par-ligne, `commandId` UUIDv7, timeout 120 s [audit-local msp.rs]. Streaming par polling (buffer 2000 évts, `poll_events/since`), car push `listen` ne déclenchait jamais dans un env [TROU : env non identifié] [audit-local main.rs]. Poll UI 150 ms streaming / 1000 ms idle, chaîne sérialisée anti-doublons + kick après send/answer/approve ; statuts running/stopped dérivés des kinds `turn/*` [audit-local useMuseSessions]. Persistance locale `localStorage` : sessions, log append-only capé 2000 entrées/session, workspace, activeId, tombstones capés 500 [audit-local persist.ts]. Packaging : `externalBin binaries/muse` + `resolve_sidecar()` (exe-dir puis src-tauri/binaries) [audit-local tauri sidecar] ; seul binaire linux présent [TROU packaging Win/Mac, voir §12].

**Cible — Parité premium Codex/Claude + doctrine Antigravity.** Codex = command center agents : threads séparés par projets, switch sans perte de contexte, revue diff commentée + ouverture éditeur ; worktrees intégrés (copie isolée/repo, checkout local, reprise sessions/config CLI et IDE) [ref-codex]. Claude = annuaire unifié Skills/Connecteurs/Plugins, MCP local 1-clic (`.mcpb`) + distant, artefacts versionnés fenêtre droite, Projects/RAG, Cowork cloud isolé [ref-claude]. Antigravity = IDE control-plane d'agents (plan/execute/verify sur editor+terminal+browser), Manager Surface async multi-workspaces, « verify with Artifacts, not logs » (plans, task lists, walkthrough + screenshots/recordings, delegate→review→comment→iterate) [ref-antigravity]. OpenCode/Zed = référence transport/config/permissions : `serve [--port --hostname --cors]` (défaut 4096/127.0.0.1, OpenAPI), SDK type-safe, threads multi-agents + checkpoints + compaction, permissions regex allow/deny/confirm, profils Write/Ask/Minimal, ACP standard [ref-opencode/ref-zed].

**Branding premium Meta [TROU total].** Aucun asset lu (favicon seul, icons placeholder, productName générique, CSP null) [audit-local]. Aucune source pour décliner « premium vs Codex/Claude Desktop ». V1 : ne pas spécifier charte, ton, logo, naming. Maquette Figma/UX à trancher [unresolved].

## 2. Personas

| Persona | Besoin | Preuve |
|---|---|---|
| Dev solo multi-projets | threads/projet, switch sans perte, reprise CLI/IDE | Codex threads+worktrees ; Zed threads sidebar + checkpoints |
| Lead / reviewer | review queue, diff commenté, walkthrough avec preuves, merge du meilleur diff | Codex review ; Antigravity artifacts ; Warp (comparer diffs, 1 owner + 1 review) |
| Ops/qualité | automations planifiées (triage issues, CI failures, release briefs), scheduled tasks | Codex Automations ; Antigravity `/schedule` (lun/mer 9h, one-shot/récurrent) |
| Contributeur équipe | partage lien, partage team config/skills, channels/collab temps réel | OpenCode `opncd.ai/s/<id>` (manual/auto/disabled) ; Zed Channels ; Claude Projects view/edit |
| Admin/IT | sandbox configurable, rules projet/équipe, auditabilité, monitoring tokens | Codex sandbox open-source + rules ; InfoWorld (policy enforcement, auditabilité, monitoring tokens) |

## 3. Domaines fonctionnels, stories & acceptation

Conventions : AC = critère testable. MoSCoW : **M**ust V1 / **S**hould V2 / **C**ould V2+ / **W**on't (écarté/documenté). Chiffres = exigences §11.

### 3.1 Conversations / threads / projets
- **US-1 (M-V1) :** en tant que dev je crée/liste/reprends des sessions du host partagé, multiplexées par sessionId. **AC :** `start_session/restore_sessions/send_input/cancel/kill` via sidecar seul canal ; switch session sans perte du log persisté (2000 entrées) ; tombstone durable malgré `restore_sessions` (cap 500).
- **US-2 (M-V1) :** je vois le stream coalescé par `itemId`, sous-agents groupés par `agentId` en `<details>` repliables, `item/completed` ne ferme que son item. **AC :** test unitaire du coalesceur + non-fermeture croisée [audit-local StreamView].
- **US-3 (S-V2) :** j'organise threads par projets, avec historique+docs+instructions, partage view/edit (Team/Enterprise), Free max 5 projets, RAG ~10x [ref-claude Projects]. **AC :** création projet, rattachement threads, partage view/edit, quota 5 en Free simulé.
- **US-4 (S-V2) :** je compacte les longs threads (auto au seuil tokens + `/compact` manuel + `New From Summary`) [ref-zed]. **AC :** compaction déclenchée au seuil, résumé ré-ouvrable en thread neuf. [TROU : seuil tokens muse non sourcé.]
- **US-5 (S-V2) :** threads sidebar multi-agents concurrents, switch ctrl-tab, historique archivable [ref-zed parallel-agents]. **AC :** ≥2 threads actifs visibles, switch < §11.

### 3.2 Orchestration multi-agents visible + worktrees
État prouvé muse : sub-agents possédés par orchestration sidecar, pas de spawn IPC direct ; commandes limitées à start/restore/send/approve/cancel/kill [audit-local]. Schéma MSP stable 1.2.1 (sha c7ff6c5d) : 33 méthodes dont 8 `subagent/*` control-only (close/followupTask/interrupt/readResult/reopen/resume/sendMessage/stop), **aucune méthode spawn/start** stable ni expérimentale ; item `subagent` : objective/role, agentPath, depth (sans max), childSessionId (drill-down via session/read|view/page), controlStatus open, result summary ≤512 chars / text ≤32 KiB ; 0 hit parallel/maxConcurrent/worktree/isolation (seuls caps = pagination view 1-1000, session list max 200, context/output caps) [preuves MSP].
Référence d'isolation (cookbook officiel dev.meta.ai) : limite concurrence ≈ cores-2 clampée 4-8 ; spawns surnuméraires ADMIS et queués FIFO ; démo 6 subagents simultanés ; chaque enfant writer = worktree git privé sous `.muse/worktrees/` detached-HEAD (base_commit, base_ref HEAD, cleanup remove_if_clean), enfants depth 1, commit sur branche propre, checkout parent intact ; cycle `operation_requested>prepared>lease_active>workspace_scope_activated` ; vocabulaire = plan modèle-outil `subagent_spawn(role,objective,worktree_isolation:true)` + wait/read/status ; gate CLI `muse --subagent-worktree-isolation` (sans flag = partagé ; spawn isolation:true rejeté si indisponible) ; fallback dossier = `git worktree add -b taskN-branch` manuel [preuves MSP/cookbook].
- **US-6 (M-V1) :** je vois chaque subagent (agentId, objective/role, depth, status open, résultat tronqué 512/32K) et je le contrôle (interrupt/stop/resume/followup/readResult) via les 8 méthodes. **AC :** chaque contrôle appelle la méthode correspondante ; drill-down childSessionId ouvre session/read.
- **US-7 (S-V2) :** je fane-out via le tour parent (prompt), pas via MSP (pas d'endpoint spawn appelable : le fan-out passe par le prompt du parent ; contrôle wire limité aux 8 méthodes) [unresolved]. **AC :** N demandes parallèles → N enfants visibles, file FIFO au-delà de cores-2 clamp 4-8 [TROU : N absolu officiel inexistant].
- **US-8 (S-V2) :** chaque writer tourne sur worktree privé `.muse/worktrees/` avec cleanup remove_if_clean. **AC :** checkout parent inchangé (hash HEAD avant/après identique) ; branche propre par enfant. Risques long-terme sourcés : même checkout = overwrite/état test contaminé/incompatibilité conjointe → 1 worktree+branche/agent + file-level contract + validation déterministe, jamais d'intégration directe sur branche protégée [DZone] ; minimiser chevauchements (packages/api vs web), sinon 1 owner + autre en review, comparer diffs, noter ordre de merge [Warp].
- **US-9 (C-V2+) :** automations = instructions+skills planifiées background, résultats en review queue (triage issues, CI failures, release briefs) [ref-codex] ; scheduled tasks récurrentes/one-shot (ex. lun/mer 9h), threads réutilisés, réveil jours/semaines [ref-claude/antigravity]. **AC :** création schedule, déclenchement à l'heure, résultat en review queue. [TROU : `workflow/*` sans ligne schéma (spec 14410 open, mslsrc/tbh#14410) → parallélisme workflow non spécifiable sur MSP.]

### 3.3 Streaming / transparence (dont phase réflexive AVANT first token)
État prouvé : pas de SSE ; notifications MSP (`item/delta` L599, `item/started` L649, `item/completed` L587, `view/subscribe` L2034 ; `session/resume` auto-subscribe, `session/read` jamais) routées (`item/delta`→output/subagent_event, approval→tool_request, userInput→input_request) [preuves MSP] ; 0 ligne SSE/EventSource dans src+src-tauri [audit-local] ; aide `muse serve --help` v1.2.1 : host stdio, flags sandbox only, zéro mention streaming/SSE/polling/notifications/view [preuve] ; recherche web MSP noyée par homonymes, aucune release-notes/devdocs trouvée [unresolved].
- **US-10 (M-V1) :** je vois immédiatement l'état réflexif avant le first token (spinner « réflexion… » + phase). **AC :** après send, indicateur < 200 ms ; `item/started` affiché même sans delta ; fast-poll 150 ms vérifié.
- **US-11 (M-V1) :** le stream ne perd ni ne duplique (poll sérialisé, buffer 2000). **AC :** test charge : 2000 évts → aucun doublon, aucun trou `since`.
- **US-12 (S-V2) :** résumé/volet plans/sources/artefacts + sidebar fichiers riches + summary pane [ref-codex MacRumors]. **AC :** volet récapitulatif par thread. [TROU : corps pages 9to5mac/MacRumors non fetchés au-delà snippets → onglets Work/Chat, terminal tabs, previews = snippets seuls.]
- **US-13 (W) :** pas de SSE tant que schéma/CLI ne l'exposent pas. [TROU : framing/listen à re-prouver via `muse serve --help` + SDK.]

### 3.4 Approvals / permissions
État prouvé : `approval/requested` → panneau choix (choiceId/label/decision/scope) ; `approve` exige requirementId + même session (anti-rejeu inter-sessions, -32053 remonte en erreur) [audit-local]. Règles Codex inspectées : `prefix_rule` allow/prompt/forbidden, most-restrictive-wins, champs pattern/justification/match, TUI allow-list → `~/.codex/rules/default.rules`, Smart approvals proposent prefix_rule, règles locales trust-gated, shell split, `codex execpolicy check` ; sandbox+approval deux couches, preset Auto = workspace-write+on-request, `approval_policy` on-request/never/granular, `approvals_reviewer` user/auto_review, `untrusted` retiré → trust_level+execpolicy, domain/network allow/deny [preuves inspectées]. Zed : regex allow/deny/confirm (défaut confirm, ex. `^cargo build`, `sudo` en confirm forcé) ; profils Write/Ask/Minimal (Zed Agent seul) [ref-zed]. OpenCode : `permission` allow/ask/deny, `--auto` approuve tout non-deny, legacy `tools` déprécié v1.1.1, wildcards, `~`, dirs externes, par agent, `ask`→approbation [ref-opencode].
- **US-14 (M-V1) :** j'approuve/refuse un choix avec scope visible. **AC :** approve sans requirementId ou inter-session → erreur -32053 affichée, aucun effet.
- **US-15 (S-V2) :** allowlist persistante par commande + granularité allow/prompt/forbidden + most-restrictive-wins + allow/deny réseau/domaines. **AC :** persistance après restart, conflit → le plus restrictif gagne.
- **US-16 (S-V2) :** sandbox configurable (défaut dossier/branche + web search caché ; réseau/élevé exige permission ; rules projet/équipe) [ref-codex sécurité]. **AC :** tentative hors-scope → prompt ; réseau sans permission → denied. [TROU : config sandbox exacte muse (`--trust-workspace/--disable-sandbox`, `MUSE_ALLOW_UNSCOPED_READS=1 DANGEROUS`, confinement cwd, `promptUnmatched→request_permission`) connue via brokkai/muse-acp seul — à confirmer via `--help`.]

### 3.5 Input answerable
État prouvé : `userInput/requested` → panneau answerable (single/multiple, max 10 questions/20 options) ; `answer_input` validé (1 seule clé/réponse, freeText 500 chars, host arbitre -32057) [audit-local].
- **US-17 (M-V1) :** je réponds aux questions clarifiantes sans quitter le stream. **AC :** 11e question ou 21e option rejetée côté client ; freeText >500 refusé ; -32057 affichée.

### 3.6 Contexte (@mentions, fichiers, browser)
Zed : contexte assemblé via `@` (fichiers, dossiers, symboles, threads passés, skills, diagnostics, diffs, URL fetch) ; sélection multi-ligne collée auto-formatée en @-mention [ref-zed]. Instructions always-on via AGENTS.md perso/projet (+ `.rules`/CLAUDE.md compat) ; Skills = tâches invocables [ref-zed]. Claude : ordre Cowork = connecteurs > navigateur intégré/Chrome > computer-use (connecteur rapide, écran lent/fragile) [ref-claude].
- **US-18 (M-V1) :** je mentionne fichiers/dossiers/symboles/diffs via `@`. **AC :** résolution + chip visible + hors-scope workspace → permission.
- **US-19 (S-V2) :** navigateur in-app commentable type Atlas + computer-use background (voit/clique/tape, curseur propre) + in-app browser commentable + génération image (gpt-image-1.5) [ref-codex 04/2026, confirmé 9to5mac : trio + 111 plugins, review GitHub, multi-terminaux, previews PDF/sheets]. Tout absent de muse-desktop [audit-local]. **AC V2 :** navigation + commentaire ancré ; computer-use avec permission par app, macOS15+ fond sans voler pointeur/clavier [ref-claude]. [TROU : maquette/choix Atlas vs Chrome ext. à trancher.]
- **US-20 (C-V2+) :** mémoire preview + suggestions proactives (prefs, corrections, contexte Slack/Notion/Docs/codebase) [ref-codex]. Mitigations drift/stale obligatoires : prompt 4000 tokens/25+ règles = drift persistant même Opus ; re-répétition allégée SCAN 20-300 tokens [HN] ; mémoire stale override preuve courante sans warning (stale 0.92-1.00, gros modèles s'effondrent quand note stale paraît récente) [arXiv]. **AC :** mémoire datée/sourcée + warning stale + SCAN périodique.

### 3.7 Artefacts / previews
Claude : artefacts autonomes fenêtre droite (docs/code/HTML/React), versions + edit-in-place, exigent exécution de code [ref-claude]. Antigravity : artifacts vérifiables (task lists, plans, walkthroughs, screenshots, browser recordings) + feedback async style Docs + select-and-comment sur screenshots ; base fork VS Code, l'agent se filme en testant l'app [ref-antigravity]. Code muse : chunks coalescés, pas d'artefacts versionnés [audit-local].
- **US-21 (S-V2) :** j'ouvre un artefact versionné, j'édite in-place, je commente (select-and-comment). **AC :** N versions listées, restore en 1 clic, commentaire ancré au screenshot.

### 3.8 Recherche (locale + codebase)
Prouvé : aucun index natif chez Codex (feature request #20453 closed duplicate #5181 : spec demandée = background incrémental, NL→paths+symbols+lines, opt-in, .codexignore+.gitignore, exclusions build/logs/vendor/secrets/binaires, Delete Index, panneau status/pause/resume/rebuild — mais pas implémenté, seul lien projet↔dossier) ; Claude Desktop = extensions MCP 1-clic, pas d'index natif, accès scopé aux fichiers sélectionnés, aucun format listé [preuves]. Référence d'implémentation (proposition, pas parité) : PivotSearch Tauri2+Vue3+Rust, 9 formats (PDF/docx/xlsx-xls-csv/pptx/md/html/txt+code/epub/zip-tar), Tantivy+jieba+stopwords, incrémental mtime+diff, watcher notify+debounce 1s, queue single-worker UPDATE/REBUILD+dedup, merge multi-index + filtres type/taille/racine, limites .doc/.ppt legacy KO [preuve].
- **US-22 (M-V1) :** recherche scopée workspace sous approbations + confinement (reads confinés cwd par défaut) [brokkai]. **AC :** chemin hors cwd → ask/deny.
- **US-23 (S-V2) :** index local opt-in avec panneau status/pause/resume/rebuild + Delete Index (spec #20453). **AC :** formats supportés listés explicitement (ne pas promettre les 9 formats PivotSearch sans implémentation). [TROU : liste formats Codex/Claude inexistante — toute liste = proposition.]

### 3.9 Skills / connecteurs (type MCP) / plugins
Codex : Skills = instructions+ressources+scripts (standard agentskills.io), UI création/gestion, usage explicite/auto, partageables repo/team, ex. Figma/Linear/Vercel ; 90+ plugins (skills+intégrations+MCP : Jira, CircleCI, CodeRabbit, GitLab, MS Suite, Neon, Render), revue PR GitHub, multi-terminaux, SSH devboxes alpha [ref-codex]. Claude : MCP local `.mcpb` 1-clic (Settings>Extensions, annuaire relu Anthropic) ; distant Free-Enterprise (Free=1 seul, depuis cloud Anthropic, exige internet public + allowlist IP, VPN/firewall privé KO) ; connecteurs héritent permissions source, catalogue lecture/écriture, activation Owner puis auth individuelle ; Skills dossiers à divulgation progressive (Anthropic/custom/org/partenaires, agentskills.io), actives par défaut view-only, plugins exposent skills MCP chat+Cowork ; MCP Apps rend des UI tierces dans le chat (extension) [ref-claude + Register]. Zed : MCP Tools+Prompts, `notifications/tools/list_changed` sans restart, locaux/distants+OAuth ; Skills dossiers SKILL.md invocables slash, catalogue on-demand, partage `zed://skill` [ref-zed]. OpenCode : plugins = hooks + outils custom (local `.opencode/plugins/`, `~/.config/`, npm), ex. notifs, protection .env, compaction ; config `opencode.json` (schéma, portées global/projet/custom/remote/managed : model, providers, agents, permissions, mcp, plugins, share) ; 75+ providers, locaux supportés, `/models`, `/connect` [ref-opencode]. muse-desktop : ni connecteurs MCP ni rendu riche [audit-local].
- **US-24 (S-V2) :** j'installe un connecteur local en 1 clic (sans JSON manuel) depuis annuaire relu. **AC :** install + liste outils sans restart (hot-reload type `list_changed`).
- **US-25 (S-V2) :** skills invocables slash + auto, partageables repo/team, divulgation progressive. **AC :** `/nom-skill` exécute ; auto-suggestion tracée.
- **US-26 (C-V2+) :** MCP distant (1 seul en Free-like) avec garde Internet public/allowlist ; UI tierce rendue in-chat (MCP Apps). **AC :** échec VPN documenté + message explicite.

### 3.10 Collaboration / partage
OpenCode : lien public `opncd.ai/s/<id>`, modes manual(/share défaut)/auto/disabled, un-share + rétention [ref-opencode]. Zed : Channels persistants (pairing, mentoring, refactor temps réel), projet partagé édité comme local, notes Markdown, follow [ref-zed]. Claude Projects : partage view/edit Team/Enterprise [ref-claude].
- **US-27 (S-V2) :** je partage un thread via lien public + un-share. **AC :** lien révoqué → 404 ; mode auto/disabled respecté.
- **US-28 (C-V2+) :** je co-édite en channel persistant. **AC :** 2 clients éditent sans écrasement (CRDT/relay à spécifier [TROU : internes CRDT Zed non inspectés, code source non lu]).

### 3.11 Personnalisation / config
- **US-29 (M-V1) :** workspace persistant + activeId restaurés. **AC :** restart → même workspace/session active.
- **US-30 (S-V2) :** modèle project-centric : 1 projet = 1+ dossiers (frontend+backend), settings agents/sécurité/MCP isolés par projet hérités du global + override [Antigravity codelabs] ; app standalone Mac/Linux/Windows indépendante de l'IDE + scheduled tasks ; IDE/CLI/SDK/VSCode/JetBrains/Zed à côté [codelabs 2.0]. **AC :** override projet prouvé par diff global/projet.
- **US-31 (S-V2) :** providers multiples + locaux (75+ via AI SDK/Models.dev, reco GPT-5.x/Claude 4.5/Gemini 3 Pro) [ref-opencode]. [TROU : backend modèle muse non sourcé — ne pas promettre sans preuve.]

### 3.12 Accessibilité / i18n
Aucune preuve. [TROU complet — exiger audit : clavier complet, focus panneau approval/input, lecteurs d'écran sur stream, contraste, i18n FR/EN.]
- **US-32 (S-V2) :** j'approuve au clavier seul avec focus piégé correctement. **AC :** test clavier + lecteur d'écran à définir.

### 3.13 Onboarding
Modèles prouvés : `/connect` credentials providers, `/models` sélection [ref-opencode] ; reprise sessions/config CLI et IDE [ref-codex] ; login ChatGPT [ref-codex MacRumors].
- **US-33 (M-V1) :** au premier lancement sans sidecar/binaire, erreur explicite (pas d'écran vide). **AC :** binaire manquant → message + chemin attendu (exe-dir/src-tauri/binaries). [TROU : matrice triples Win/Mac + test bundle manquants.]
- **US-34 (S-V2) :** import config CLI/IDE existante. **AC :** sessions reprises visibles.

## 4. MoSCoW récapitulatif

- **Must V1 :** host sidecar partagé/workspace, MSP ligne-par-ligne + timeout 120 s, polling 150/1000 + buffer 2000, multi-sessions + persistance 2000/500, approvals choix anti-rejeu -32053, input answerable 10/20/500/-32057, coalesce itemId + subagents `<details>`, phase réflexive <200 ms, `@` fichiers scopés, onboarding erreur sidecar explicite.
- **Should V2 :** Projects/RAG/partage, compaction, threads sidebar, fan-out via parent (cores-2 clamp 4-8, FIFO), worktrees `.muse/worktrees` + cleanup, allowlist persistante + sandbox granulaire + réseau allow/deny, Artefacts versionnés commentables, index opt-in + panneau, Skills/MCP 1-clic + hot-reload + slash/auto, partage lien + un-share, project-centric overrides, browser in-app + computer-use permission-par-app, mémoire datée + SCAN anti-drift, review queue/automations/scheduled.
- **Could V2+ :** MCP distant + MCP Apps in-chat, image-gen, SSH devboxes, multi-terminaux, channels co-édition, suggestions proactives Slack/Notion/Docs.
- **Won't / explicitement hors-spec :** SSE tant que non exposé ; « workflow tabs » Editor/Manager/Browser comme nommage officiel (aucune occurrence officielle — Codex = threads+onglets Work/Chat + onglets browser [snippets] ; issue #33301 = tiled panes en feature request citant #18778/#23314 ; muse-desktop = sidebar+conversation+panneaux, plan V1 sans onglets [grep] — maquette Figma à trancher) ; promesse de parité formats d'index ; comparatif chiffré d'excellence sans body inspecté (voir §5).

## 5. Exigences UX chiffrées (feedback/délais)

| Paramètre | Exigence V1 | Source |
|---|---|---|
| Poll streaming/idle | 150 ms / 1000 ms, chaîne sérialisée, kick après action | audit-local |
| First feedback (réflexion) | <200 ms après send (avant first token) | exigence dérivée du polling (150 ms) |
| Timeout requête MSP | 120 s, erreur affichée | audit-local msp.rs |
| Buffer / persistance | 2000 évts buffer ; 2000 entrées/session ; 500 tombstones | audit-local |
| Input answerable | ≤10 questions, ≤20 options, freeText ≤500 chars, 1 clé/réponse | audit-local |
| Résultat subagent | summary ≤512 chars, text ≤32 KiB | schéma MSP |
| Pagination | view 1-1000, session list max 200 | schéma MSP |
| Concurrence modèle | ≈ cores-2 clamp 4-8, FIFO, démo 6 simultanés | cookbook |
| Bundle | Tauri 8.6 MiB vs Electron 244 MiB ; renderer macOS Chromium ~2x WKWebView ; 6 fenêtres ~409 Mo Electron ; contrepartie = quirks cross-platform (Safari/Chrome/Firefox) | dev.to/gethopp |
| Référence latence/coût concurrents (contexte, pas engagement) | Codex 5-10 s délais (API distante) malgré GPT-5.3 +25% inf ; Gemini leader latence, Claude Fast ~2.5x speedup à 6x tokens ; Terminal-Bench 2.0 GPT-5.3-Codex 77.3% vs Opus 4.6 65.4%, SWE-bench Claude 80.8%, contexte Codex 400K in/128K out vs 1M Claude/Gemini ; pricing GPT-5.3-Codex $1.75/$14 par 1M, session $0.50-2.00, Plus $20, Go $8, Pro 5x/20x, Fast 2.5x crédits, bascule crédits 02/04/2026 | IntuitionLabs + CloudZero (body $100 Pro 5x non confirmé [TROU]) |

Garde-fous perf sourcés (à transposer en tests V1) : client Codex Electron 26.5 à 264-285% CPU côté IPC/log/history (sessions ~/.codex 596 Mo, JSONL 50-180 Mo), logs_2.sqlite ~301 Mo + renderer ~831 Mo → typing/scrolling effondrés ; stream ScreenCaptureKit laissé à 55-56 FPS sans consommateur (WindowServer 50-60% CPU, 59% GPU, seul quit résorbe) → lier tout stream à la vie consommateur/session + idle guard + reaper ; Tauri sidecar = process séparé sans IPC magique, vie à lier au parent (force-quit laisse le port vivant) ; auto-update bricking (ownership système, retirer si doute) ; messaging natif sans consentement (critique ePrivacy) ; hard-block Windows hors `C:\Users\<user>` malgré config [preuves limites externes].

## 6. Points non couverts / trous bloquants (à lever avant PARTIE 2 technique)

1. Protocole MSP réel : framing/handshake sans credentials, méthodes/params exacts, codes -32053/-32057, `listen` vs polling — valider via `muse serve --help` + `muse-code-sdk`/schéma TS (commentaires seuls aujourd'hui). 2. Multiplexage contradictoire : plan 2026-09-07 (1 enfant/session) vs main.rs (1 host partagé/workspace, kill/respawn au switch) — trancher lifecycle, portée sandbox, perte contexte. 3. Packaging : seul binaire linux, externalBin générique, matrice triples/test bundle/erreur sidecar manquant absents. 4. Branding premium Meta : zéro asset — indescriptible. 5. Benchmarks/latence/coûts-credits Codex : OSWorld 64.7%/SWE-Pro 56.8% (Neowin 403, snippets seuls) ; rate-card Extra Credits + $100 Pro 5x non confirmés en body. 6. Codex : allowlist/benchmarks/conflits worktrees/dérive mémoire/review-queue/config sandbox exacte — rules non fetchées, presse seule. 7. Claude : streaming temps-réel, formats d'index, bugs perf/permissions, MCP Apps in-chat — aide seule, devdocs non inspectées. 8. Antigravity : N parallèle absolu, nommage workflow-tabs, coûts/latence/review-policies/presets — docs officielles non lues. 9. OpenCode : LICENSE (MIT ?), stack desktop, transport SSE/polling — non relus. 10. Zed : slash historiques (/fetch /file /diagnostics, 404), CRDT/Lamport, 120fps/sub-ms — secondaires seuls. 11. Docs OpenAI/Anthropic officielles non lues directement ; DigitalTrends browser Claude (202, 0 octet), corps 9to5mac/MacRumors tronqués/403 ; balayage muse-desktop borné 50000 entrées. 12. Deltas sans cadrage V1/V2 ni maquette : computer-use, browser commentable, image-gen, MCP+rendu riche, skills, automations/scheduled, mémoire, projects/worktrees, artefacts, channels — absences constatées, spec détaillée impossible sans sources.

---

# muse-desktop — PARTIE 2 : Spec technique (depuis existant audité)

> Périmètre : client desktop Tauri + React adossé au CLI `muse serve` (sidecar). Positionnement : équivalent brandé Meta Muse de Codex Desktop / Claude Desktop. Existant : multi-sessions, streaming par polling, approbations par choix, input answerable (`input_requested`), persistance locale. Tout ce qui n'est pas dans les preuves est marqué **[TROU]**.

## 1. Architecture cible

### 1.1. Principes
- `muse-desktop` = shell desktop (Tauri + React) autour d'un **moteur agent unique : `muse serve`** embarqué en **sidecar**. Pas de moteur LLM dans le client.
- Référence OpenCode : même pattern TUI + desktop + IDE autour d'un même moteur exposé en serveur headless (`opencode serve [--port --hostname --cors]`, défaut `127.0.0.1:4096`, API OpenAPI) + SDK client type-safe (`createOpencode()`). Pour muse-desktop : sidecar `muse` + client MSP maison (pas de SDK JS connu — **[TROU]**).
- Référence Zed/ACP : protocole standard éditeur↔agent (JSON-RPC/stdio en local, HTTP/WebSocket à distance). muse-desktop utilise son protocole propre **MSP JSON-RPC 2.0 ligne-par-ligne** (pas ACP) — interop ACP hors scope V1.

### 1.2. Sidecar Tauri
- Déclaration : `tauri.conf` → `bundle.externalBin binaries/muse` ; résolution au runtime par `resolve_sidecar()` (joint exe-dir puis `src-tauri/binaries`). Réf doc Tauri : sidecar = binaire tiers par triple, suffixe `-TARGET_TRIPLE` par archi, spawn via `shell().sidecar().spawn()` (plugin shell requis) ; **pas d'IPC magique** = process séparé, cycle de vie à gérer.
- État audité : **un seul host `muse serve` partagé, multiplexé par `sessionId`** ; **un host par workspace (changer de workspace tue et respawn l'ancien)** ; handshake `initialize` puis notify `initialized`.
- **[TROU — contradiction lifecycle]** : plan 2026-09-07 (1 enfant `muse` par session) vs `main.rs` actuel (1 host partagé). Trancher : portée sandbox, perte de contexte au switch workspace, politique kill/respawn. Preuve manquante : `muse serve --help` + schéma MSP non inspectés depuis le binaire.
- **[TROU — packaging]** : seul binaire linux présent (`muse-x86_64-unknown-linux-gnu`), `externalBin` générique, cibles Win/Mac sans matrix triples, sans test bundle ni preuve d'erreur sidecar manquant. Risque connu (réf. dev.to/bun) : force-quit laissant le sidecar vivant sur son port si vie non liée au parent → exiger `kill` au `window-close` + garde port.

### 1.3. Protocole MSP (état audité)
- Client `src-tauri/src/msp.rs` : JSON-RPC 2.0 **1 frame par ligne** (`encode_request`/`notification`, `split_lines`, `route_frame`), `commandId` UUIDv7, **timeout requête 120 s**, tests unitaires Rust.
- **[TROU — protocole non prouvé]** : `msp.rs` assume 1 frame/ ligne et commente handshake impossible sans credentials ; schéma TS (`muse schema generate-ts`), méthodes/paramètres réels, codes `-32053`/`-32057`, framing non inspectés. Ne pas acter de noms d'options avant `muse serve --help` / `muse-code-sdk`.
- Éléments schéma stabilisés par preuves (fichier `/tmp/msp-schema/msp.d.ts`, 2086 lignes) : `Notification` (L781), `item/delta` (L599), `item/started` (L649), `item/completed` (L587), `view/subscribe` (L2034), `session/resume` auto-subscribe (L1242/L1326), `session/read` ne subscribe jamais (L1164), union `MspNotification` ; **zéro chaîne SSE** dans le schéma.

### 1.4. Transport temps réel (cible : remplacer le polling)
- Existant (audité) : **polling** (`poll_events`/`since`, buffer 2000 événements `EVENT_BUFFER_CAP`) choisi **car les push `listen` ne déclenchaient jamais dans un env** (non identifié) ; `wire_log` vers `/tmp/muse-wire.log`. Front `useMuseSessions.ts` : **poll 150 ms streaming / 1000 ms idle**, chaîne sérialisée anti-doublons + kick après `send/answer/approve` ; statuts `running/stopped` dérivés des kinds `turn/*`.
- Preuves négatives : `muse serve --help (v1.2.1)` = host stdio, flags sandbox only, **zéro mention streaming/SSE/polling/notifications/view** ; zéro `SSE/EventSource/text/event-stream` dans `src` + `src-tauri/src` ; recherche web noyée par homonymes → **aucune release-notes/devdocs Meta MSP trouvée**.
- Cible : transport push (WebSocket/SSE ou `listen` réparé) avec fallback polling. **[TROU]** : `listen` non justifié (env, repro, mesure absents) ; caps (2000 events, 150/1000 ms, 120 s, persist 2000 entrées/500 tombstones) sans mesure ni justification perf → voir §8 jalons (d'abord instrumenter, puis décider).
- Référence Zed : `notifications/tools/list_changed` recharge outils sans restart (MCP) — à viser pour muse-desktop si MCP ajouté (V2+).

### 1.5. Persistance locale
- `src/lib/persist.ts` (audité) : `localStorage` → `sessions`, log **append-only capé 2000 entrées/session**, `workspace`, `activeId`, **tombstones capés à 500** (suppression durable malgré `restore_sessions`).
- Limites externes connues (réf. Codex Desktop #22053/#18693, inspectés) : historique local massif (`~/.codex/sessions` 596 Mo, JSONL 50–180 Mo ; `logs_2.sqlite` ~301 Mo) → CPU client 264–285 % côté IPC/log/history (pas modèle), typing/scrolling effondrés. **Exigence** : quotas + compaction + virtualisation liste (voir §7), jamais de log illimité.
- Référence Tauri PivotSearch (proposition, pas parité) : incrémental `mtime` + diff, SQLite metadata, watcher `notify` + debounce 1 s, queue single-worker — pattern réutilisable si index local ajouté.

### 1.6. Multi-fenêtres / multi-surfaces
- Existant : layout réel = sidebar sessions + conversation/stream + `ApprovalPanel` + `InputPanel` + `Composer` (`App.tsx` 107 lignes) ; plan V1 = sidebar, stream, Approve/Deny. **Zéro occurrence `workflow-tabs/Editor/Manager/onglet Browser`** (grep concluant, balayage large borné 50000 entrées — suffisant pour le gap, pas preuve exhaustive).
- **[TROU — nommage `workflow tabs`]** : aucun nommage officiel retrouvé chez OpenAI/Anthropic ; recherche web ne renvoie que tiers (comfyui-mcp-panel, cc-relay, etc.). Codex : threads/agents parallèles, onglets Work/Chat (snippets 9to5mac 07/2026, corps non fetché), `visible tabs for active sessions` (#18778) et onglets browser (#23314) = feature requests, pas nommage officiel. Antigravity : triplet Editor/Manager/Browser = doctrine revue (Editor hands-on, Agent Manager mission-control, Browser muscle de vérification) + 4 volets IDE (Changes, Terminal, Artifacts, Browser) — **maquette Figma/UX à trancher côté muse-desktop**.

## 2. Modèle de données et contrats

### 2.1. Entités front
`Session { id, workspace, status: running|stopped, log: Item[] (cap 2000), unread? }`, `Item { itemId, kind, chunks, agentId?, completed }`, `Approval { requirementId, sessionId, choices: {choiceId,label,decision,scope}[] }`, `InputRequest { questions[≤10] × options[≤20], single|multiple }`, `Tombstone { sessionId } (cap 500)`.

### 2.2. Commandes Tauri → sidecar (auditées)
`start_session / restore_sessions / send_input / approve / cancel_session / kill_session` + `poll_events/since`. Sous-agents = orchestration sidecar, **pas de spawn IPC direct**.

### 2.3. Événements sidecar → UI (audités)
- `pump_stdout / pump_notifications / route_notification` : `item/delta → output/subagent_event`, `approval/requested → tool_request`, `userInput/requested → input_request`.
- Rendu stream : chunks assistant **coalescés par `itemId`**, sous-agents **groupés par `agentId`** en `<details>` repliables, `item/completed` ne ferme que son item.
- `approve` exige `requirementId` + **même session (anti-rejeu inter-sessions, `-32053` remonte en erreur)** ; `answer_input` validé (une seule clé/réponse, `freeText` 500 chars, host arbitre `-32057`).

### 2.4. Parallélisme / sous-agents (preuves schéma + cookbook officiel)
- Schéma stable `muse 1.2.1` (fingerprint `sha256:c7ff6c5d…`) : **33 méthodes dont 8 `subagent/*` control-only** (`close/followupTask/interrupt/readResult/reopen/resume/sendMessage/stop`) ; **aucune méthode spawn/start** stable ni expérimentale. Recherche texte : 0 hit `parallel/maxConcurrent/worktree/isolation` (hits `limit` = paging/byte caps : `view` page 1–1000, `session list` max 200, context/output caps).
- Item `subagent` : `objective/role`, `agentPath`, `depth` (sans max), `childSessionId` (drill-down `session/read|view/page`), `controlStatus` open enum, enveloppe résultat `summary ≤512 chars, text ≤32 KiB`.
- Cookbook officiel (dev.meta.ai) : limite concurrence ≈ **`cores-2 clampée 4–8`** ; spawns excédentaires **admis, enfilés FIFO**, démarrés à libération ; démo 6 subagents simultanés. Isolation écriture : **worktree git privée sous `.muse/worktrees/`, detached-HEAD depuis HEAD parent** (`base_commit`, `base_ref HEAD`, `cleanup_policy remove_if_clean`) ; enfants depth 1, commit sur branche propre, checkout parent intact ; lifecycle `operation_requested>prepared>lease_active>workspace_scope_activated`.
- Vocabulaire spawn = **plan model-tool, pas API wire** : `subagent_spawn(role, objective, worktree_isolation:true)` + `subagent_wait/read_result/status` ; gate CLI `muse --subagent-worktree-isolation` (omission = partagé ; `isolation:true` sans support rejeté `worktree_isolation_unavailable`) ; fallback dossier = `git worktree add -b taskN-branch` manuel.
- **[TROU]** : aucune limite chiffrée officielle absolue (formule host-dépendante seule) ; **aucun endpoint MSP spawn appelable** → fan-out desktop = prompter le tour parent ; plan `workflow/*` sans ligne schéma (spec 14410 ouverte, `mslsrc/tbh#14410`) → parallélisme via workflows **non spécifiable sur MSP**.

## 3. Streaming et visibilité réflexive

- Jalon V1 : garder polling 150/1000 ms + chaîne sérialisée ; afficher `item/started|delta|completed`, `turn/*` → `running/stopped`, tool calls et sous-agents (`agentId`, `<details>`).
- Références à viser (V2+) : Zed Agent panel (threads multiples, streaming + indicateurs d'outils, checkpoints/restore, compaction auto + `/compact`, `New From Summary`) ; Codex (threads par projets, switch sans perte de contexte, revue diff commentée + ouverture éditeur) ; Antigravity (`verify with Artifacts, not logs` : plans, task lists, walkthrough + screenshots/recordings commentables, boucle delegate→review→comment→iterate).
- **[TROU]** : raisonnement intermédiaire exact (contenu/filtrage), review policies configurables, presets : coûts/latence/garde-fous quantifiés et `tool bloat` non inspectés (`antigravity.google/docs` + tests mains à prévoir).

## 4. Sécurité / permissions

- Existant : approbation par choix (`choiceId/label/decision/scope`, anti-rejeu `-32053`), input borné (10/20/500), confinement : `session/new{cwd}` scopé, reads confinés au `cwd` par défaut, `MUSE_ALLOW_UNSCOPED_READS=1` opt-in **DANGEROUS**, `MUSE_SERVE_ARGS --trust-workspace/--disable-sandbox`, `promptUnmatched→session/request_permission` ; sessions durables + resume (réf. `brokkai/muse-acp` inspectée).
- Références : Codex = sandbox système open-source configurable, défaut dossier/branche + web search caché, permission réseau/élevé requise, rules projet/équipe ; `rules.md` inspecté (`prefix_rule` allow/prompt/forbidden, most-restrictive-wins, allow-list `~/.codex/rules/default.rules`, Smart approvals, trust-gated) ; approvals (`Auto` = workspace-write + on-request, `approval_policy` on-request/never/granular). OpenCode = `permission` allow/ask/deny, `--auto` approuve tout non-deny, règles granulaires wildcards, par agent. Zed = regex allow/deny/confirm (défaut confirm), profils Write/Ask/Minimal (Zed Agent seul). Claude Cowork = cloud isolé éphémère, fichiers locaux via dossiers connectés, menace = read vs write, prompt-injection = lecture non fiable + action → supervision humaine.
- Leçons incidents (garde-fous) : auto-update bricking Claude Code (ownership root), Native Messaging sans consentement (The Register, ePrivacy), block dossiers Windows hors `C:\Users\<user>` (#20382) → exiger : install sans élévation, consentement explicite, scope filesystem strict, audit.
- **[TROU]** : `muse serve` flags sandbox exacts non inspectés depuis le binaire ; branding premium Meta indescriptible (seul `favicon.png`, icons placeholder, `productName` générique, CSP null).

## 5. Observabilité / logs

- Existant : `wire_log` `/tmp/muse-wire.log`, tests Rust `msp.rs`.
- Exigences : log structuré (sessionId, commandId UUIDv7, latences poll, tailles frames, drops buffer), statut `listen` vs `poll`, compteurs caps (2000/500), export diagnostic 1-clic. Réf. perfs : coût IPC/log/history côté client (Codex #22053 : hot path libuv/StreamBase/Buffer) ; fuite stream 55–56 FPS ScreenCaptureKit après session (#35659 : lier stream à la vie consommateur + idle guard + reaper) → appliquer aux sous-agents/streams muse-desktop.
- Tauri vs Electron (réf. inspectée) : bundle 8,6 MiB vs 244 MiB, WKWebView ~2× moins de mémoire que Chromium, 6 fenêtres ~409 Mo Electron ; contrepartie incohérences cross-platform (moteurs par OS).

## 6. Tests et qualité

- Existant : tests unitaires Rust `msp.rs` (framing, routage).
- Cible V1 : unit (coalescence `itemId`, groupement `agentId`, caps 2000/500, validation input, anti-rejeu), intégration (1 host partagé + kill/respawn workspace, `initialize→initialized`, timeout 120 s), e2e (send→stream→approve→answer→completed), perfs (poll 150 ms sans doublon, historique 2000 entrées fluide, virtualisation), packaging (matrice triples, sidecar manquant → erreur claire).
- **[TROU]** : `LICENSE` non lue (MIT ?) ; stack desktop OpenCode et transport SSE/polling non relus en profondeur ; slash-commands, CRDT, 120 fps Zed = sources secondaires seulement.

## 7. Roadmap (jalons depuis l'existant)

- **M1 — Durcir l'existant** : trancher 1-host-partagé vs 1-host/session (sandbox + perte contexte workspace) ; instrumenter `listen` vs `poll` (taux déclenchement, latence 150/1000 ms, CPU, drops buffer 2000) ; quotas UI (virtualisation, compaction type Zed) ; matrice sidecar Win/Mac/Linux + erreur sidecar manquant ; `muse serve --help` + schéma TS actés.
- **M2 — Parité concurrentielle minimale** : threads/projets + switch sans perte (Codex), skills (`SKILL.md`, agentskills.io — Zed/Claude/Codex convergent), artefacts versionnés (fenêtre droite, edit-in-place — Claude), projects/workspaces + partage (Claude : Free max 5, RAG ~10×), revue diff + ouverture éditeur.
- **M3 — Multi-agents sûrs** : fan-out via tour parent (pas de spawn MSP), file FIFO `cores-2 [4,8]`, worktrees `.muse/worktrees/` par agent écrivant, file-level contracts + validation déterministe (leçons DZone/Warp : 1 worktree+branche/agent, ownership, merge comparé), garde anti-drift (re-répétition légère SCAN, limite 25+ règles — HN prompt-decay ; Memory Trust Gap arXiv 2609.01852 : stale override sans warning).
- **M4 — Automations/scheduled** : instructions+skills planifiées, review queue (Codex : triage issues, CI failures, release briefs ; Antigravity `/schedule`, récurrentes/one-shot) — non spécifiable via `workflow/*` tant que spec 14410 ouverte.
- **M5 — Deltas phares (V2+, cadrage+mocks requis)** : computer-use background (curseur propre), browser in-app commentable (Atlas), image-gen (`gpt-image-1.5`), connecteurs MCP + rendu riche in-chat (MCP Apps), mémoire persistante + suggestions, channels/collab temps réel, 90–111 plugins, terminaux multiples, SSH devboxes, PDF/sheets previews — **absences constatées, sans source pour spec** (snippets 9to5mac/MacRumors, corps non fetchés ; DigitalTrends 0 octet).

## 8. Risques et décisions ouvertes

1. Lifecycle hosts (perte contexte/sandbox au switch workspace). 2. `listen` vs polling (env inconnu, sans mesure). 3. Pas de spawn MSP → fan-out uniquement model-tool. 4. Drift mémoire long-terme + conflits sémantiques inter-worktrees (build conjoint incompatible). 5. Lock-in vertical, IP/licensing, tokens/policy/audit (InfoWorld) ; benchmarks non stabilisés (Terminal-Bench 2.0 GPT-5.3-Codex 77,3 % vs Opus 4.6 65,4 % ; SWE-bench Claude 80,8 % ; latence Gemini leader, Codex 5–10 s ; pricing GPT-5.3-Codex $1,75/$14 /1M, session $0,50–2,00, Pro 5×/20× — sources secondaires, voir §9). 6. Branding premium sans asset.

## 9. Points non couverts (preuves manquantes — ne pas spécifier sans elles)

OSWorld-Verified 64,7 % / SWE-bench Pro 56,8 % (Neowin 403, snippets seuls) ; rate-card Extra Credits + prix $100 Pro 5× (body CloudZero : split 5×/20× sans prix explicite) ; release-notes/devdocs Meta MSP (homonymes seuls) ; formats/moteur d'index natif (liste PivotSearch = proposition Tauri, pas parité Codex/Claude) ; `muse serve` flags/schéma depuis binaire ; cap absolu N agents ; spawn MSP ; plan `workflow/*` (14410) ; corps 9to5mac/MacRumors/DigitalTrends (snippets/403/0-octet : onglets Work/Chat, terminal tabs, sidebar previews) ; coûts/latence/review-policies/presets Antigravity (`antigravity.google/docs` à lire) ; LICENSE ; transport OpenCode ; slash-commands/CRDT/120 fps Zed (secondaire) ; docs officielles Codex/Claude Desktop (presse seule) ; framing/méthodes/codes MSP ; branding Meta ; UX approbation Codex granulaire au-delà de rules.md ; streaming/indexation/limites/MCP-Apps Claude (aide seule).
