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
- **Reste pour fermer M1-10 :** course rejouée avec deux tours correctement enfilés, restauration
  native de la file après redémarrage (`muse-desktop.queued-turns.v1`), et exécution en webview
  **empaquetée** (le run est en build dev).

## Reproductibilité

- Commit : scripts à inclure dans la série de qualification ; app `362c8bb`+ ; Windows 11 26200, WebView2.
- Commande : `node scripts/cdp-queue-race.mjs` ; sortie brute `cdp-queue-race-run2.json`.
