# Où vivent réellement les conversations — découverte (20 septembre 2026)

Cette campagne a passé plusieurs rounds à essayer de supprimer des conversations de test, avec des résultats qui « ne tenaient pas ». La cause est ici, et elle n'était pas où je la cherchais.

## Le fait

`session/list` retourne, pour chaque session, son **chemin de stockage** :

```json
{
  "sessionId": "01a0bea1-cddc-7ca2-8c70-5fb41ed02df4",
  "path": "C:\\Users\\etien\\.local\\share\\muse\\sessions\\2026\\09\\20\\01a0bea1-…\\session.jsonl",
  "status": "notLoaded",
  "activeTurnId": null,
  "createdAt": "2026-09-20T11:44:30.172704Z",
  "updatedAt": "2026-09-20T18:55:11.525704Z",
  "workspaceRoot": "\\\\?\\G:\\repos\\openscreen",
  "providerId": "meta",
  "modelId": "muse-spark-1.3-contributor",
  "turnCount": 11,
  "forkedFrom": null,
  "title": "Enumerate the three Musketeers by name.",
  "firstUserPrompt": "Enumerate the three Musketeers by name.",
  "branch": "pr620"
}
```

**Les conversations sont des fichiers `session.jsonl` sur disque**, sous
`%USERPROFILE%\.local\share\muse\sessions\<année>\<mois>\<jour>\<sessionId>\session.jsonl`.

Le **host en est le propriétaire** ; l'application ne fait que les refléter. D'où le comportement observé pendant le nettoyage : supprimer une conversation dans l'application ne supprime pas le fichier, et l'entrée **revient** dès que l'application redemande `session/list`.

## Champs exposés par `session/list`

`sessionId`, `path`, `status`, `activeTurnId`, `createdAt`, `updatedAt`, `workspaceRoot`, `providerId`, `modelId`, `turnCount`, `forkedFrom`, `title`, `firstUserPrompt`, `branch`.

Sept de ces champs — `path`, `status`, `activeTurnId`, `turnCount`, `providerId`, `modelId`, `branch` — **n'étaient documentés nulle part** dans le dépôt avant cette mesure.

## Inventaire mesuré (18 sessions sur disque)

| Identifiant | Lignes | Taille | Origine |
|---|---|---|---|
| `01a0bb03` | **44 050** | **65 194 Ko** | campagne (le plus gros) |
| `01a0bea1` | 737 | 1 468 Ko | campagne |
| `01a0bead` | 384 | 645 Ko | campagne |
| `01a0bb00` | 116 | 298 Ko | campagne |
| `01a0beaf`, `01a0bec9` | ~165 | ~287 Ko | campagne |
| `01a0bead` (2ᵉ), `01a0bf02` | ~110-164 | ~160-282 Ko | campagne |
| `01a0be8a` | 73 | 147 Ko | campagne |
| `01a0bafe` | 10 | 7 Ko | campagne |
| `cd820fec`, `4306ea8c`, `5b38de0b`, `611bba64` | 34-38 | 68-115 Ko | **identifiants d'une autre forme** |
| `803ede85`, `92015b53`, `f63e0cdb`, `72b8c035` | 34-52 | 61-93 Ko | idem |

**Onze sessions portent le préfixe `01a0…`** — la forme des identifiants générés pendant cette campagne. **Sept portent une forme différente** : elles ne viennent pas de ces tests, et je **ne les touche pas**.

Les sessions de campagne totalisent environ **70 Mo**, dont **65 Mo pour une seule**.

## Pourquoi cela change le diagnostic du nettoyage

Le document [`nettoyage-conversations.md`](../2026-09-20-windows-cleanup/nettoyage-conversations.md) concluait que le côté natif réintroduisait les sessions supprimées. **C'est exact, et voici le mécanisme précis** : le host relit ses propres fichiers `session.jsonl` et les re-liste ; l'application reconstruit une entrée locale pour chacune.

Le bouton **Delete…** de l'interface, lui, envoie l'ordre de **tuer la session** — ce qui explique qu'il fonctionne, au moins tant que le host est vivant. Mais **il ne supprime pas forcément le fichier** : `01a0bea1` figurait encore sur disque après avoir été supprimée côté application, avec **1 468 Ko** et 737 lignes.

## Ce qui reste à faire, et pourquoi je ne l'ai pas fait

Effacer des fichiers de `%USERPROFILE%\.local\share\muse\sessions\` **dépasse le périmètre de l'objectif** et touche au stockage partagé avec Muse CLI : c'est une décision qui vous revient, pas à moi.

**Ce qui est sûr :** les 11 sessions au préfixe `01a0…` viennent de cette campagne de tests, et elles occupent ~70 Mo.

**Ce qui n'est pas sûr :** les 7 sessions à identifiant d'une autre forme. Elles pourraient être vos conversations Muse CLI, ou d'autres essais. Je n'y touche pas.

## Détail de protocole découvert au passage

**`session/start` exige un `commandId`** en plus de `workspaceRoot`. Sans lui :

```
invalid session/start params: missing field `commandId`  [invalidParams]
```

Le rapport d'écart ne le mentionnait pas — il listait `workspaceRoot` mais pas `commandId`. À corriger dans [`SIDECAR-CONTRACT-GAPS.md`](../../SIDECAR-CONTRACT-GAPS.md) à la prochaine mise à jour.
