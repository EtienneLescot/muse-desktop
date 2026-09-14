# Passe UX/UI — conversations

## Intention

Finir les parcours déjà disponibles avant d'élargir les capacités du moteur. Conserver l'identité Muse : surfaces sobres, bleu en accent, arrondis modérés, logo fourni. « Conversation » désigne l'échange avec Muse ; « automatisation » désigne une demande planifiée ; « projet » regroupe le contexte.

## Références consultées le 14 septembre 2026

- [Codex — commandes et raccourcis](https://learn.chatgpt.com/docs/reference/commands) : nouvelle conversation, navigation entre conversations, accès aux paramètres et réduction de la barre latérale. Application : Ctrl/Cmd+N, Ctrl+Tab, Ctrl/Cmd+, et Ctrl/Cmd+B ; Ctrl/Cmd+K ouvre la recherche locale.
- [Claude Code Desktop — gestion des sessions](https://code.claude.com/docs/en/desktop#manage-sessions) : conversations indépendantes, regroupement par projet, actions de gestion contextuelles. Application : brouillons séparés, groupes repliables, renommage et archivage accessibles depuis chaque conversation.

Ces références servent de conventions d'interaction, pas de promesse de parité fonctionnelle. Le navigateur pilotable, les vrais outils MCP et les worktrees automatiques restent hors de cette passe.

## Changements appliqués

- Vocabulaire « conversations » dans l'accueil, la navigation, la recherche, les archives, les projets et les automatisations.
- Lignes de conversation de hauteur stable ; actions accessibles au survol et au clavier. Renommage local persistant, archivage, suppression avec confirmation distincte.
- Groupes de projet repliables. Flèches haut/bas déplacent le focus ; Entrée ouvre la conversation.
- Recherche : flèches pour sélectionner, Entrée pour ouvrir, Échap pour fermer. Ctrl+Tab revient au parcours de conversation même depuis une page secondaire.
- Brouillons séparés par identifiant de conversation, conservés dans sessionStorage pendant la session de l'application, y compris après passage par les paramètres ou rechargement. Le brouillon de l'accueil est également conservé.
- Compositeur extensible jusqu'à 240 px ; saisie IME protégée contre l'envoi involontaire ; bouton pour retrouver les derniers messages après avoir remonté le fil.
- Panneau secondaire fermé à l'ouverture pour privilégier la conversation ; « Contenus » décrit les extraits disponibles, sans suggérer un explorateur de fichiers.
- Exports locaux libellés comme tels ; préférences d'isolation distinguées de l'isolation effective ; catalogue MCP présenté comme une configuration non connectée.
- Libellés français des principales actions de paramètres, projets, demandes d'information, sous-agents, exports et automatisations.
- Accueil plus compact, états de focus visibles, animations désactivées avec la préférence de réduction des mouvements. Logo et profil restent ancrés.

## Validation

- Build TypeScript/Vite et suite de 346 tests unitaires.
- Chromium avec historique synthétique isolé : renommage, annulation de suppression, recherche clavier, archivage/restauration, Ctrl+Tab depuis les archives, paramètres, thèmes et absence d'erreur JavaScript.
- Compositeur monté sous React StrictMode avec deux conversations : isolation des brouillons, retour après démontage, rechargement, saisie multiligne.
- Captures examinées en 1145×856 et accueil en 1280×720.

Les tests d'interface utilisent des données synthétiques et ne lancent pas de requête au moteur. Les fonctionnalités native/moteur n'ont pas été revalidées de bout en bout dans cette passe. Il subsiste des textes techniques émis par le moteur et certaines vues avancées ; il ne s'agit pas d'une certification d'accessibilité ni d'une traduction exhaustive de ces diagnostics.
