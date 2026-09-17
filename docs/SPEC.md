# muse-desktop — Spec produit & technique

> Ce document conserve les intentions et analyses initiales ; certaines hypothèses et descriptions techniques sont historiques. L'avancement réel et les critères de livraison sont suivis dans la [roadmap opérationnelle](ROADMAP.md), sur la base de l'[audit de parité du 15 septembre](plans/2026-09-15-codex-parity-audit.md).

> Générée le 2026-09-13 par recherche multi-références (Codex Desktop,
> Claude Desktop, Antigravity, OpenCode, Zed + audit du code existant).
> Positionnement : client desktop dédié, optimisé et brandé **Meta Muse**,
> visant l'excellence fonctionnelle de Codex Desktop / Claude Desktop.
> Les affirmations non sourcées sont marquées **[TROU]** dans le texte.

- [Partie 1 — Spec fonctionnelle (V1/V2)](#muse-desktop--partie-1--spec-fonctionnelle-v1v2)
- [Partie 2 — Spec technique](#muse-desktop--partie-2--spec-technique-depuis-existant-audité)

---

# muse-desktop — PARTIE 1 : Spec fonctionnelle (V1/V2)

> Périmètre : client desktop Tauri+React adossé au CLI `muse serve` (sidecar). Équivalent premium brandé Meta Muse de Codex Desktop / Claude Desktop. État prouvé par le code lu : 1 host partagé par workspace multiplexé par `sessionId`, streaming par polling 150/1000 ms sérialisé, approbations par choix anti-rejeu, input answerable (`userInput/requested`), persistance locale. Sources : `audit-local` (main.rs, msp.rs, useMuseSessions.ts, lib/persist|input|poll|env), `ref-codex`, `ref-claude`, `ref-antigravity`, `ref-opencode`, `ref-zed`. Tout ce qui n'est pas prouvé est marqué **[TROU]**.

## 1. Vision & positionnement

**V1 — Command center local fiable.** `muse-desktop` = coquille premium Meta Muse autour d'un seul `muse serve` partagé : 1 host par workspace (changer de workspace tue/respawn l'ancien ; handshake `initialize` puis notify `initialized`, sans lui tout appel échoue `Not initialized`), sessions multiplexées par `sessionId`. Transport JSON-RPC 2.0 ligne-par-ligne (`split_lines`), `commandId` UUIDv7, timeout 120 s. Streaming par polling sur buffer borné 2000 évts (`poll_events/since`, curseur `head`) : le push `listen` résolvait mais ne déclenchait jamais dans un env [TROU : env non identifié], donc même sémantique broadcast par-dessus `invoke`. Poll UI 150 ms streaming / 1000 ms idle (setTimeout adaptatif, jamais setInterval), chaîne sérialisée unique (`poll.ts` : tick périodique + kick partagent une promise-chain, le curseur n'avance qu'en succès) + kick immédiat après send/answer/approve ; statuts running/stopped dérivés des kinds `turn/*` (`started/running/created/turn_start` vs `cancelled/completed/stopped/exited/host_exited/error/turn_end/idle`). Persistance locale `localStorage` : sessions (sans flag running), log append-only capé 2000 entrées/session (blocs `open` refermés au reload), workspace, activeId, tombstones capés 500 (suppression durable malgré `restore_sessions` et évts tardifs). Packaging : `externalBin binaries/muse` + `resolve_sidecar()` (exe-dir puis `src-tauri/binaries/`, nom suffixé par triple, `.exe` sous Windows) ; message explicite si binaire absent.

**Cible — Parité premium Codex/Claude + doctrine Antigravity.** Codex = command center agents : threads séparés par projets, switch sans perte de contexte, revue diff commentée + ouverture éditeur, worktrees intégrés [ref-codex]. Claude = annuaire unifié Skills/Connecteurs/Plugins, MCP local 1-clic (`.mcpb`) + distant, artefacts versionnés fenêtre droite, Projects/RAG, Cowork cloud isolé [ref-claude]. Antigravity = IDE control-plane d'agents (plan/execute/verify sur editor+terminal+browser), Manager Surface async multi-workspaces, « verify with Artifacts, not logs » (plans, task lists, walkthrough + screenshots/recordings, delegate→review→comment→iterate) [ref-antigravity]. OpenCode/Zed = référence transport/config/permissions : `serve [--port --hostname --cors]` (défaut 4096/127.0.0.1, OpenAPI), SDK type-safe, threads multi-agents + checkpoints + compaction, permissions regex allow/deny/confirm, profils Write/Ask/Minimal, ACP standard [ref-opencode/ref-zed].

**Branding premium Meta [TROU total].** Aucun asset lu (favicon seul, icons placeholder, productName générique, CSP null, BUILD_ID `2026-09-08-poll-transport` seul marqueur). Aucune source pour décliner « premium vs Codex/Claude Desktop ». V1 : ne pas spécifier charte, ton, logo, naming. Maquette Figma/UX à trancher [unresolved].

## 2. Personas

| Persona | Besoin | Preuve |
|---|---|---|
| Dev solo multi-projets | threads/projet, switch sans perte, reprise CLI/IDE, 1 host/workspace | Codex threads+worktrees ; Zed threads sidebar + checkpoints |
| Lead / reviewer | review queue, diff commenté, walkthrough avec preuves, merge du meilleur diff | Codex review ; Antigravity artifacts ; Warp (1 owner + 1 review, comparer diffs) |
| Ops/qualité | automations planifiées (triage issues, CI failures, release briefs), scheduled tasks | Codex Automations ; Antigravity `/schedule` (lun/mer 9h, one-shot/récurrent) |
| Contributeur équipe | partage lien, partage team config/skills, channels/collab temps réel | OpenCode `opncd.ai/s/<id>` (manual/auto/disabled) ; Zed Channels ; Claude Projects view/edit |
| Admin/IT | sandbox configurable, rules projet/équipe, auditabilité, monitoring tokens | Codex sandbox open-source + rules ; InfoWorld (policy enforcement, auditabilité, monitoring tokens) |

## 3. Domaines fonctionnels, stories & acceptation

Conventions : AC = critère testable. MoSCoW : **M**ust V1 / **S**hould V2 / **C**ould V2+ / **W**on't. Chiffres = exigences §5.

### 3.1 Conversations / threads / projets
- **US-1 (M-V1) :** je crée/liste/reprends des sessions du host partagé, multiplexées par sessionId. **AC :** `start_session/restore_sessions/send_input/cancel/kill` via sidecar seul canal ; `session/start` reçoit la posture globale via l'enum fermé `allowAll|promptUnmatched|onRequest` et `session/setApprovalMode` réconcilie une session existante ; switch session sans perte du log persisté (2000 entrées) ; tombstone durable (cap 500, late-events et `restore` ne ressuscitent jamais) ; au boot hors-Tauri (`backendMissing`) l'historique local reste visible sans bannières mensongères.
- **US-2 (M-V1) :** je vois le stream coalescé par `itemId`, sous-agents groupés par `agentId` en `<details>` repliables, `item_done` ne ferme que son item. **AC :** chunks `output` fusionnés dans la dernière entrée assistant *ouverte* (pas seulement la dernière) ; `item/completed|updated` → `item_done` ferme l'`itemId` exact, les autres items continuent ; `turn/completed` ferme tout + `running=false`.
- **US-3 (S-V2) :** j'organise threads par projets, avec instructions, partage view/edit (Team/Enterprise), Free max 5 projets, RAG ~10x [ref-claude Projects]. **AC :** création projet, rattachement threads, partage view/edit, quota 5 en Free simulé.
- **US-4 (S-V2) :** je compacte les longs threads (auto au seuil tokens + `/compact` manuel + `New From Summary`) [ref-zed]. **AC :** compaction déclenchée au seuil, résumé ré-ouvrable en thread neuf. [TROU : seuil tokens muse non sourcé.]
- **US-5 (S-V2) :** threads sidebar multi-agents concurrents, switch ctrl-tab, historique archivable [ref-zed parallel-agents]. **AC :** ≥2 threads actifs visibles, switch < §5.

### 3.2 Orchestration multi-agents visible + worktrees
État prouvé : sub-agents possédés par orchestration sidecar, pas de spawn IPC direct ; commandes limitées à start/restore/send/approve/answer/cancel_input/cancel/kill/setApprovalMode. Routage : `item/delta`→output/thinking/subagent_event (lane choisie par table `(sessionId,itemId)→kind` alimentée par `item/started`, scopée par session), `approval/requested`→tool_request, `userInput/requested`→input_request, `turn/*`→status. Les items `reasoning`, `thinking`, `analysis` et leurs variantes summary sont rendus dans une lane thinking dédiée, persistée avec le log et repliable dans le fil. Schéma MSP stable 1.2.1 (sha c7ff6c5d) : 33 méthodes dont 8 `subagent/*` control-only (close/followupTask/interrupt/readResult/reopen/resume/sendMessage/stop), **aucune méthode spawn/start** stable ni expérimentale ; item `subagent` : objective/role, agentPath, depth (sans max), childSessionId (drill-down via session/read|view/page), controlStatus open, résultat summary ≤512 chars / text ≤32 KiB ; 0 hit parallel/maxConcurrent/worktree/isolation (seuls caps = pagination view 1-1000, session list max 200, context/output caps).
Référence d'isolation (cookbook officiel) : concurrence ≈ cores-2 clampée 4-8 ; surnuméraires ADMIS et queués FIFO ; démo 6 simultanés ; chaque enfant writer = worktree git privé sous `.muse/worktrees/` detached-HEAD (base_commit, base_ref HEAD, cleanup remove_if_clean), depth 1, commit sur branche propre, checkout parent intact ; cycle `operation_requested>prepared>lease_active>workspace_scope_activated` ; vocabulaire = plan modèle-outil `subagent_spawn(role,objective,worktree_isolation:true)` + wait/read/status ; gate CLI `muse --subagent-worktree-isolation` (sans flag = partagé) ; fallback `git worktree add -b taskN-branch` manuel.
- **US-6 (M-V1) :** je vois chaque subagent (agentId, objective/role, depth, status, résultat tronqué) groupé par agentId, deltas concaténés dans son entrée ouverte. **AC :** 2 subagents entrelacés avec l'assistant → 3 entrées distinctes, aucun chunk mélangé ; parse JSON `{agent_id,text}` + fallback `/*id*/`/`id:` + texte brut.
- **US-7 (S-V2) :** je fane-out via le tour parent (prompt), pas via MSP (pas d'endpoint spawn appelable). **AC :** N demandes parallèles → N enfants visibles, file FIFO au-delà de cores-2 clamp 4-8 [TROU : N absolu officiel inexistant].
- **US-8 (S-V2) :** chaque writer tourne sur worktree privé `.muse/worktrees/` avec cleanup remove_if_clean. **AC :** checkout parent inchangé (hash HEAD avant/après identique) ; branche propre par enfant. Risques sourcés : même checkout = overwrite/état test contaminé → 1 worktree+branche/agent + file-level contract + validation déterministe, jamais d'intégration directe sur branche protégée [DZone] ; minimiser chevauchements, sinon 1 owner + autre en review, comparer diffs, noter ordre de merge [Warp].
- **US-9 (C-V2+) :** automations = instructions+skills planifiées background, résultats en review queue [ref-codex] ; scheduled récurrentes/one-shot (ex. lun/mer 9h), threads réutilisés [ref-claude/antigravity]. **AC :** création schedule, déclenchement à l'heure, résultat en review queue. [TROU : `workflow/*` sans ligne schéma (spec 14410 open) → parallélisme workflow non spécifiable sur MSP.]

### 3.3 Streaming / transparence (dont phase réflexive AVANT first token)
État prouvé : pas de SSE (0 hit SSE/EventSource dans src+src-tauri) ; `muse serve --help` v1.2.1 : host stdio, flags sandbox only, zéro mention streaming/SSE/polling/notifications/view ; recherche web MSP noyée par homonymes, aucune release-notes/devdocs trouvée [unresolved]. Front : `turn/started`→running=true immédiat, `started` peint avant le premier delta ; tick+kick sérialisés anti-doublons ; mort du host → `host_exited` + `running=false` sur toutes les sessions connues, stderr tail (20 lignes) dans l'erreur de handshake.
- **US-10 (M-V1) :** je vois immédiatement l'état réflexif avant le first token et peux inspecter la réflexion reçue. **AC :** après send, indicateur < 200 ms ; `item/started` affiché même sans delta ; deltas des items reasoning/thinking regroupés dans un bloc `<details>` distinct et repliable après la fin ; fast-poll 150 ms vérifié ; pas de burst de rattrapage (kick immédiat, pas d'attente du prochain tick lent).
- **US-11 (M-V1) :** le stream ne perd ni ne duplique. **AC :** test charge 2000 évts → aucun doublon, aucun trou `since` ; tick et kick concurrents → une seule livraison (chaîne `poll.ts`, rejet ne poisonne pas la chaîne).
- **US-12 (S-V2) :** résumé/volet plans/sources/artefacts + sidebar fichiers riches + summary pane [ref-codex MacRumors]. **AC :** volet récapitulatif par thread. [TROU : corps pages 9to5mac/MacRumors non fetchés au-delà snippets → onglets Work/Chat, terminal tabs, previews = snippets seuls.]
- **US-13 (W) :** pas de SSE tant que schéma/CLI ne l'exposent pas. [TROU : framing/listen à re-prouver via `muse serve --help` + SDK.]

### 3.4 Approvals / permissions
État prouvé : `approval/requested` → panneau choix (choiceId/label/decision/scope, toolName, summary `tool: rawArgs` tronqué 200) ; `approval/updated` remplace les choix et avance le `currentRequirementId` d'une commande composée ; `approve` exige requirementId + même session (anti-rejeu inter-sessions ; token stale rejeté host -32053, erreur remontée, jamais appliqué silencieusement) ; décisions multi-étapes : `terminal=false` conserve la carte et le token pour l'étape suivante, `terminal=true` le retire (rejeu impossible). Règles Codex : `prefix_rule` allow/prompt/forbidden, most-restrictive-wins, allow-list `~/.codex/rules/default.rules`, Smart approvals, trust-gated, `approval_policy` on-request/never/granular, `approvals_reviewer` user/auto_review. Zed : regex allow/deny/confirm (défaut confirm, `sudo` en confirm forcé), profils Write/Ask/Minimal. OpenCode : `permission` allow/ask/deny, `--auto` approuve tout non-deny, wildcards, par agent, `ask`→approbation.
- **US-14 (M-V1) :** j'approuve/refuse un choix avec scope visible. **AC :** approve sans requirementId ou inter-session → erreur affichée, aucun effet ; décision terminale → panneau retiré + reprise du polling/stream sans ligne système de protocole ; décision intermédiaire → panneau conservé et mis à jour sur `approval/updated` ; `cancel_session` = `turn/interrupt{retract:false}` best-effort + `running=false` quoi qu'il arrive.
- **US-15 (S-V2) :** allowlist persistante par commande + granularité allow/prompt/forbidden + most-restrictive-wins + allow/deny réseau/domaines. **AC :** persistance après restart, conflit → le plus restrictif gagne.
- **US-16 (S-V2) :** sandbox configurable (défaut dossier/branche + web search caché ; réseau/élevé exige permission ; rules projet/équipe) [ref-codex sécurité]. **AC :** tentative hors-scope → prompt ; réseau sans permission → denied. [TROU : config sandbox exacte muse (`--trust-workspace/--disable-sandbox`, `MUSE_ALLOW_UNSCOPED_READS=1 DANGEROUS`, `promptUnmatched→request_permission`) connue via brokkai/muse-acp seul — à confirmer via `--help`.]
- **Posture globale M0-06 (câblée côté client + host) :** le réglage **Ask for approval** sélectionne `onRequest` et laisse chaque `approval/requested` à l'utilisateur ; **Approve on my behalf** sélectionne `promptUnmatched`, auto-décide les choix dont les scopes restent locaux au workspace et conserve une question pour réseau/élévation ; **YOLO** sélectionne `allowAll` et décide le premier choix non refusé. La posture est persistée sous `muse-desktop.authorization-mode.v1`, envoyée à `session/start` et réconciliée en cours de session via `session/setApprovalMode`, sans contourner les choix `denied` ni les protections anti-rejeu.

### 3.5 Input answerable
État prouvé : `userInput/requested` → panneau answerable (≤10 questions, ≤20 options/question, modes single|multiple seuls, ids threadés) ; `answer_input` validé (tableau non vide, 1 seule clé/réponse parmi selectedLabel|selectedLabels|freeText, freeText ≤500 chars, host arbitre -32057, panneau conservé en erreur) ; `cancel_input` (`userInput/cancel`, reason `declined in UI`) ; `userInput/settled` retire le panneau + log `Input <outcome>` ; payload inparsable → log `input requested (unparseable)` + statut `input_requested`, jamais un chat bloqué sans réponse possible.
- **US-17 (M-V1) :** je réponds aux questions clarifiantes sans quitter le stream. **AC :** 11e question/21e option ignorée côté client ; freeText >500 refusé avant envoi ; question vide → throw `needs an answer` ; -32057 affichée, panneau conservé pour correction ; kick après answer pour peindre la reprise dès les premiers tokens.

### 3.6 Contexte (@mentions, fichiers, browser)
Zed : contexte assemblé via `@` (fichiers, dossiers, symboles, threads passés, skills, diagnostics, diffs, URL fetch) ; sélection multi-ligne auto-formatée en @-mention [ref-zed]. Instructions always-on via AGENTS.md perso/projet (+ `.rules`/CLAUDE.md compat) ; Skills = tâches invocables [ref-zed]. Claude : ordre Cowork = connecteurs > navigateur intégré/Chrome > computer-use (connecteur rapide, écran lent/fragile) [ref-claude].
- **US-18 (M-V1) :** je mentionne fichiers/dossiers/symboles/diffs via `@`. **AC :** résolution + chip visible + hors-scope workspace → permission.
- **US-19 (S-V2) :** navigateur in-app commentable type Atlas + computer-use background (voit/clique/tape, curseur propre) + génération image (gpt-image-1.5) [ref-codex 04/2026, confirmé 9to5mac : trio + 111 plugins, review GitHub, multi-terminaux, previews PDF/sheets]. Tout absent de muse-desktop. **AC V2 :** navigation + commentaire ancré ; computer-use avec permission par app, macOS15+ fond sans voler pointeur/clavier [ref-claude]. [TROU : maquette/choix Atlas vs Chrome ext. à trancher.]
- **US-20 (C-V2+) :** mémoire preview + suggestions proactives (prefs, corrections, contexte Slack/Notion/Docs/codebase) [ref-codex]. Mitigations drift/stale obligatoires : prompt 4000 tokens/25+ règles = drift persistant même Opus ; re-répétition allégée SCAN 20-300 tokens [HN] ; mémoire stale override preuve courante sans warning (stale 0.92-1.00) [arXiv]. **AC :** mémoire datée/sourcée + warning stale + SCAN périodique.

### 3.7 Artefacts / previews
Claude : artefacts autonomes fenêtre droite (docs/code/HTML/React), versions + edit-in-place, exigent exécution de code [ref-claude]. Antigravity : artifacts vérifiables (task lists, plans, walkthroughs, screenshots, browser recordings) + feedback async style Docs + select-and-comment sur screenshots ; l'agent se filme en testant l'app [ref-antigravity]. Code muse : chunks coalescés, pas d'artefacts versionnés.
- **US-21 (S-V2) :** j'ouvre un artefact versionné, j'édite in-place, je commente (select-and-comment). **AC :** N versions listées, restore en 1 clic, commentaire ancré au screenshot.

### 3.8 Recherche (locale + codebase)
Prouvé : aucun index natif chez Codex (feature request #20453 closed duplicate #5181 : spec demandée = background incrémental, NL→paths+symbols+lines, opt-in, .codexignore+.gitignore, exclusions build/logs/vendor/secrets/binaires, Delete Index, panneau status/pause/resume/rebuild — non implémenté, seul lien projet↔dossier) ; Claude Desktop = extensions MCP 1-clic, pas d'index natif, accès scopé aux fichiers sélectionnés. Référence d'implémentation (proposition, pas parité) : PivotSearch Tauri2+Vue3+Rust, 9 formats, Tantivy+jieba+stopwords, incrémental mtime+diff, watcher notify+debounce 1s, queue single-worker, merge multi-index + filtres.
- **US-22 (M-V1) :** recherche scopée workspace sous approbations + confinement (reads confinés cwd par défaut) [brokkai]. **AC :** chemin hors cwd → ask/deny ; workspace non-dossier ou irrésolvable → erreur explicite (canonicalize).
- **US-23 (S-V2) :** index local opt-in avec panneau status/pause/resume/rebuild + Delete Index (spec #20453). **AC :** formats supportés listés explicitement (ne pas promettre les 9 formats PivotSearch sans implémentation). [TROU : liste formats Codex/Claude inexistante — toute liste = proposition.]

### 3.9 Skills / connecteurs (type MCP) / plugins
Codex : Skills = instructions+ressources+scripts (agentskills.io), usage explicite/auto, partageables repo/team ; 90+ plugins (Jira, CircleCI, CodeRabbit, GitLab, MS Suite, Neon, Render), revue PR GitHub, multi-terminaux, SSH devboxes alpha [ref-codex]. Claude : MCP local `.mcpb` 1-clic (annuaire relu Anthropic) ; distant Free-Enterprise (Free=1 seul, exige internet public + allowlist IP, VPN/firewall privé KO) ; connecteurs héritent permissions source ; Skills à divulgation progressive, view-only par défaut ; MCP Apps rend des UI tierces dans le chat [ref-claude]. Zed : MCP Tools+Prompts, `notifications/tools/list_changed` sans restart, locaux/distants+OAuth ; Skills SKILL.md slash, partage `zed://skill` [ref-zed]. OpenCode : plugins = hooks + outils custom, `opencode.json` (global/projet/custom/remote/managed), 75+ providers, `/models`, `/connect` [ref-opencode]. muse-desktop : MCP local stdio explicite et découverte SKILL.md bornée ; le bridge moteur et le rendu riche restent ouverts.
- **US-24 (S-V2) :** j'installe un connecteur local en 1 clic (sans JSON manuel) depuis annuaire relu. **AC :** install + liste outils sans restart (hot-reload type `list_changed`).
- **US-25 (S-V2) :** skills invocables slash + auto, partageables repo/team, divulgation progressive. **AC :** `/nom-skill` exécute ; auto-suggestion tracée.
- **US-26 (C-V2+) :** MCP distant (1 seul en Free-like) avec garde Internet public/allowlist ; UI tierce rendue in-chat (MCP Apps). **AC :** échec VPN documenté + message explicite.

### 3.10 Collaboration / partage
OpenCode : lien public `opncd.ai/s/<id>`, modes manual(/share défaut)/auto/disabled, un-share + rétention [ref-opencode]. Zed : Channels persistants (pairing, mentoring, refactor temps réel), projet partagé édité comme local, notes Markdown, follow [ref-zed]. Claude Projects : partage view/edit Team/Enterprise [ref-claude].
- **US-27 (S-V2) :** je partage un thread via lien public + un-share. **AC :** lien révoqué → 404 ; mode auto/disabled respecté.
- **US-28 (C-V2+) :** je co-édite en channel persistant. **AC :** 2 clients éditent sans écrasement (CRDT/relay à spécifier [TROU : internes CRDT Zed non inspectés, code source non lu]).

### 3.11 Personnalisation / config
- **US-29 (M-V1) :** workspace persistant + activeId restaurés (+ `set_workspace` source de vérité côté Rust). **AC :** restart → même workspace/session active ; `start_session` sans workspace → erreur `Pick a workspace folder first` côté front / `no workspace selected` côté back, jamais d'écran vide ; titre auto = 1er input (42 chars max) sauf titre déjà renommé ; input vide → refusé (`empty input`).
- **US-30 (S-V2) :** modèle project-centric : 1 projet = 1+ dossiers (frontend+backend), settings agents/sécurité/MCP isolés par projet hérités du global + override [Antigravity codelabs] ; app standalone Mac/Linux/Windows + scheduled tasks ; IDE/CLI/SDK/VSCode/JetBrains/Zed à côté. **AC :** override projet prouvé par diff global/projet. **État M2-01 :** le premier dossier racine est désormais optionnel, persistant et sélectionnable depuis Projects ; les dossiers multiples, l'environnement/worktree et la migration guidée restent à implémenter.
- **US-31 (S-V2) :** providers multiples + locaux (75+ via AI SDK/Models.dev, reco GPT-5.x/Claude 4.5/Gemini 3 Pro) [ref-opencode]. [TROU : backend modèle muse non sourcé — ne pas promettre sans preuve.]

### 3.12 Accessibilité / i18n
Première passe câblée : `a11y.ts` fournit la navigation des choix, le piège Tab et les annonces de transitions ; `ApprovalPanel` et `InputPanel` déplacent le focus vers l'action à traiter ; les dialogues recherche/réglages/actions rendent le focus à leur déclencheur ; le premier composer reçoit le focus à l'accueil ; le flux reste `aria-live="off"` pour ne pas vocaliser chaque token. **[TROU]** : lecteur d'écran réel, zoom 200 %, contraste et parcours complet sans souris sur Windows WebView2/macOS/Linux.
- **US-32 (S-V2) :** j'approuve au clavier seul avec focus piégé correctement. **AC partiellement prouvé :** choix approval/input utilisables au clavier, fermeture Échap et retour de focus implémentés ; test assistive natif à produire.

### 3.13 Onboarding
Modèles prouvés : `/connect` credentials providers, `/models` sélection [ref-opencode] ; reprise sessions/config CLI et IDE [ref-codex] ; login ChatGPT [ref-codex MacRumors]. État muse : `kill_session` ne tue PAS le host partagé (interrupt best-effort + oubli local + purge lane-table `(sessionId,itemId)` anti-misroutage) ; sessions restaurées marquées stopped (les enfants sidecar ne survivent pas au restart, l'utilisateur relance par nouvel input) ; StrictMode-safe (pas de garde once, teardown annule boot + poll + `aliveRef` anti-setState post-unmount).
- **US-33 (M-V1) :** au premier lancement sans sidecar/binaire, erreur explicite (pas d'écran vide). **AC :** binaire manquant → message + chemins essayés (exe-dir, src-tauri/binaries) ; handshake KO → erreur + stderr tail ; `poll_events` KO → `event poll failed`.
- **US-34 (S-V2) :** import config CLI/IDE existante. **AC :** sessions reprises visibles.

## 4. MoSCoW récapitulatif

- **Must V1 :** host sidecar partagé/workspace (kill/respawn, handshake initialize→initialized), MSP ligne-par-ligne + timeout 120 s + UUIDv7, polling 150/1000 sérialisé + kick + buffer 2000, multi-sessions + persistance 2000/500 + tombstones, approvals choix anti-rejeu -32053 (multi-étapes terminal flag), input answerable 10/20/500/-32057 + cancel, coalesce itemId + subagents agentId `<details>` + fermeture ciblée, phase réflexive <200 ms, workspace canonicalisé + `set_workspace`, onboarding erreur sidecar explicite, mode dégradé hors-Tauri.
- **Should V2 :** Projects/RAG/partage, compaction, threads sidebar, fan-out via parent (cores-2 clamp 4-8, FIFO), worktrees `.muse/worktrees` + cleanup, allowlist persistante + sandbox granulaire + réseau allow/deny, artefacts versionnés commentables, index opt-in + panneau, Skills/MCP 1-clic + hot-reload + slash/auto, partage lien + un-share, project-centric overrides, browser in-app + computer-use permission-par-app, mémoire datée + SCAN anti-drift, review queue/automations/scheduled.
- **Could V2+ :** MCP distant + MCP Apps in-chat, image-gen, SSH devboxes, multi-terminaux, channels co-édition, suggestions proactives Slack/Notion/Docs.
- **Won't / hors-spec :** SSE tant que non exposé ; « workflow tabs » Editor/Manager/Browser comme nommage officiel (aucune occurrence officielle — Codex = threads+onglets Work/Chat + onglets browser [snippets] ; issue #33301 = tiled panes en feature request ; muse-desktop = sidebar+conversation+panneaux, plan V1 sans onglets — maquette Figma à trancher) ; promesse de parité formats d'index ; comparatif chiffré d'excellence sans body inspecté (voir §5).

## 5. Exigences UX chiffrées (feedback/délais)

| Paramètre | Exigence V1 | Source |
|---|---|---|
| Poll streaming/idle | 150 ms / 1000 ms, chaîne sérialisée, kick après action | useMuseSessions + poll.ts |
| First feedback (réflexion) | <200 ms après send (avant first token) | dérivée du polling 150 ms |
| Timeout requête MSP | 120 s, erreur affichée | msp.rs |
| Buffer / persistance | 2000 évts buffer ; 2000 entrées/session ; 500 tombstones ; stderr tail 20 lignes | main.rs + persist.ts |
| Input answerable | ≤10 questions, ≤20 options, freeText ≤500 chars, 1 clé/réponse, modes single\|multiple | main.rs + input.ts |
| Approvals | choices {choiceId,label,decision,scope}, summary tronqué 200 chars, -32053 en erreur | main.rs |
| Résultat subagent | summary ≤512 chars, text ≤32 KiB | schéma MSP |
| Pagination | view 1-1000, session list max 200 | schéma MSP |
| Titre auto / commande | 42 chars max ; `commandId` UUIDv7 | hook + msp.rs |
| Concurrence modèle | ≈ cores-2 clamp 4-8, FIFO, démo 6 simultanés | cookbook |
| Bundle | Tauri 8.6 MiB vs Electron 244 MiB ; renderer macOS Chromium ~2x WKWebView ; 6 fenêtres ~409 Mo Electron ; contrepartie = quirks cross-platform | dev.to/gethopp |
| Référence latence/coût concurrents (contexte, pas engagement) | Codex 5-10 s délais malgré GPT-5.3 +25% inf ; Gemini leader latence, Claude Fast ~2.5x speedup à 6x tokens ; Terminal-Bench 2.0 GPT-5.3-Codex 77.3% vs Opus 4.6 65.4%, SWE-bench Claude 80.8%, contexte Codex 400K in/128K out vs 1M Claude/Gemini ; pricing GPT-5.3-Codex $1.75/$14 par 1M, session $0.50-2.00, Plus $20, Go $8, Pro 5x/20x, Fast 2.5x crédits, bascule crédits 02/04/2026 | IntuitionLabs + CloudZero (body $100 Pro 5x non confirmé [TROU]) |

Garde-fous perf sourcés (à transposer en tests V1) : client Codex Electron 26.5 à 264-285% CPU côté IPC/log/history (sessions ~/.codex 596 Mo, JSONL 50-180 Mo), logs_2.sqlite ~301 Mo + renderer ~831 Mo → typing/scrolling effondrés ; stream ScreenCaptureKit laissé à 55-56 FPS sans consommateur (WindowServer 50-60% CPU, 59% GPU, seul quit résorbe) → lier tout stream à la vie consommateur/session + idle guard + reaper ; Tauri sidecar = process séparé sans IPC magique, vie à lier au parent (force-quit laisse le port vivant) ; auto-update bricking (ownership système, retirer si doute) ; messaging natif sans consentement (critique ePrivacy) ; hard-block Windows hors `C:\Users\<user>` malgré config.

## 6. Points non couverts / trous bloquants (à lever avant PARTIE 2 technique)

1. Protocole MSP réel : framing/handshake sans credentials, méthodes/params exacts, codes -32053/-32057, `listen` vs polling — valider via `muse serve --help` + schéma TS (commentaires seuls aujourd'hui). 2. Lifecycle : 1 host partagé/workspace acté par le code (plus d'ambiguïté 1-processus/session : `kill_session` ne tue pas le host) — reste à trancher portée sandbox et perte contexte au switch workspace. 3. Packaging : seul binaire linux, externalBin générique, matrice triples/test bundle absents. 4. Branding premium Meta : zéro asset — indescriptible. 5. Benchmarks/latence/coûts-crédits Codex : OSWorld 64.7%/SWE-Pro 56.8% (Neowin 403, snippets seuls) ; rate-card Extra Credits + $100 Pro 5x non confirmés en body. 6. Codex : allowlist/benchmarks/conflits worktrees/dérive mémoire/review-queue/config sandbox exacte — rules non fetchées, presse seule. 7. Claude : streaming temps-réel, formats d'index, bugs perf/permissions, MCP Apps in-chat — aide seule, devdocs non inspectées. 8. Antigravity : N parallèle absolu, nommage workflow-tabs, coûts/latence/review-policies/presets — docs officielles non lues. 9. OpenCode : LICENSE (MIT ?), stack desktop, transport SSE/polling — non relus. 10. Zed : slash historiques (/fetch /file /diagnostics, 404), CRDT/Lamport, 120fps/sub-ms — secondaires seuls. 11. Docs OpenAI/Anthropic officielles non lues directement ; DigitalTrends browser Claude (202, 0 octet), corps 9to5mac/MacRumors tronqués/403 ; balayage muse-desktop borné 50000 entrées. 12. Deltas sans cadrage V1/V2 ni maquette : computer-use, browser commentable, image-gen, MCP+rendu riche, skills, automations/scheduled, mémoire, projects/worktrees, artefacts, channels — absences constatées, spec détaillée impossible sans sources.

---

# muse-desktop — PARTIE 2 : Spec technique (depuis existant audité)

> Périmètre : client desktop Tauri + React adossé au CLI `muse serve` (sidecar). Positionnement : équivalent brandé Meta Muse de Codex Desktop / Claude Desktop. Existant prouvé par lecture : `src-tauri/src/main.rs` (≈1099 lignes), `src-tauri/src/msp.rs`, `src/hooks/useMuseSessions.ts` (≈821 lignes), `src/lib/poll.ts`, `src/lib/persist.ts`, `src/lib/input.ts`, `src/lib/env.ts`. Tout ce qui n'est pas prouvé par ce code est marqué **[TROU]**.

## 1. Architecture cible

### 1.1. Principes

- `muse-desktop` = shell desktop (Tauri + React) autour d'un **moteur agent unique : `muse serve`** embarqué en **sidecar**. Pas de moteur LLM dans le client (`main.rs` L1-13 : « No agentic logic lives here: spawn, frame relay, kill »).
- Référence OpenCode : même pattern TUI + desktop autour d'un moteur headless (`serve [--port --hostname --cors]`, défaut `127.0.0.1:4096`) + SDK type-safe. Ici : sidecar `muse` + client MSP maison `MspClient` (`msp.rs` L138-143) — **[TROU : pas de SDK JS connu, pas de port/contrat HTTP prouvé dans le code lu]**.
- Protocole **MSP JSON-RPC 2.0 ligne-par-ligne** (`msp.rs` L1-13 : une frame par ligne, `serde_json` échappe les `\n` internes), params camelCase (`sessionId`, `commandId`). Pas ACP — interop ACP hors scope V1 **[TROU : framing prouvé par code + schéma TS cité en commentaire, handshake live impossible en sandbox sans credentials — hypothèse documentée, non prouvée live]**.

### 1.2. Sidecar Tauri

- Résolution : `resolve_sidecar()` (`main.rs` L227-258) construit `binaries/muse-<TAURI_ENV_TARGET_TRIPLE>` (+`.exe` sous Windows), cherche (1) à côté de `current_exe()` (layout bundlé `externalBin`), (2) `CARGO_MANIFEST_DIR/binaries/` (dev) ; sinon erreur listant les chemins essayés + renvoi vers `src-tauri/binaries/README.md`. `spawn_sidecar()` (L260-277) passe le chemin absolu à `shell().sidecar()` (join no-op), `.args(["serve"])`, `.current_dir(root)` — **sandbox fixée au spawn via le cwd**.
- Premier lancement Windows : `SidecarErrorPanel` garde le message borné et les chemins sondés, puis présente une guidance contextuelle à partir des indices de l'erreur (binaire, WSL, CLI Muse, authentification, dossier accessible) avec actions Réessayer et Choisir un dossier. Cette guidance n'installe rien et ne prétend pas valider WSL/auth ; validation sur machine propre et distributions non par défaut **[TROU]**.
- État prouvé : **un seul host partagé, multiplexé par `sessionId`** (`AppState.host: Mutex<Option<Host>>`, L83-97) ; **un host par workspace — changer de workspace tue/respawn l'ancien** (`ensure_host()`, L141-211 : compare `h.workspace == *root`, sinon `shutdown()` puis respawn). Création sérialisée par `host_mutex: tokio::Mutex<()>` (L94) : deux `start_session` concurrents ne spawnent pas deux hosts.
- Handshake en deux temps (L185-200, « proven against the real binary ») : `request("initialize", {clientInfo:{name:"muse_desktop", version:"0.1.0"}})` puis `notify("initialized", Null)` — sans le notify, tout appel ultérieur échoue `Not initialized`. La réponse est validée avant le notify : `serverInfo.name=muse`, version non vide, `schema.version=1` et fingerprint `sha256:*`; une incompatibilité arrête le sidecar avec une erreur exploitable et ses 20 dernières lignes stderr (`stderr_tail`, `tail_of()`).
- Surface IPC (`main()` `invoke_handler!`) : commandes `start_session / set_approval_mode / restore_sessions / send_input / approve / answer_input / cancel_input / cancel_session / kill_session / set_workspace / poll_events`. Événements front : `output, subagent_event, tool_request, status` (+ `input_request`, `input_settled` via `emit()` L107).
- Shutdown propre : `RunEvent::Exit` → `take()` + `block_on(shutdown())` = `kill()` du sidecar (L1088-1098). **[TROU — packaging]** : seul le mécanisme générique est prouvé ; matrice triples Win/Mac, test bundle, preuve d'erreur sidecar manquant en UI non lus. Risque : force-quit sans `Exit` laisse le port vivant **[TROU : garde port non implémentée dans le code lu]**.

### 1.3. Protocole MSP (état audité)

- `msp.rs` : `encode_request(id, method, params)` (L68-74, omet `params` si Null), `encode_notification` (L77-83, sans `id`), `split_lines(buf, chunk)` (L86-99 : accumule partiels, split `\n`, strip `\r`, ignore lignes vides), `route_frame()` (L103-131 : `id` → complète le `oneshot` pending (`result`/`error→RpcError{code,message}`), `method` sans `id` → canal `notify_tx`).
- `MspClient` : `child: SharedChild` (`Arc<Mutex<Option<CommandChild>>>` — `write` partage `&mut`, `kill` consomme), `next_id: AtomicU64` dès 1, `pending: HashMap<String, Sender>`. `write_line()` ajoute `\n` puis `child.write()` ; `notify()` sans réponse ; `request()` timeout **120 s** (`tokio::time::timeout`, L199) avec nettoyage `remove_pending`, erreurs typées (« sidecar write failed », « dropped the response », « timed out: {method} »). `shutdown()` : `take()` + `kill()` + `pending.clear()` (les appelants ne pendent pas).
- `new_command_id()` (L41-65) : UUIDv7 (timestamp unix-ms 48 bits, nibble version 7, 74 bits aléatoires `/dev/urandom` best-effort, variant `10`). Tests Rust : 6 tests (`command_ids_look_like_uuidv7`, `notification/request_frame_shape`, `split_lines_buffers_partials`, `route_response_completes_pending`, `route_error_and_notification`).
- **Contrat vérifié depuis le binaire Windows embarqué** (`muse schema generate-ts` stable) : `turn/start.input` est une liste non vide de `TurnInputPart` de type fermé `text|image|skill`. Une part `text` porte `text`; une part `image` porte `mediaType` et `base64Data`, avec `width`/`height` obligatoirement appariés ; les mentions de fichiers restent du texte et la part `mention` est rejetée. Les méthodes/params non exercés en live restent à qualifier, mais Muse peut maintenant transmettre des images réelles sans inventer une part fichier.

### 1.4. Transport temps réel (polling retenu)

- Existant : **polling** sur `EVENT_BUFFER_CAP = 2000` (`VecDeque<DrainedEvent{seq, session_id, kind, payload}>`, `event_seq: u64`, L81/95-96). `emit()` (L107-129) bufferise + `pop_front()` au-delà du cap. `poll_events(since: Option<u64>)` (L690-706) : `since=None` → head seul sans replay ; sinon `seq > since`. Commentaire L77-80 et hook L304-306 : push `listen` abandonné car « subscriptions resolved yet never fired » dans un env **[TROU : env, repro, mesures absents]**. Aucun journal brut des frames n'est activé en production.
- Front (`useMuseSessions.ts` + `poll.ts`) : `POLL_FAST_MS=150` / `POLL_SLOW_MS=1000` (L70-71), boucle `setTimeout` adaptative sur `runningRef` (L390-400, pas `setInterval` — pas d'empilement), chaîne sérialisée unique `PollChain{current}` + `enqueuePoll(chain.current.then(poll,poll))` (poll.ts L20-22) : tick périodique et `kickPoll()` post-`send/answer/approve` partagent `cursorRef`, jamais deux drains avec le même curseur (sinon texte dupliqué). Boot : `poll_events{}` initial pose le curseur au head (pas de replay d'historique), puis `tick()`. `aliveRef`/`cancelled` protègent StrictMode (double-mount) et `setState` post-unmount.
- Statuts dérivés des kinds : `STOPPED_KINDS={cancelled, completed, stopped, exited, host_exited, error, turn_end, idle}`, `RUNNING_KINDS={started, running, created, turn_start}` (L122-134) ; `turn/*` → `running/stopped` via `mark_running()` + `emit("status",…)`.
- Cible : push (`listen` réparé ou WebSocket/SSE) avec fallback polling. **[TROU]** : caps (2000 évts, 150/1000 ms, 120 s) sans mesure de charge ; d'abord instrumenter (taux déclenchement, latence, CPU, drops), puis décider (§7 M1).

### 1.5. Persistance locale

- `persist.ts` : clés `muse-desktop.{sessions,workspace,active,tombstones}.v1` + `muse-desktop.log.v1.{sessionId}` (L36-40), avec la façade défensive `storage.ts`. `StoredSession{session_id, workspace, title, createdAt}`, `LogEntry{id, ts, role:user|assistant|thinking|subagent|system|tool, text, agentId?, itemId?, open?}`. `MAX_LOG_ENTRIES=2000` (append-only, `slice(-2000)` sur `appendLog`/`saveLog`), `MAX_TOMBSTONES=500` (`saveTombstones(ids.slice(-500))`). `loadLog` ferme les blocs `open` restés ouverts (nouveaux chunks → nouvelles entrées). Les lectures invalides reviennent au fallback sans exception et enregistrent un diagnostic borné (`unavailable`, `corrupt`, `quota`) ; les écritures conservent la valeur précédente en cas d'échec. `SettingsPanel` expose `exportStorageSnapshot()` pour exporter localement les clés `muse-desktop.*` dans un JSON de récupération, sans appel réseau ni moteur. Les migrations de versions antérieures et la restauration guidée restent **[TROU]**.
- `useMuseSessions` : boot restaure sessions/logs/workspace/activeId (sessions marquées `running:false` — les enfants ne survivent pas au restart), filtre tombstones ; write-through (`saveSessions` sans `running`, `saveActiveId`, `saveWorkspace` sauf `null`) ; `killSession` → tombstone + `dropLog` + purge approvals/inputs + réassignation activeId.
- Exigence (leçon Codex #22053/#18693) : quotas + virtualisation liste, jamais de log illimité — déjà tenu par les caps 2000/500.

### 1.6. Multi-fenêtres / multi-surfaces

- Layout réel prouvé par le hook + persistance : sidebar sessions + log conversation coalescé + panneaux approval/input + composer — **[TROU : `App.tsx` (107 lignes citées en partie 1) non relu dans ce lot, structure exacte des composants non prouvée ici]**. Zéro endpoint multi-fenêtre dans les 10 commandes ; `workflow tabs / Editor / Manager / Browser` sans occurrence — maquette à trancher (voir partie 1 §4 Won't).

## 2. Modèle de données et contrats

### 2.1. Entités front

`MuseSession = StoredSession + {running:boolean}` ; `MuseEvent{session_id, kind, payload}` ; `DrainedEvent = MuseEvent + {seq:number}` ; `PollResult{head, events}` ; `ApprovalRequest{session_id, request_id, summary, toolName, choices:ApprovalChoice{choiceId,label,decision,scope}[]}` ; `InputRequest{session_id, input_id, tool_name, questions:InputQuestion{id,header,question,mode:single|multiple,min/maxSelections?,options:{label,description}[]}[]}` ; tombstone = `sessionId` brut.

### 2.2. Commandes Tauri → sidecar (implémentation exacte)

| Commande front (`invoke`, camelCase) | Méthode MSP | Params | Fichier/fonction |
|---|---|---|---|
| `set_workspace{path}` | — (local) | vérifie `is_dir` + `canonicalize`, source de vérité Rust | `main.rs:548 set_workspace` |
| `git_worktree_create{sessionId,branch,relativePath,baseRef}` | — (local Git) | résout la racine de la conversation, exige un chemin sous `.muse/worktrees/`, valide refs et renvoie le checkout canonique | `main.rs:1174 git_worktree_create` |
| `git_worktree_remove{sessionId,path}` | — (local Git) | exige un chemin canonique déjà présent sous `.muse/worktrees/`, vérifie qu'il est propre, puis retire le checkout après confirmation UI | `main.rs:1191 git_worktree_remove` |
| `git_worktree_inspect{sessionId,path}` | — (local Git) | relit le checkout géré avant cleanup et renvoie branche, HEAD, propreté, conflits, nombre de fichiers et horodatage ; tout chemin hors `.muse/worktrees/` est refusé | `main.rs:1204 git_worktree_inspect` |
| `worktree_setup_run{sessionId,path,command}` | — (local process) | exécute uniquement une commande saisie explicitement dans un worktree existant sous `.muse/worktrees/` ; stdin désactivé, commande ≤2 000 caractères, sortie ≤200 000 caractères, timeout 10 min ; renvoie `ready|failed|timedOut`, sortie, code et durée | `main.rs:1218 worktree_setup_run` |
| `mcp_local_probe{command,workspace?}` | — (local MCP stdio) | démarre la commande fournie explicitement, échange `initialize`/`notifications/initialized` puis `tools/list`, et renvoie serveur, version, outils et durée ; commande ≤2 000 caractères, timeout 30 s | `main.rs:mcp_local_probe` |
| `mcp_local_call{command,workspace?,toolName,arguments}` | — (local MCP stdio) | refait le handshake et appelle `tools/call` avec des arguments JSON ; renvoie le résultat borné et `isError`, sans processus persistant | `main.rs:mcp_local_call` |
| `skills_scan{workspace?}` | — (local filesystem) | lit les `SKILL.md` des racines conventionnelles du workspace, avec documents et erreurs bornés ; n'exécute rien et refuse les liens symboliques sortants | `main.rs:skills_scan` |

Handoff M2-05 : `buildHandoffPlan` produit une prévisualisation locale et en lecture seule pour Local ↔ Worktree. Elle vérifie le workspace source, la cible gérée, les conflits, les changements non commités, l'observation de l'état cible et l'usage de la branche ; chaque check est `pass`, `warn` ou `blocked`. Tant que le host MSP reste mono-workspace, ce plan ne déplace ni session ni fichiers et ne peut pas annoncer une reprise réussie.

Rétention M2-06 : `git_worktree_inspect(sessionId,path)` relit le statut Git du checkout géré avant nettoyage. `git_worktree_remove` refuse un worktree dont le statut contient des fichiers modifiés ou en conflit ; l'archivage de conversation et la suppression du checkout restent deux actions distinctes. Les processus actifs et la rétention configurable ne sont pas encore exposés par le contrat.
| `start_session{workspacePath?,authorizationMode?}` | `session/start` | `{commandId:UUIDv7, workspaceRoot, approvalMode?}` ; mapping produit `ask→onRequest`, `workspace→promptUnmatched`, `yolo→allowAll`. Un modèle global/projet concret est ensuite appliqué par `session/setModel`; `default` conserve le choix du moteur | `main.rs:1064 start_session` |
| `fork_session{sessionId}` | `session/fork` | `{commandId:UUIDv7, sessionId, excludeItems:true}` ; copie tous les tours terminés, conserve l’engine/workspace et exige un nouvel identifiant | `main.rs:1474 fork_session` |
| `set_approval_mode{sessionId,mode}` | `session/setApprovalMode` | `{commandId:UUIDv7, sessionId, mode}` ; applique le mode aux actions suivantes | `main.rs:1099 set_approval_mode` |
| `restore_sessions{}` | `session/list` | `{}` ; `[]` si pas de host (boot frais) ; parse `sessionId\|id`, `workspaceRoot\|workspace`, `status=="running"` | `main.rs:709 restore_sessions` |
| `send_input{sessionId,text,inputParts?}` | `turn/start` | valide les parts `text|image`, MIME/base64/bornes ; défaut `{type:"text",text}` ; le host renvoie `disposition` (`started|queued|steered`) et `turnId` ; `mark_running(true)` | `main.rs:1686 send_input` |
| `approve{sessionId,approvalId,choiceId}` | `approval/decide` | `requirementId` rejoué depuis `PendingApproval` ; anti-rejeu inter-sessions (erreur si `pending.session_id != sessionId`) ; stale host → `-32053` en erreur ; `terminal!=false` → retire le token (pas de replay) | `main.rs:786 approve` |
| `answer_input{sessionId,userInputId,answers}` | `userInput/answer` | validation : array non vide, `questionId` non vide, **exactement 1** clé parmi `selectedLabel/selectedLabels/freeText`, `freeText ≤500` ; host arbitre `-32057` | `main.rs:850 answer_input` |
| `cancel_input{sessionId,userInputId}` | `userInput/cancel` | `{…, reason:"declined in UI"}` | `main.rs:904 cancel_input` |
| `cancel_session{sessionId}` | `turn/interrupt` | `{commandId, sessionId, retract:false}` best-effort + `mark_running(false)` + `emit(status,cancelled)` | `main.rs:935 interrupt_session` |
| `kill_session{sessionId}` | — (via interrupt) | **ne tue pas le process partagé** ; purge `sessions`, `approvals` de la session, `item_kinds` de la session (anti-misroutage sur réutilisation d'`itemId`) | `main.rs:972 kill_session` |
| `poll_events{since?}` | — (local) | drain `seq > since`, head courant | `main.rs:691 poll_events` |

### 2.3. Événements sidecar → UI (`route_notification`, `main.rs:371-543`)

`item/started` → mémorise `item_kinds[(sessionId,itemId)] = kind` (défaut `agentMessage`) ; `item/delta{itemId,delta}` → lane par kind mémorisé : `subagent|workflow|reminderChild` → `emit(subagent_event,{agent_id:itemId,text:delta})`, reasoning/thinking/analysis et variantes → `emit(thinking,{itemId,text:delta})`, sinon `emit(output,{itemId,text:delta})` ; `item/completed|item/updated` → `emit(status,item_done,{itemId})` (extrait `item.itemId‖item.id‖itemId`, `""` sinon) ; `approval/requested` → stocke `PendingApproval{session_id, requirement_id:currentRequirementId}` sous `approvalId`, payload `{request_id‖approvalId, toolName, summary:"{tool}: {rawArgs≤200}", choices[{choiceId,label,decision,scope}], itemId}` → `tool_request` ; `approval/updated` → remplace les choix et le `currentRequirementId` du même `approvalId`, émet `tool_request{updated:true}` sans fermer le bloc de reprise ; `approval/resolved` → retire le token, `emit(status,{approvalId,decision,terminal:true})` ; `turn/started` → `status:started` ; `turn/completed` → `mark_running(false)` + `status:{terminal‖completed}` (+`reason`/`error.message`) ; `turn/retracted|unqueued|retryScheduled` → status tel quel ; `userInput/requested` → `build_input_request_payload()` (questions `.take(10)`, options `.take(20)`, modes `single|multiple` seuls, `None` → `status:input_requested(unparseable)`) puis `input_request` ; `userInput/settled` → `input_settled{inputId,outcome}` ; inconnues ignorées (schéma additif). `pump_stdout` (L281-329) : `split_lines` sur stdout → `ingest` (ou `unparseable frame` en stderr_tail), stderr → tail 20 lignes, `Terminated` → `mark_running(false)` + `host_exited` à toutes les sessions connues.

Rendu (`useMuseSessions.handleEvent`, L468-609) : `output` → `parseChunk` (`{itemId,text}` JSON ou texte brut, jamais de throw) coalescé dans la **dernière entrée `assistant` ouverte** (`lastOpenIndex`, L188-198 — pas la dernière entrée brute, pour ne pas fragmenter sur entrelacement subagent/tool) ; `subagent_event` → `parseSubagent` (JSON `agent_id|id|name` + `text|chunk|output`, ou `/*id*/ texte`, ou `id: texte`, sinon `agent`) groupé par `agentId` ouvert ; `input_request` → `parseInputRequest` (null → ligne système) ; `input_settled` → retire le panneau + ligne système ; `item_done` → `closeOpenBlocks(itemId?)` (avec id : seul ce bloc ; sans : tous) ; `tool_request` → `parseApproval` (dédupliqué par `request_id`, + ligne `tool`, ferme les blocs) ; autres → liveness + ligne système `[kind] payload`, ferme les blocs.

### 2.4. Parallélisme / sous-agents

Prouvé par le code lu : sous-agents = orchestration sidecar, **aucun spawn IPC direct** (aucune commande ne crée d'agent ; `item_kinds` + lanes `subagent_event` + `parseSubagent`/`lastOpenIndex(role:subagent)` = seule surface). Limites chiffrées prouvées ici : `take(10)` questions, `take(20)` options, `freeText ≤500`, buffer 2000, tombstones 500, log 2000, timeout 120 s, poll 150/1000. **[TROU : tout le reste (33 méthodes, 8 `subagent/*`, `cores-2 clamp 4-8`, worktrees `.muse/worktrees`, `workflow/*` #14410) vient du schéma/cookbook cités en partie 1, non relus dans ce lot — repris tels quels, à re-prouver depuis le binaire.]**

## 3. Streaming et visibilité réflexive

- V1 : garder polling + chaîne sérialisée ; afficher `item/started|delta|completed`, `turn/*→running/stopped`, tool calls, sous-agents groupés. Premier feedback < 200 ms dérivé du tick 150 ms + `kickPoll()` immédiat après `send/approve/answer` (évite le burst de rattrapage).
- Détails prouvés à conserver : `closeOpenBlocks(sessionId)` avant `sendInput` (nouveau tour = nouveaux blocs), titre auto `shortTitle()` (42 chars, première saisie, L136-139), `ensureSessionRow()` anti-résurrection tombstone, `runningRef`/`handleEventRef` hors-render (StrictMode-safe), `isTauriRuntime()` (`__TAURI_INTERNALS__`, `env.ts`) → `backendMissing` (hors webview : historique local seul, pas d'appels backend).
- Le contenu des items de raisonnement est maintenant conservé dans le log et présenté derrière une disclosure `Thinking`. Le protocole live doit encore être requalifié avec un moteur qui émet réellement ces items afin de confirmer le nom exact du kind et le volume à afficher ; les alias sont volontairement additifs.

## 4. Sécurité / permissions

- Prouvé : approbation par choix avec `PendingApproval.requirement_id` opaque rejoué verbatim + garde anti-rejeu inter-sessions + rejet stale host en erreur (jamais d'application silencieuse) ; `answer_input` validé (1 clé, 500 chars, `-32057` host) ; `send_input` rejette vide ; `resolve_workspace`/`set_workspace` exigent dossier existant + `canonicalize` (le sidecar hérite ce cwd) ; `kill_session` ne tue jamais le host partagé ; `shutdown()` échoue les requêtes en vol (pas de pendaison sur host mort) ; `host_mutex` anti-double-spawn ; `item_kinds` scopé `(sessionId,itemId)` + purgé au kill (anti-misroutage) ; logs best-effort confinés aux clés `muse-desktop.*`.
- Références V2 (partie 1 §3.4) : allowlist persistante most-restrictive-wins, sandbox granulaire, réseau allow/deny. **[TROU : flags sandbox exacts `muse serve` non relus ici ; `MUSE_ALLOW_UNSCOPED_READS`, `--trust-workspace/--disable-sandbox`, `promptUnmatched→request_permission` cités de `brokkai/muse-acp`, à confirmer via `--help` ; branding/CSP non relus dans ce lot.]**

## 5. Observabilité / logs

- Prouvé : `stderr_tail` 20 lignes dans les erreurs handshake/host-death, chaque ligne bornée à 1 000 caractères et le message total à 8 000 ; les valeurs `token`, `password`, `api_key` et bearer sont masquées avant affichage ; la troncature respecte UTF-8. `evtCount` reste un diagnostic dev (`useMuseSessions` L257) ; `BUILD_ID="2026-09-08-poll-transport"` (`env.ts` L10, anti-webview stale). Les frames MSP et prompts ne sont pas enregistrés en clair.
- Exigences : log structuré (sessionId, commandId UUIDv7, latences poll, tailles frames, drops buffer), statut `listen` vs `poll`, compteurs caps (2000/500), export diagnostic 1-clic ; lier tout stream à la vie consommateur/session + idle guard + reaper (leçon ScreenCaptureKit 55 FPS) ; kill sidecar à `Exit`.

## 6. Tests et qualité

- Prouvé : tests Rust `msp.rs` (framing, formes de frames, routage réponse/erreur/notification), tests `main.rs` (payloads input, routage scope, modèles, sous-agents, approbations composées et lanes thinking) ; helpers `input.ts` purs sans imports (testables `node:test`), `poll.ts` sans dépendance.
- Cible V1 : unit (coalescence `itemId` — `lastOpenIndex` + `parseChunk`, groupement `agentId` — `parseSubagent`, caps 2000/500 — `slice(-…)`, validation input — `buildAnswers` + garde Rust, anti-rejeu — mismatch session), intégration (1 host partagé + kill/respawn workspace via `ensure_host`, `initialize→initialized`, timeout 120 s), e2e (send→stream→approve→answer→completed), perfs (150 ms sans doublon via chaîne, 2000 entrées fluides + virtualisation **[TROU : virtualisation non prouvée dans le code lu]**), packaging (matrice triples, sidecar manquant → erreur claire via `resolve_sidecar`).
- CI câblée : `.github/workflows/ci.yml` exécute `npm ci`, `npm test`, `npm run build` et `cargo test --manifest-path src-tauri/Cargo.toml` sur push/PR, sans credentials ni binaire sidecar. La suite locale actuelle est à 381 tests Node et 40 tests Rust.
- **[TROU]** : `LICENSE`, couverture e2e native, fixture MSP contrôlée et rapports de capture sans données utilisateur — à ajouter avant la sortie M0-14 complète.

## 7. Roadmap (jalons depuis l'existant)

- **M1 — Durcir l'existant** : instrumentation opt-in et rédactée de `listen` vs `poll` (taux, latence 150/1000, CPU, drops 2000) ; quotas UI + virtualisation ; matrice sidecar Win/Mac/Linux + erreur sidecar manquant ; acter `muse serve --help` + schéma TS depuis le binaire.
- **M2 — Parité minimale** : threads/projets + switch sans perte (déjà : log 2000 + restore), skills `SKILL.md`, artefacts versionnés fenêtre droite, partage view/edit.
- **M3 — Multi-agents sûrs** : fan-out via tour parent (pas de spawn MSP dans le code lu), file FIFO, worktrees par writer, file-level contracts + validation déterministe, garde anti-drift SCAN.
- **M4 — Automations/scheduled** : instructions+skills planifiées, review queue — non spécifiable via `workflow/*` tant que spec 14410 ouverte **[TROU, repris de partie 1]**.
- **M5 — Deltas V2+** : computer-use, browser in-app commentable, image-gen, MCP + rendu riche, mémoire, channels, plugins, multi-terminaux, SSH devboxes — absences constatées, sans source dans le code lu.

## 8. Risques et décisions ouvertes

1. Lifecycle 1-host-partagé/workspace (perte contexte au switch — `ensure_host` tue l'ancien ; portée sandbox = cwd au spawn). 2. `listen` vs polling (env inconnu, sans mesure). 3. Pas de spawn MSP dans le code lu → fan-out uniquement model-tool **[TROU si le schéma expose un spawn : à re-prouver]**. 4. Drift mémoire + conflits inter-worktrees. 5. Lock-in/IP/licensing, tokens/policy/audit ; benchmarks non stabilisés (voir partie 1 §5). 6. Branding sans asset relu ici. 7. `/dev/urandom` best-effort (collisions = clés d'idempotence dupliquées).

## 9. Audit SDK officiel (2026-09-13, `meta-models/muse-code-sdk`, schéma `msp.schema.json`)

Schéma officiel : 31 méthodes, 23 notifications, registre d'erreurs. Constat :
aucun écart dans ce que notre client envoie (`initialize`, `session/start`,
`session/read`, `session/resume`, `session/list`, `model/list`,
`session/compact`, `session/setModel`, `session/setApprovalMode`,
`turn/start`, `turn/interrupt`, `approval/decide`, `userInput/answer`,
`userInput/cancel` et les cinq contrôles `subagent/*` réellement utilisés —
params conformes, `commandId` UUIDv7 requis quand attendu, `workspaceRoot`
valide, posture mappée vers l'enum fermé du host).
Codes `-32053 approvalRequirementStale` / `-32057 userInputAnswerInvalid`
confirmés. **Pas de méthode spawn** → fan-out via tour parent acté.
`subagent/*` = exactement 8 méthodes control-only → acté. **Pas de
`workflow/*`** → scheduling client-side acté. Le seuil tokens a une source
réelle : notifications `session/contextUsage` + `session/tokenUsage`.
Capacités serveur non exploitées (pistes) : `session/compact`,
`model/list` + `session/setModel`, `turn/steer`, `session/fork`,
`turn/cancel`/`unqueue`, `view/page`, `approval/listPending`,
`userInput/clarify`. Garde-fou : `src/lib/msp.ts` + `test/msp-conformance.test.ts`
valident nos méthodes/notifications contre `@muse-code/sdk@0.1.1` à la
compilation (`import type` uniquement, zéro byte runtime). Reste ouvert :
`EXPECTED_SCHEMA_FINGERPRINT` du binaire embarqué (à vérifier via
`checkServedFingerprint`).

## 10. Points non couverts (preuves manquantes — ne pas spécifier sans elles)

`App.tsx`/composants (`ApprovalPanel`, `InputPanel`, `Composer` cités partie 1, non relus ici) ; `tauri.conf` (`externalBin`) ; `src-tauri/binaries/README.md` + binaires présents ; `muse serve --help` + schéma TS depuis le binaire ; codes `-32053/-32057` côté host (repris du code : commentaires + chemins d'erreur) ; N absolu d'agents ; spawn MSP ; `workflow/*` ; benchmarks/coûts ; formats d'index ; docs officielles ; framing au-delà de `split_lines` ; validation native de la posture d'autorisation globale (le sélecteur et l'UX sont maintenant câblés côté client) ; MCP/streaming/indexation Claude ; LICENSE ; transport OpenCode ; slash/CRDT/120 fps Zed.
