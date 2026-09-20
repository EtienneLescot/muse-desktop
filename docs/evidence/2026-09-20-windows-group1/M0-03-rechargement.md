# Rechargement en cours d'envoi — rien n'est perdu (M0-03, 20 septembre 2026)

Dernier critère accessible de M0-03 : « fermeture / rechargement ».

## Protocole

```powershell
node scripts/cdp-reload-mid-send.mjs
```

Deux scénarios dans le même passage, avec l'identité de conversation relevée à chaque étape :

1. **Brouillon non envoyé** → rechargement complet de la webview → le texte doit survivre.
2. **Envoi en cours** → rechargement pendant le tour → ni perte ni duplication.

## Résultat

### 1. Un brouillon non envoyé survit au rechargement

| Étape | Composer contient le marqueur | Marqueur dans le journal | Entrées |
|---|---|---|---|
| typed-draft | **oui** | 0 | 38 |
| **after-reload-draft** | **oui** | 0 | 38 |

Le marqueur est **toujours dans le compositeur** après un `location.reload()` complet. Le journal n'a pas bougé — normal, rien n'a été envoyé.

**Où vit le brouillon :** `sessionStorage` contient
`muse-desktop.draft.01a0bea1-cddc-7ca2-8c70-5fb41ed02df4` — soit **une clé par conversation**, ce qui évite qu'un brouillon se retrouve dans le mauvais fil.

### 2. Un envoi en cours ne se duplique pas

| Étape | Marqueur dans le journal | Identifiants distincts | Entrées | Travail |
|---|---|---|---|---|
| sent | 1 | 1 | 41 | oui |
| **after-reload-mid-send** | **1** | **1** | 44 | oui |

**Occurrences du marqueur : 1. Identifiants client distincts : 1.** Le rechargement pendant le tour n'a produit **aucun second envoi**.

Les entrées passent de 41 à 44 : le tour **continue** après le rechargement (le host est un processus séparé, que le rechargement de la webview n'affecte pas) et le transcript se complète. Aucune entrée d'outbox n'a été créée à aucun moment — cohérent, l'envoi avait été acquitté avant le rechargement.

## Établi

- **Le travail de l'utilisateur n'est jamais perdu** : un brouillon non envoyé survit à un rechargement complet, avec une clé `sessionStorage` par conversation.
- **Un envoi ne se duplique pas** au rechargement : un seul identifiant client, une seule occurrence dans le journal.
- **Le tour survit au rechargement de la webview** : le host étant un processus séparé, le transcript continue de se remplir.

## Portée et limites

- Le scénario testé est un **rechargement de la webview** (`location.reload()`), pas une **fermeture de l'application**. Une fermeture tue le host et relève d'une autre question — celle de la reprise, traitée dans `README.md` de cette campagne et bloquée par le contrat du sidecar (`session/read` / `session/resume` absents).
- **Un seul cas de « envoi en cours »** : le rechargement est survenu ~1,2 s après la soumission, donc après l'acquittement. Le cas où le rechargement tombe **avant** l'acquittement — celui où l'outbox devrait basculer en `failed` ambigu — n'a **pas** été exercé, faute d'une fenêtre de temps fiable pour le viser.
- L'**IME** reste non exercé.

## État de M0-03

| Critère | État |
|---|---|
| Ne perdre aucun texte lors d'un envoi rejeté | **prouvé** (`M0-03-envoi-rejete.md`) |
| Double-clic → un seul tour | **prouvé** (`M0-03-double-envoi.md`) |
| Fermeture / rechargement | **prouvé** pour ces deux scénarios (ce document) |
| IME | non exercé |

**M0-03 n'est pas clos** — l'IME manque, et le cas « rechargement avant acquittement » n'est pas couvert. Mais **trois de ses quatre critères** disposent désormais de mesures natives et reproductibles, et ce sont les trois qui portent sur la perte et la duplication de travail.
