# Plafonds de troncature — couverts (M1-13 / M0-12, 20 septembre 2026)

`src/lib/persist.ts` borne deux collections qui, par nature, ne le sont pas :

| Constante | Valeur | Points d'application |
|---|---|---|
| `MAX_LOG_ENTRIES` | **2000** | `loadLog`, `appendLog`, `saveLog` |
| `MAX_ALLOWLIST_RULES` | **200** | `loadAllowlist`, `saveAllowlist` |

**Aucune des deux n'avait de test.** Le risque est silencieux : un plafond cassé ne lève aucune erreur, il laisse l'historique croître sans limite.

## Pourquoi ces plafonds comptent, mesuré

Mon propre travail de performance (round 22, `M1-13.md`) a chiffré ce que coûte un journal non borné : sur **2 001 entrées**, la fenêtre du transcript monte **160 articles**, le DOM passe de 1 942 à 2 938 nœuds, `ScriptDuration` atteint **2,02 s** et le tas gagne 160 KiB. La borne `MAX_LOG_ENTRIES` est ce qui empêche la lenteur constatée de devenir non bornée.

Un plafond qui garderait les **anciennes** entrées au lieu des récentes serait tout aussi grave, et **invisible** : l'utilisateur verrait sa conversation récente disparaître en croyant à une troncature normale.

## Couverture

```powershell
node --experimental-strip-types --test test/persistCaps.test.ts
```

**Journal** — plafond respecté à l'ajout · **les plus anciennes sont retirées, pas les plus récentes** · pas de troncature à exactement 2000 · plafond tenu sur **ajouts successifs** (pas seulement dans un lot) · `loadLog` borné même quand le stockage contient déjà plus que le plafond (journal écrit par une version antérieure) · `saveLog` borné de la même façon.

**Allowlist** — plafond respecté à l'enregistrement · **les règles les plus récentes conservées** · `loadAllowlist` borné sur un stockage surchargé · liste sous le plafond **inchangée**.

## Efficacité vérifiée par mutation

| Mutation posée dans `src/lib/persist.ts` | Résultat |
|---|---|
| Troncature supprimée aux **3** points | **5 échecs** / 10 |
| `.slice(-MAX_LOG_ENTRIES)` → `.slice(0, MAX_LOG_ENTRIES)` | **3 échecs**, dont *« drops the OLDEST entries, not the newest »* avec `actual: 'entry-1999'` au lieu de `'expected: entry-2004'` |
| restauré | **10/10** |

La seconde mutation est celle qui compte : elle simule une troncature qui **fonctionne en apparence** mais conserve le mauvais côté de l'historique. Le test la nomme et affiche l'écart exact.

## Une erreur de ma part, corrigée

Ma première fixture d'entrée de journal n'avait que `role`, `text` et `ts` — **tous les tests de journal échouaient** (`0 !== 2000`). Cause : `isValidEntry` exige un **`id` de chaîne** en plus, et **filtre en silence** les entrées qui ne le satisfont pas. Les tests d'allowlist passaient, leurs règles étant complètes.

J'ai corrigé la fixture et documenté l'exigence dans le fichier de test, pour que la prochaine personne n'écrive pas la même chose. **C'est aussi une observation utile** : la validation à la lecture est stricte et silencieuse — une entrée sans `id` disparaît sans trace, ce qui mérite d'être connu.

## Suite complète

**958 tests, 219 suites, 958 passés, 0 échec** — contre 948 avant ce commit.

## Limites

- Tests **unitaires** : le comportement réel de `localStorage` dans WebView2 — quota, éviction, écriture partielle — n'est pas éprouvé.
- **Aucun test de performance** du plafond : je n'ai pas mesuré le coût d'écriture d'un journal de 2000 entrées à chaque ajout. Avec `appendLog` qui relit puis réécrit tout le journal, une entrée ajoutée à 2000 coûte une sérialisation complète — **ce coût n'est pas mesuré ici**, et c'est un candidat sérieux à une mesure future.
- Les plafonds sont vérifiés **tels que codés** : je n'ai pas évalué si 2000 et 200 sont les bonnes valeurs.
- Aucun test du comportement quand `localStorage.setItem` échoue (quota dépassé).
