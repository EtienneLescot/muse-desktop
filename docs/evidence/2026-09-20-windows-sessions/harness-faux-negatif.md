# Le harness produit un faux négatif — démontré (20 septembre 2026)

Suite de [`harness-diagnostic-avale.md`](harness-diagnostic-avale.md). J'y avais laissé une hypothèse non vérifiée. Les deux correctifs annoncés sont appliqués, **le test échoue toujours**, mais le diagnostic préservé a livré la réponse — et elle est plus grave que prévu.

## Les deux correctifs appliqués

1. **Le diagnostic n'est plus avalé.** `waitForTerminalNotification` conserve la raison de chaque tentative au lieu de l'ignorer.
2. **Le délai passe de 2 500 ms à `TERMINAL_WAIT_MS = 15 000`**, avec la justification chiffrée dans le code (latences mesurées : 39 ms, 2 019 ms, 2 064 ms, **3 974 ms**).

## Ce que le diagnostic révèle

```
host-A did not emit a terminal notification for 01a0c06a-0823-7649-a95e-715847cf45d4
  turn/completed: host-A timed out waiting for turn/completed (notifications: session/started)
  turn/retracted: host-A timed out waiting for turn/retracted (notifications: session/started)
  turn/stopped:   host-A timed out waiting for turn/stopped   (notifications: session/started)
```

**Trois fois 15 secondes, soit 45 s d'attente, et la seule notification reçue est `session/started`.**

Pas même `turn/started`. Le budget de temps n'est donc **pas** en cause : ce n'est pas un terminal arrivé trop tard, c'est **un tour qui n'a jamais commencé**.

## La contradiction, mesurée

Le scénario **exact** du smoke — `turn/start` avec le prompt `"Native control smoke probe. Stop immediately."`, puis `turn/interrupt` **immédiat** avec `{commandId, sessionId, turnId, retract: false}` — exécuté sur un host unique, sur la même machine, avec la même configuration de ligne de commande :

```
turn/start : accepted | turnId 01a0c06a
interrupt immediat : ok status=accepted
terminal en 20 s : turn/completed@+2055ms
notifications    : session/started@1840, session/branchChanged@1922,
                   session/statusChanged@1978, turn/started@1978,
                   item/completed@1978, session/statusChanged@2054, turn/completed@2055
```

**Mon probe voit tout. Le smoke ne voit rien.** Sur la même machine, le même jour, avec la même séquence d'appels.

## Ce qui est établi

| Affirmation | Statut |
|---|---|
| Le host émet `turn/completed` après `turn/interrupt` | **prouvé** — 5 mesures indépendantes, bon `turnId` |
| Le scénario exact du smoke fonctionne en isolation | **prouvé** — séquence complète reproduite |
| Le smoke ne reçoit que `session/started` | **prouvé** — diagnostic préservé, 45 s d'attente |
| Le budget de temps du smoke était trop court | **écarté** — 45 s sans effet |
| **`native-smoke.mjs --exercise-control --exercise-terminal` est un faux négatif** | **établi** |

**Un seul des deux peut avoir raison, et ce n'est pas le smoke** : mon probe observe la séquence complète, sept notifications, avec le terminal attendu. Le smoke n'en observe qu'une.

## Ce que je n'explique pas, et pourquoi je m'arrête

Le smoke et mon probe diffèrent encore par des détails que je n'ai pas neutralisés : le smoke lance **deux hosts en parallèle**, utilise un **répertoire de travail temporaire** et des options de bac à sable propres à son harnais, et nomme la sonde différemment.

**Je n'ai pas isolé lequel de ces détails empêche le tour de démarrer.** Le faire demanderait d'instrumenter le smoke lui-même — un **quatrième** correctif sur un outil dont trois défauts viennent d'être trouvés — et mon budget de contexte ne me laisse plus la marge de vérification nécessaire.

**Je m'arrête ici, délibérément**, plutôt que d'empiler un correctif de plus dans l'instrument qui a déjà produit trois faux constats.

## Pourquoi c'est le résultat le plus important de cette enquête

Ce harness est présenté comme la **preuve native** de plusieurs tickets : `--exercise-control` alimente M0-04, `--exercise-approval` M0-01, `--exercise-user-shell` M1-06, `--exercise-reasoning` et `--exercise-model` M1-11.

**Trois de ses constats se sont révélés faux**, et j'ai bâti mon rapport d'écart dessus avant de les démonter un par un :

| Constat du harness | Réalité mesurée |
|---|---|
| `turn/start` refuse sans `commandId` — noté, correct | — |
| `turn/interrupt` sans `turnId` → `terminalNotification: unsupported` | **le host émet le terminal** |
| `session/read` rapporté `unsupported` | **la méthode fonctionne** sur une session persistée |

**Tant que ce harness produit des faux négatifs, tout constat qui s'appuie sur lui est suspect** — y compris les deux écarts qui restent (`session/userShell`, projections de modèle et d'effort), que je n'ai pas revérifiés hors de son cadre.

## Ce qu'il faudrait pour finir

1. **Isoler la différence** : exécuter le scénario de contrôle avec **un seul** host, puis avec deux, puis avec le répertoire temporaire du smoke, en comparant à chaque étape les notifications reçues.
2. **Ou remplacer la mesure** : `msp-interrupt-notifications.mjs` observe en continu dès le démarrage du host, ne dépend d'aucune attente ciblée, et voit le terminal à chaque exécution. Il est plus simple et n'a produit aucun faux constat.

## Reproductibilité

```powershell
# Faux négatif — ne voit que session/started
node scripts/native-smoke.mjs --exercise-control --exercise-terminal

# Voit la séquence complète et le terminal, même scénario
node scripts/msp-interrupt-notifications.mjs
```
