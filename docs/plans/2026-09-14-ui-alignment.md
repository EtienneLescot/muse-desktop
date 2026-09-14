# Alignement UX/UI sur le prototype

Base : `main` à `d0f784f`, récupérée par fetch et pull fast-forward.

## Implémentation

- Navigation principale compacte, logo et profil fixes, liste des tâches défilante, navigation repliable.
- Pages Projets, Automatisations, Extensions, Bibliothèque, Archives et Paramètres : les composants existants et leurs callbacks sont conservés hors de la barre latérale.
- Recherche locale dans les titres et dossiers, dialogue natif, Ctrl/Cmd+K ; nouvelle tâche via Ctrl/Cmd+N.
- Accueil avec suggestions, choix du dossier et brouillon transmis au compositeur après création. Le brouillon n’est pas envoyé automatiquement.
- Conversation et panneau de travail indépendants ; onglets fichiers/artefacts, navigateur, mémoire, activité. Les contrôles de compaction, partage, orchestration et canaux restent accessibles dans Activité.
- Compositeur ancré ; mentions résolues dans le dossier de la session active, pas dans le dossier par défaut des futures sessions.
- Typographie, arrondis, logo et scrollbars Muse ; thèmes clair/sombre conservés.
- Affichage sûr de paragraphes, listes, emphase, code inline et blocs de code, y compris un bloc encore en streaming. Aucun HTML interprété.
- Protection de la restauration de l’historique : les effets de persistance attendent l’hydratation pour ne pas écrire une liste vide lors du double montage React StrictMode.

## Vérification

- `npm run build` : TypeScript et Vite réussis. Avertissement préexistant sur le mélange d’imports statiques/dynamiques de l’API Tauri.
- `npm test` : 346 tests réussis, dont 3 nouveaux tests de découpage des messages (bloc complet, streaming, contenu HTML littéral).
- Navigateur : accueil, clair/sombre, conversation avec fixture locale temporaire, restauration après rechargement, paramètres depuis le profil, recherche et sélection, page Automatisations.
- Inspection visuelle au format 1145 × 856 des captures de référence. Les fichiers de fixture ne sont pas livrés.

## Limites conservées

Le backend Tauri/Muse n’a pas été exercé pendant cette vérification web. Aucune simulation n’a été introduite dans les appels de production. Le panneau présente les artefacts réellement disponibles ; les diffs Git, commits et le terminal fictifs de la maquette ne sont pas présentés comme des capacités branchées. Les limites backend documentées dans la roadmap restent applicables. Le rendu de messages couvre les éléments usuels indiqués ci-dessus, pas la totalité de CommonMark.
