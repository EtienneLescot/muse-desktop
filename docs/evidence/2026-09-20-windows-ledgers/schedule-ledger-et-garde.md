# Ledger des exécutions planifiées, et garde de testabilité (M3-07, 20 septembre 2026)

Suite de `modules-inaccessibles-aux-tests.md`, qui avait rendu `scheduleRunLedger.ts` importable sans le tester.

## 1. `scheduleRunLedger.ts` couvert

Contrat **parallèle** à `notificationLedger.ts`, avec une différence : ce module n'expose **pas** de file d'écriture — `useMuseSessions.ts` passe `saveNativeScheduleRuns` directement à `createLatestWriteQueue`.

```powershell
node --experimental-strip-types --test test/scheduleRunLedger.test.ts
```

| Test | Ce qu'il verrouille |
|---|---|
| schéma déclaré | la constante écrite dans le payload natif |
| inerte hors webview Tauri | les deux directions refusent au lieu d'importer l'API |
| inerte sans `window` | le garde ne lève pas dans un worker |
| IPC injoignable | **`null` en lecture, pas d'exception** |
| **ne rejette jamais** | 6 entrées absurdes (`undefined`, `null`, `[]`, chaîne, objet, `42`) → `null` / `false` |
| ordre du garde | le contrôle de runtime précède l'import de l'API Tauri |

Le test « IPC injoignable » verrouille le contrat que le **commentaire du module** énonce : un miroir illisible doit **replier** sur le ledger du renderer, et la prochaine écriture réussie répare le miroir. Cela veut dire `null`, jamais une exception.

## 2. Un garde pour que cela ne se reproduise pas

`test/moduleReachability.test.ts` **importe chaque module de `src/lib`** et échoue si l'un devient inatteignable.

C'est la bonne formulation : un simple scan des imports sans extension **sur-déclare** le problème, puisque les `import type` sont effacés par le strip de types et n'ont jamais gêné personne. Seule la tentative d'import réelle tranche.

**Efficacité vérifiée, pas supposée** : en créant un module temporaire `src/lib/tmp-unreachable.ts` avec `import { isTauriRuntime } from "./env";`, le garde **échoue** :

```
✖ tmp-unreachable.ts can be imported by a test
```

Après suppression : **93/93**.

## 3. Une erreur de ma part

Ma première version du garde échouait sur **92 modules** — tous. La cause n'était pas les modules mais une **ligne finale que j'avais ajoutée sans raison** :

```ts
assert.equal(pathToFileURL(url.pathname).pathname, url.pathname);
```

Elle est **tautologique** en apparence, et **fausse sur Windows** : `pathToFileURL("/C:/…").pathname` donne `//C:/…` alors que `url.pathname` donne `/C:/…`. Les imports réussissaient tous ; c'est mon assertion inutile qui les faisait tous paraître cassés. Ligne supprimée, import devenu inutile retiré.

C'est la deuxième fois dans cette campagne qu'une vérification que j'ajoute « pour être sûr » produit un faux négatif massif — après le faux positif sur l'indicateur de focus.

## Résultat

| Mesure | Avant ce round | Après |
|---|---|---|
| Tests | 966 | **1065** |
| Modules `src/lib` sans test dédié | 2 | **0** |
| Garde contre la non-importabilité | aucun | **1 test par module** |

**1065 tests, 223 suites, 0 échec.** Build vert.

## Limites

- Les tests de `scheduleRunLedger` restent **du côté atteignable** par un processus node : garde de runtime, contrat d'échec, ordre des vérifications. L'**appel IPC réel** n'est pas exercé.
- Le garde de testabilité prouve qu'un module **s'importe**, pas qu'il **fonctionne** ni qu'il est testé — `env.ts` reste sans test dédié.
- Le garde **charge les 92 modules** à chaque exécution des tests : c'est rapide ici (quelques secondes) mais c'est un coût qui grandira avec `src/lib`.
- Un module qui importerait une **dépendance native** indisponible en node échouerait dans ce garde sans être réellement défectueux ; aucun cas de ce type aujourd'hui, mais le garde n'a pas de liste d'exceptions.
