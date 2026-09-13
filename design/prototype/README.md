# Muse-Desktop — maquette desktop

Ouvrir `index.html` directement, ou lancer `node ../serve.cjs`, puis consulter http://127.0.0.1:4174/prototype/.

Prototype autonome HTML/CSS/JavaScript, en français. Aucune compilation ou clé API. La police DM Sans est chargée depuis Google Fonts ; une police système prend le relais hors ligne.

## Parcours interactifs

- Tâche initiale complète : conversation, étapes, fichiers modifiés, diff, terminal et aperçu.
- Nouvelle tâche : suggestions, saisie, choix du modèle, mode Agent/Plan/Discussion et environnement Local/Worktree/Cloud.
- Réponse et autorisation simulées, arrêt, relance, pièce jointe (nom uniquement).
- Recherche Ctrl+K, nouvelle tâche Ctrl+N, variante de conversation, archivage et restauration.
- Commit simulé, sélection des fichiers, commandes terminal de démonstration.
- Création et modification d’automatisations, activation et désactivation.
- Catalogue d’extensions filtrable ; ajout et retrait locaux.
- Thèmes clair et sombre, navigation repliable.

Les tâches, automatisations, extensions et le thème sont conservés dans localStorage. Les conversations de suivi sont temporaires. Aucun moteur IA, Git, cloud, terminal réel ou planificateur n’est connecté. Les contrôles de permissions et de notifications illustrent l’UX. Cette maquette reprend les principaux parcours de Codex ; elle ne constitue pas une implémentation de sa totalité fonctionnelle.

## Direction visuelle et références

Bleu d’action Meta, blancs froids, gris ardoise, surfaces arrondies et typographie sans empattement. Variante sombre inspirée du site développeur. Logo fourni par l’utilisateur, conservé dans assets/muse-logo.png.

- https://ai.meta.com/muse/
- https://developer.meta.com/ai/products/muse-code/
- https://developers.openai.com/codex/app/features (redirige vers https://learn.chatgpt.com/docs/features)

Références consultées le 13 septembre 2026. Les contenus du projet Atelier, résultats des tests et diffs sont des exemples fictifs pour rendre les parcours explorables.
