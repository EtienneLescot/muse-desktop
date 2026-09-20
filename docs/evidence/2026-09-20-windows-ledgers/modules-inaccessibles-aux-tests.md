# Deux modules hors d'atteinte des tests — corrigé (M3-07 / M3-09, 20 septembre 2026)

En cherchant un dernier trou de vérification, j'ai trouvé un défaut de **testabilité** qui touchait du code de production.

## La mesure

J'ai essayé d'**importer** chacun des 92 modules de `src/lib` depuis un processus node, comme le fait un test :

| Résultat | Nombre |
|---|---|
| Importables | **90** |
| **Inimportables** | **2** — `notificationLedger.ts`, `scheduleRunLedger.ts` |
| Erreur | `ERR_MODULE_NOT_FOUND` |

## La cause, et une correction de mon propre diagnostic

Ces deux modules importaient des **valeurs** sans extension :

```ts
import { isTauriRuntime } from "./env";                    // casse
import { createLatestWriteQueue } from "./writeQueue";     // casse
```

Node ESM exige l'extension, même avec `--experimental-strip-types`.

**Je me suis d'abord trompé** : en scannant les imports sans extension, j'ai listé **15 modules** comme « inimportables ». C'était faux. La plupart de ces imports sont des **`import type`**, que le strip de types **efface** — `compact.ts` et `phase.ts` n'importent ainsi que des types et passent leurs tests sans problème. Seule la tentative d'import réelle donne la bonne réponse : **2 modules**, pas 15.

## Pourquoi cela compte

Les deux modules concernés ne sont pas du code mort : `useMuseSessions.ts` les utilise en production (imports aux lignes 296 et 341-343, files d'écriture aux lignes 1673 et 1684, chargement aux lignes 2406 et 2431). Ils forment le **miroir natif** de la boîte de notifications (M3-09) et du registre des exécutions planifiées (M3-07).

Ils étaient donc **rigoureusement hors d'atteinte de tout test** : aucun fichier de test ne pouvait les importer.

## La correction

Ajout de l'extension aux **imports de valeur** des deux fichiers. `tsc --noEmit` et Vite l'acceptent (vérifié : build **exit 0**).

## Le test ajouté

`test/notificationLedger.test.ts` — 8 tests qui restent du côté de la frontière qu'un processus node peut atteindre :

| Test | Ce qu'il verrouille |
|---|---|
| schéma déclaré | la constante écrite dans le payload natif |
| inerte hors webview Tauri | les deux directions refusent au lieu d'importer l'API Tauri |
| inerte sans `window` | le garde ne lève pas dans un worker |
| IPC injoignable | retourne `null` / `false` au lieu de lever |
| **ne rejette jamais** | 5 entrées absurdes → `null` / `false`, sans exception |
| file synchrone | l'appel de mise en file ne renvoie pas de promesse |
| **fusion des écritures** | une écriture en vol absorbe les suivantes, le dernier état gagne |
| écriture en échec | la file **continue** après un rejet, elle ne se bloque pas |

## Une deuxième erreur de ma part

Mon premier test de file affirmait que **chaque** mise en file atteint l'écrivain. Il a **échoué** (1 écriture vue au lieu de 3) — et c'est **le test qui était faux**.

`createLatestWriteQueue` est une file de **dernière écriture** : les états intermédiaires sont **délibérément fusionnés** pendant qu'une écriture est en vol, pour que le miroir natif ne se pose jamais sur une valeur périmée. Le nom le dit. J'ai réécrit l'assertion pour décrire le vrai contrat — une écriture démarre, les suivantes sont fusionnées, la dernière gagne — et elle passe.

C'est exactement ce que la mesure apporte : sans ce test, j'aurais pu « corriger » un comportement correct.

## Résultat

| Mesure | Avant | Après |
|---|---|---|
| Modules `src/lib` importables par un test | 90 / 92 | **92 / 92** |
| Tests | 958 | **966** |
| Build | vert | vert |

## Limites

- L'**appel IPC réel** n'est pas exercé : un processus node ne peut pas atteindre `invoke`. Ce qui est testé est le garde de runtime, le contrat d'échec et l'ordonnancement.
- `scheduleRunLedger.ts` est devenu **importable** mais **n'a pas encore de test** — c'est le prochain candidat évident, son contrat étant parallèle à celui de `notificationLedger`.
- Le test « IPC injoignable » dépend de l'**absence** du paquet Tauri dans `node_modules` pour un test node ; s'il devenait résolvable, le test changerait de sens sans échouer.
- Aucune vérification que le miroir natif **écrit réellement** de façon durable dans l'application empaquetée.
