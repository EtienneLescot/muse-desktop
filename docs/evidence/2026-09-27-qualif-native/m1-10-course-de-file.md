# M1-10 — Course de file : aucun tour supprimé ne démarre (27 septembre 2026)

**Critère clé de M1-10 prouvé en webview :** lors d'une course de suppression pendant qu'un
premier tour tourne, **aucun tour retiré de la file n'a jamais démarré** — ni accusé, ni sortie,
ni réponse.

## Protocole

```powershell
node scripts/cdp-queue-race.mjs
```

Le scénario enfile deux tours (`RACE-QUEUED-A-3311 say ALPHA`, `RACE-QUEUED-B-7722 say BETA`)
pendant qu'un premier tour long tourne, puis déclenche les suppressions **depuis le contexte de
page** (une seule évaluation — les allers-retours CDP ajoutent des dizaines de millisecondes et
rendent une vraie course impossible à viser).

Deux corrections de méthode ont été nécessaires avant de pouvoir jouer la course (run1 nulle :
le script visait une conversation « Enumerate the three Musketeers » inexistante et soumettait
par événements `Enter` synthétiques) :
1. conversation cible configurable (`MUSE_RACE_SESSION`, repli sur le titre par préfixe) ;
2. repli d'envoi sur le vrai bouton `button.send` quand le `Enter` synthétique n'a pas vidé le
   composer.

## Résultats (run2)

| Étape | Mesure |
|---|---|
| Premier tour en cours | ✓ (`working: true`) |
| Tours en file | ✓ file visible (panneau + boutons « Remove from queue ») |
| Après les suppressions en rafale | **file vidée** (`queuedRows: 0`, panneau fermé) |
| Tour A supprimé a-t-il démarré ? | **non** — `alphaAnswer: false`, aucun accusé |
| Tour B supprimé a-t-il démarré ? | **non** — `betaAnswer: false`, aucun accusé |
| Après la course | premier tour poursuivi normalement jusqu'à son terminal |

Le journal local de la conversation (`muse-desktop.log.v1.<active>`) conserve les entrées
utilisateur enfilées puis retirées — l'interface annonce honnêtement « …message was not sent. »
au lieu de faire semblant.

## Limites de la mesure (honnêteté)

- La mise en place du run2 était imparfaite : le second envoi n'est **pas** entré en file (texte
  resté dans le composer) et la première entrée s'est retrouvée **en double** dans la file. La
  course porte donc sur les suppressions effectives observées, pas sur deux tours distincts.
- **Cause trouvée le 27/09 au soir (harnais, pas l'app) :** `submit()` du script envoyait un Enter
  synthétique par `keydown`+`keyup` — deux soumissions quand les deux sont pris par les handlers
  React, zéro quand aucun n'est pris (d'où A dupliqué / B coincé). Corrigé : **clic du seul vrai
  bouton d'envoi** (`button.send`), sans clavier synthétique.

## Run4 — course propre, deux tours correctement enfilés (27 septembre 2026, harnais corrigé)

```
pre: premier tour en cours ok=True          (tour long « Count slowly… » réellement lancé)
step two-queued : queued=2  texts=["RACE-QUEUED-A-3311 say ALPHA","RACE-QUEUED-B-7722 say BETA"]
                  removeButtons=2  composer=0   (aucun doublon, composeur vidé)
step after-race : queued=0  removeButtons=0    (retrait en rafale pendant l'exécution)
step later      : queued=0  working=true       (+20 s : le premier tour tourne TOUJOURS)
                  raceAInLog=true raceBInLog=true   (trace « non envoyé » au journal, honnête)
```

**La course propre est jouée et le résultat est net :** deux tours distincts correctement enfilés,
retirés pendant l'exécution du premier — **aucun des deux n'a jamais démarré** (file vide dès le
retrait, premier tour seul jusqu'à +20 s et au-delà), et les deux textes retirés restent traçables
au journal local sans effet de bord. Le verdict `race` du rapport reste vide à cause du wrapper
`JSON.stringify` de `evaluate()` (les clics ont bien eu lieu — les états le prouvent) ; le
correctif de persistance du verdict est dans le script mais son retour n'était pas nécessaire à la
conclusion.

**Reste pour fermer M1-10 :** restauration native de la file après redémarrage
(`muse-desktop.queued-turns.v1`), et exécution en webview **empaquetée** (le run est en build dev).

## Reproductibilité

- Commit : scripts à inclure dans la série de qualification ; app `362c8bb`+ ; Windows 11 26200, WebView2.
- Commande : `node scripts/cdp-queue-race.mjs` ; sortie brute `cdp-queue-race-run2.json` (limite
  ci-dessus) et `cdp-queue-race-run4.json` (course propre).
