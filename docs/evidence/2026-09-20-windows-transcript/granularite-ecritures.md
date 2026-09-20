# Granularité réelle des écritures de journal (M1-13, 20 septembre 2026)

Complète `cout-ecriture-journal.md`, où j'avais chiffré le coût d'**un** ajout sans savoir **combien** un tour en produit. Le coût par tour y était donc un **calcul**, pas une observation. Il l'est maintenant.

## Protocole

```powershell
node scripts/cdp-stream-granularity.mjs
```

Le script enveloppe `localStorage.setItem` **dans la page**, au moment de l'exécution, et compte les écritures portant sur la clé du journal. **Aucun code de l'application n'est modifié.** Il envoie ensuite un vrai tour modèle (« Count slowly from one to thirty ») et échantillonne toutes les 4 s jusqu'à la fin du tour.

## Résultat

| Mesure | Valeur |
|---|---|
| **Écritures du journal** | **33** |
| **Volume total écrit** | **1 231 Ko** |
| Charge utile par écriture | **~37 Ko** (maximum 38 Ko) |
| Entrées du journal avant / après | 74 → **79** |
| Écritures **hors** journal | 17 |

Les 12 premières écritures font **toutes 37 Ko**, valeur constante.

### Répartition dans le temps

| Échantillon | Écritures | Ko écrits | `working` |
|---|---|---|---|
| 1 à 16 | **27** | 1 005 | oui |
| 17 (fin) | 33 | 1 231 | non |

Les 17 échantillons couvrent **plus d'une minute**. Le compteur reste à **27 écritures de l'échantillon 1 à l'échantillon 16** : les écritures sont **groupées au début du tour**, puis plus rien pendant que le tour continue. Six écritures supplémentaires surviennent à la fin.

## Ce que cela corrige dans mon raisonnement

**Le volume domine, pas la fréquence.** Le tour a écrit **1 231 Ko** alors que le journal ne pèse que **~9 Ko** (37 Ko de charge utile pour un journal de 74 entrées indique une sérialisation bien plus large que le seul contenu du journal — l'objet stocké est plus volumineux que les entrées que j'y ai comptées). Autrement dit, **plus d'**un mégaoctet écrit pour une réponse de trente nombres : chaque écriture réécrit **tout** le journal, et `appendLog` relit en plus avant d'écrire.

**Le coût par tour, désormais observé** : 33 écritures. En prenant le coût mesuré au round 41 (**1,15 ms** par ajout sur un journal à 2 000 entrées), cela donne **~38 ms** de persistance pour ce tour — négligeable pour l'utilisateur.

Le modèle « un ajout par token » que je redoutais est **démenti** : trente nombres n'ont pas produit trente écritures, et les écritures se concentrent au début plutôt que de suivre le stream.

## Conclusion

**Pas de problème de performance.** La persistance coûte quelques dizaines de millisecondes par tour, sur un total de **2,02 s** de `ScriptDuration` mesuré au round 22. Le coût de persistance est **marginal** en regard du coût de rendu.

Le point qui mérite un œil n'est pas le temps mais le **volume** : 1,2 Mo écrits par tour pour une petite réponse, parce que chaque écriture réécrit le journal entier. Avec des réponses longues et un journal au plafond, le volume croît, et c'est la **latence de stockage** — non mesurée ici — qui pourrait se faire sentir.

## Portée — limites

- **Un seul tour**, court (30 nombres). Une réponse longue produirait plus d'écritures et un volume supérieur ; je ne l'ai pas mesuré.
- Le compteur est **global à la page** : si une autre surface écrivait sur une clé `muse-desktop.log.v1.*`, elle serait comptée. Avec une seule session active, le risque est faible mais non nul.
- **La latence réelle de `setItem` n'est pas mesurée** : je compte les appels, pas leur durée. Le banc du round 41 mesure le coût en mémoire ; le coût dans WebView2 peut être supérieur.
- **Les 17 écritures « hors journal »** ne sont pas attribuées : je ne sais pas quelles clés elles touchent.
- **`working` reste vrai** après la fin apparente des écritures : je ne sais pas si le tour était terminé ou si le stream était simplement silencieux.
- Le ratio « 37 Ko pour 74 entrées » n'est **pas expliqué** ; je le signale comme observation sans conclure sur sa cause.
