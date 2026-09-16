# ADR 0001 — Utiliser GitHub CLI pour créer les pull requests

- **Statut :** accepté pour M1-04
- **Date :** 2026-09-16
- **Contexte :** Muse doit créer une pull request depuis le dépôt de la conversation sans copier de token dans le webview. Le moteur MSP ne fournit pas d’opération forge et l’application ne doit pas supposer un hébergeur ou une branche par défaut.

## Décision

Le backend Tauri appelle `gh pr create` comme processus séparé, dans le workspace résolu par `sessionId`. La commande reçoit toujours `--base`, `--head`, `--title` et `--body`. L’authentification est celle déjà configurée par l’utilisateur dans GitHub CLI ; aucune credential n’est lue, persistée ou transmise au frontend. La sortie doit contenir une URL HTTP(S), sinon l’action est considérée comme non vérifiée.

Le push reste une opération Git indépendante : remote et branche sont fournis explicitement et le refspec est `HEAD:refs/heads/<branch>`. Muse n’essaie jamais de merger automatiquement.

## Alternatives écartées

- **API GitHub directe :** nécessiterait une gestion de token, de scopes et de stockage sécurisé avant d’apporter un bénéfice dans la cible desktop actuelle.
- **Déduire remote/base/head :** risque de pousser vers une destination inattendue, surtout dans un dépôt multi-remote.
- **Shell via une chaîne concaténée :** interdit pour éviter injection de flags et perte de traçabilité ; chaque argument est transmis séparément au processus.

## Conséquences

La création de PR dépend de `gh` installé et authentifié ; l’absence de CLI, l’expiration de session, une PR déjà existante ou un rejet réseau sont affichés comme erreurs actionnables. La CI reste sans credential et couvre les validations locales ; un scénario live avec un dépôt de test doit compléter la qualification M1-04.
