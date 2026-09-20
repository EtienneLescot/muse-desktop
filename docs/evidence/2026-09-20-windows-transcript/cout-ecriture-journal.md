# Coût d'écriture du journal — mesuré (M1-13, 20 septembre 2026)

Mesure d'une piste que j'avais identifiée sans la chiffrer : **`appendLog` relit et réécrit tout le journal** à chaque ajout.

```ts
export function appendLog(sessionId: string, entries: LogEntry[]): void {
  if (entries.length === 0) return;
  const cur = loadLog(sessionId);                          // relit TOUT
  write(logKey(sessionId), [...cur, ...entries].slice(-MAX_LOG_ENTRIES));  // réécrit TOUT
}
```

## Protocole

```powershell
node --experimental-strip-types scripts/bench-log-append.mts
```

Le banc importe les **vraies** fonctions `appendLog` / `saveLog` / `loadLog` de `src/lib/persist.ts` et les exerce contre un `localStorage` en mémoire. Il amorce un journal d'une taille donnée, puis mesure **60 ajouts d'une entrée**, après un ajout de chauffe.

## Résultat — trois passes

| Taille du journal | Passe 1 | Passe 2 | Passe 3 | ×base | Stockage |
|---|---|---|---|---|---|
| **100** | 0,101 ms | 0,109 ms | 0,113 ms | 1,0 | 19 Ko |
| **500** | 0,294 ms | 0,311 ms | 0,305 ms | 2,8 | 68 Ko |
| **1000** | 0,583 ms | 0,579 ms | 0,604 ms | 5,5 | 129 Ko |
| **2000** | **1,154 ms** | **1,187 ms** | **1,208 ms** | **11,0** | 246 Ko |

**La croissance est linéaire, pas quadratique.** ×20 de taille (100 → 2000) donne ×11 de coût par ajout. Les trois passes concordent à moins de 5 %.

Le coût est donc proportionnel à la taille du journal, et le coût **total** d'un tour l'est aussi : `O(taille × nombre_d_ajouts)`.

## Ce que cela représente pour un tour réel

En prenant **1,15 ms** par ajout sur un journal à 2 000 entrées :

| Granularité d'ajout | Coût d'écriture du tour |
|---|---|
| 100 ajouts | ~0,12 s |
| **500 ajouts** | **~0,58 s** |
| 2 000 ajouts | ~2,3 s |

**Mise en regard avec une mesure indépendante** : au round 22, j'ai mesuré sur l'application réelle une `ScriptDuration` de **2,02 s** pour afficher un journal de 2 001 entrées. Le coût d'écriture calculé ici pour 500 ajouts (~0,58 s) se situe dans le même ordre de grandeur que cette dépense de script — donc **non négligeable**, mais pas dominant.

## Conclusion

**Il n'y a pas de défaut.** La réécriture complète est un choix coûteux mais de complexité linéaire, et le plafond `MAX_LOG_ENTRIES` la borne : au maximum du plafond, un ajout coûte **environ 1,2 ms**. Pour un usage normal, c'est acceptable.

Le seul cas qui mériterait attention est une **granularité d'ajout très élevée** — si le stream découpait la réponse en milliers d'ajouts, le coût d'écriture approcherait 2 secondes par tour, ce qui deviendrait perceptible. Je n'ai pas mesuré la granularité réelle du stream dans l'application.

## Portée — ce que cette mesure ne dit pas

- **Mesure en processus node**, contre un `localStorage` en mémoire. Le coût réel dans WebView2 — sérialisation vers le stockage du moteur, écriture disque — est **probablement supérieur**, et je ne l'ai **pas** mesuré. Les chiffres ci-dessus sont une **borne inférieure**.
- **Aucune mesure de la granularité réelle** : je ne sais pas combien d'ajouts produit un tour typique dans l'application. Le tableau « pour un tour réel » est un calcul, pas une observation.
- Les valeurs de journal sont des entrées **synthétiques** de longueur plausible (~70 caractères). Un journal de messages très longs coûterait plus, puisque le coût suit le nombre d'**octets** sérialisés, pas seulement le nombre d'entrées (confirmé : 2000 entrées ≈ 246 Ko).
- **Aucune alternative implémentée ni évaluée** : je n'ai pas testé s'il serait moins coûteux de conserver le journal en mémoire et de l'écrire par lots. Le fait qu'un coût soit acceptable ne dit pas qu'il soit optimal.
- Trois passes sur **une seule machine**, sans isolation du bruit système.
