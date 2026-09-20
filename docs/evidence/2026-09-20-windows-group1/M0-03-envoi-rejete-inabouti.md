# Envoi rejeté avec host vivant — non obtenu (M0-03, 20 septembre 2026)

Tentative de couvrir le critère de M0-03 qui n'avait jamais été prouvé : « rejet d'un envoi **avec** un host vivant », par opposition au cas sans host déjà mesuré.

**Le critère n'a pas été obtenu.** Je consigne les observations et la raison.

## Premier essai — tuer le host pendant l'envoi

Séquence mesurée : saisie de « Write a 400 word essay about the number seven. », soumission par `Enter`, puis mort de deux des trois hosts en cours de tour.

| Étape | Composer | Connecté | Travail | Entrées |
|---|---|---|---|---|
| before | vide | oui | non | 25 |
| typed | `Write a 400 word essay` | oui | non | 25 |
| **sent** | **vidé** | oui | **oui** | **28** |
| observe-1..3 | vide | oui | oui | 29 |
| observe-4..6 | vide | **non** | non | 30 |

**Ce que cela montre :** l'envoi a été **accepté avant** la mort du host — le brouillon s'est vidé et le journal a gagné 3 entrées. La mort est survenue **pendant le travail**, pas pendant l'envoi. Ce n'est donc pas un envoi rejeté.

**Comportement vérifié au passage :** la mort brutale du host n'a **pas** cassé le compositeur (il reste présent, devient désactivé), n'a **rien effacé** du journal (25 → 30 entrées conservées), et l'application est restée vivante.

## Second essai — tuer le host avant de soumettre

Séquence : saisir le texte **sans** soumettre, tuer le dernier host, puis tenter la soumission.

Après la mort du host, le composer était **vide et désactivé** (`composer: ""`, `disabled: true`, `disconnected: true`), et le rester après une tentative d'envoi par `Enter`.

**Je ne peux pas en tirer de conclusion sur M0-03**, pour une raison méthodologique : la session CDP ne garantit pas qu'on soit sur la **même conversation** que celle où le texte a été saisi. Le premier essai avait déjà changé la conversation affichée, et la saisie de la phase 1 a été faite sur un état dont je n'ai pas vérifié l'identité. Le composer vide peut donc simplement être celui d'une autre conversation.

## Ce qui reste établi

- **Mort du host pendant un envoi accepté** : aucun crash, compositeur présent mais désactivé, **journal intégralement conservé** (25 → 30 entrées), aucun faux succès affiché.
- **Aucune surface de rejet d'envoi n'a été observée** dans le DOM : ni bouton `Retry`, ni `Discard`, ni `Resend` à aucun moment de ces deux essais. Le code en prévoit pourtant (`outbox` avec états `sending`/`accepted`/`failed`), mais je n'ai pas réussi à provoquer l'état `failed`.

## Pour reprendre correctement

1. **Vérifier l'identité de la conversation** avant chaque phase (`muse-desktop.active.v1` et le titre affiché), pour garantir qu'on mesure bien la même session.
2. Provoquer un rejet **réel** : soumettre alors que le host est vivant mais que la commande est invalide, ou couper le lien juste après la soumission et avant l'acquittement — c'est la fenêtre où l'`outbox` doit basculer en `failed`.
3. Cibler explicitement les affordances `Retry`/`Discard` de l'`outbox` plutôt que de compter sur leur apparition.

**M0-03 reste ouvert** sur ce critère.
