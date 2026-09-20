# Envoi rejeté avec host vivant — prouvé (M0-03, 20 septembre 2026)

Remplace `M0-03-envoi-rejete-inabouti.md`. Le critère qui manquait à M0-03 est désormais couvert, avec une cause de rejet **déterministe**.

## Pourquoi les tentatives précédentes échouaient

Deux raisons, les deux corrigées ici :

1. **Aucune cause de rejet provoquée.** Les essais précédents tuaient le host *pendant* l'envoi : la soumission était **acceptée** avant la mort, ce qui teste la survie à une panne, pas un rejet.
2. **Identité de conversation non vérifiée.** Un essai mesurait l'état d'une conversation différente de celle où le texte avait été saisi, produisant un résultat ininterprétable.

## La cause de rejet retenue

Une **commande de skill inconnue**. Le pipeline d'envoi valide les skills **avant** d'atteindre le harness et retourne `unknown skill /<nom>` (`src/hooks/useMuseSessions.ts`, appel `sendFailed` lorsque la skill est introuvable). Aucun comportement du host n'est en jeu : le résultat est **reproductible à volonté**.

```powershell
node scripts/cdp-unknown-skill-reject.mjs
```

## Résultat

L'identité de la conversation est relevée à **chaque** étape — `activeId` et titre affiché.

| Étape | `activeId` | Titre | Composer | Copie d'échec visible |
|---|---|---|---|---|
| opened | `01a0bea1-…` | *Enumerate the three Musketeers…* | vide | non |
| typed | **identique** | **identique** | `/definitelynotaskill this command names a skill that does not exist` | non |
| **submitted** | **identique** | **identique** | **texte conservé** | **oui** |
| after-10s | identique | identique | **texte conservé** | oui |

Extrait du corps de page après soumission : `…own skill /definitelynotaskill`. Le message d'erreur est **en anglais, borné, sans préfixe de protocole**.

**Établi — c'est le critère de M0-03 :**

- le texte **reste dans le composer** après un rejet, il n'est **pas** vidé ;
- **aucune entrée n'est créée dans l'outbox** (`outboxRows: 0`) — cohérent : un rejet local n'est pas un envoi en attente, il ne doit donc pas produire d'entrée « à réessayer » ;
- **aucune affordance `Retry` / `Discard` / `Resend` n'apparaît**, ce qui est cohérent avec l'absence d'entrée d'outbox : le texte est simplement toujours là, prêt à être corrigé ;
- l'erreur est **visible** et **explique la cause** (« unknown skill /definitelynotaskill ») ;
- la conversation n'est **pas** quittée, le compositeur reste **actif** (`disabled: false`) — l'utilisateur peut corriger et renvoyer.

C'est le comportement attendu : **le travail de l'utilisateur n'est jamais perdu**, et l'application ne prétend pas avoir envoyé.

## Distinction utile pour M0-03

Le ticket distingue deux situations, et les deux sont maintenant documentées :

| Situation | Comportement observé | Preuve |
|---|---|---|
| **Rejet** (le host est vivant, l'envoi est refusé) | texte conservé dans le composer, erreur explicite, pas d'entrée d'outbox | **ce document** |
| **Panne en cours d'envoi** (le host meurt) | envoi accepté puis interrompu ; texte déjà vidé, journal conservé | `README.md` de la campagne groupe 1 |
| **Aucun host** (envoi impossible) | texte conservé, envoi non tenté, hint inchangé | `README.md` de la campagne groupe 1 |

## Ce qui reste ouvert pour M0-03

Le ticket liste aussi : **double-clic**, **IME**, **fermeture/rechargement**. Aucun des trois n'est exercé ici. Le double-clic est le plus accessible — il suffirait de soumettre deux fois rapidement et de vérifier qu'un seul tour est admis.

**M0-03 n'est donc pas clos**, mais son critère central — « ne perdre aucun texte lors d'un envoi rejeté » — est désormais **prouvé par une reproduction déterministe**.
