# muse-desktop — Plan

## Goal
Créer une app desktop Windows/Mac avec frontend Tauri + React + Vite qui réutilise le backend/harnais Muse Code sans le réécrire : l'UI est un shell autour du CLI `muse` packagé en sidecar.

## Success Criteria
- L'app démarre sur Windows et Mac avec `muse` packagé en sidecar, sans dépendance PATH.
- Multi-sessions parallèles persistées : liste, création, switch, relance après restart avec historique restauré.
- Chaque session supporte prompts, stream, sous-agents visibles, demandes d'approbation Approve/Deny.
- Aucune logique agentique dupliquée côté Rust/frontend.
- Fermeture propre : pas de processus orphelin, pas d'écriture hors workspace.

## Context And Current Facts
- Backend/harnais conservé tel quel, piloté comme sous-processus.
- Choix actés utilisateur : React + Vite, sidecar packagé, sessions persistées, multi-sessions, sous-agents visibles, signature Win/Mac repoussée.
- Fonctionnement Muse actuel : CLI agentique, outils fichiers/shell/tests, sous-agents et workflows, permission on-request, sandbox on.

## Constraints And Non-goals
- Contraintes : Tauri, React + Vite, Windows + Mac, sidecar `muse` par plateforme, workspace-root verrouillé.
- Non-goals V1 : signature/notarisation, auto-update, support Linux, synchronisation cloud.

## Key Decisions
- Choix 1 — Sidecar Tauri pour `muse` : un binaire par target Win/Mac déclaré sidecar, invoqué par le Rust sans PATH. À valider contre doc Tauri pendant l'implémentation. Rejeté : PATH ou downloader externe, trop fragile.
- Choix 2 — Superviseur Rust mince : un enfant `muse` par session, cwd=workspace, kill à la fermeture, multiplexage par session_id.
- Choix 3 — Persistance locale : historique et métadonnées sessions en fichiers JSON ou SQLite local, relues au démarrage. Contenu exact du stream stocké en append-only.
- Choix 4 — Sous-agents : pas de contrôle séparé, le backend les orchestre ; l'UI affiche leur activité comme événements rattachés à la session parente.
- Choix 5 — IPC : commandes `start_session`, `restore_sessions`, `send_input`, `approve`, `cancel_session`, `kill_session` ; événements `output`, `subagent_event`, `tool_request`, `status`.

## Recommended Approach
Scaffold `muse-desktop/` Tauri + React + Vite. Rust gère sidecars, table des sessions actives, persistance et relais PTY vers events Tauri. React gère liste multi-sessions, vue conversation avec fils sous-agents, panneau approbation, restauration au boot via `restore_sessions`. Signature désactivée en dev, prévue hors V1.

## Work Plan
1. Scaffolding `muse-desktop/` : template Tauri + React + Vite, config Win/Mac, sidecar placeholder, sélecteur workspace.
2. Superviseur Rust multi-sessions : spawn sidecar par session_id, PTY/stdout, kill arbre, mapping session_id -> enfant.
3. Persistance : schéma session + messages/events, écriture append, `restore_sessions` au démarrage, suppression session.
4. IPC + hook React `useMuseSessions` : liste, active, stream par session, sous-agents rattachés, approbations.
5. UI React V1 : sidebar sessions, panneau conversation/stream avec blocs sous-agents repliables, panneau Approve/Deny, état running par session.
6. Packaging local non signé Win/Mac avec sidecars, erreur claire si sidecar manquant/incompatible.

## Validation Plan
- `npm run tauri dev` : créer 2 sessions parallèles, envoyer prompts distincts, vérifier streams non mélangés et blocs sous-agents affichés.
- Kill + relance app : vérifier restauration historique des 2 sessions via `restore_sessions`.
- Test approbation par session : commande shell dans session A bloquée jusqu'à Approve, session B reste utilisable, Deny annule sans effet.
- Vérifier aucun processus orphelin après fermeture via `ps`, aucune écriture hors workspace. Étape la plus risquée : multiplexage multi-sessions + persistance sans perte.

## Risks / Rollback
- Taille sidecars et matrix build Win/Mac lourde ; mitigation : un sidecar par arch, build local d'abord.
- Format sortie CLI instable pour distinguer sous-agents ; mitigation : relais texte brut taggé session_id, parsing enrichi ensuite.
- Persistance corrompue ou volumineuse ; mitigation : append-only + cap, session archivable/supprimable.
- Rollback : tout isolé dans `muse-desktop/`, suppression = retour à l'état actuel.

## Open Questions
- Aucune. Reste à valider les détails sidecar et events Tauri contre la doc officielle pendant l'implémentation.
