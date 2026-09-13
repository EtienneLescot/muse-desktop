# Muse-Desktop · Design

Livrable UX/UI indépendant de l’application Tauri. Maquette interactive en français et design system partageant les mêmes tokens et styles de composants.

## Consulter

Depuis la racine du dépôt : `node design/serve.cjs`.

- Accueil : http://127.0.0.1:4174/
- Maquette : http://127.0.0.1:4174/prototype/
- Design system : http://127.0.0.1:4174/system/

Les pages peuvent aussi s’ouvrir directement depuis le système de fichiers. Aucun build, package npm ou secret n’est requis. DM Sans est chargée depuis Google Fonts, avec Arial en secours.

## Organisation

- `prototype/` : application HTML/CSS/JS et documentation des parcours.
- `system/tokens.css` : couleurs sémantiques clair/sombre, typographie, espacements et rayons.
- `system/index.html` : référence visuelle des composants, états et règles de composition.
- `assets/muse-logo.png` : logo original fourni par le commanditaire, transparence conservée.
- `serve.cjs` : serveur statique local, limité à ce dossier.

## Principes UX

Le logo et le profil sont ancrés dans la barre latérale ; seul son contenu central défile. Le bloc du profil ouvre les paramètres au clic et au clavier. Conversation et panneau de travail défilent indépendamment. Le compositeur reste accessible en bas. Scrollbars de 6 px, bleu doux au repos et bleu Muse au survol. Arrondis modérés de 8 à 16 px sur les surfaces.

La maquette couvre les principaux parcours de tâches, revue, aperçu, terminal, automatisations et extensions. Les résultats IA, commandes, autorisations et commits sont simulés. Les choix d’environnement et de modèle ne connectent aucun service. Les tâches et préférences persistent dans localStorage ; les réponses de suivi sont temporaires. Aucune donnée de test issue du navigateur n’est livrée.

## Références

- https://ai.meta.com/muse/
- https://developer.meta.com/ai/products/muse-code/
- https://developers.openai.com/codex/app/features

Références consultées le 13 septembre 2026. Cette proposition n’est pas une spécification officielle Meta ou OpenAI ni une garantie de parité exhaustive avec Codex.
