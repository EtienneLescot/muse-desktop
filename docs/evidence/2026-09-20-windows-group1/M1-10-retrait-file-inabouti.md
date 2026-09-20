# Retrait de la file — test inabouti (M1-10, 20 septembre 2026)

Tentative de couvrir le seul critère de M1-10 encore non mesuré : l'action **Remove from queue** retire-t-elle réellement un tour en attente ?

**Le test n'a rien produit, et l'échec vient de mon protocole.** Je le consigne plutôt que de le passer sous silence.

## Protocole prévu

1. ouvrir la conversation connue ;
2. envoyer un premier tour long, qui doit tourner ;
3. envoyer un second message, qui doit être **mis en file** faute de pouvoir démarrer ;
4. cliquer **Remove from queue** ;
5. vérifier que le tour disparaît de `muse-desktop.queued-turns.v1` **et** du panneau.

## Ce qui s'est passé

| Étape | File (`queued-turns.v1`) | Panneau | Bouton de retrait | `working` |
|---|---|---|---|---|
| opened | 0 | non | 0 | **non** |
| first-running | 0 | non | 0 | **non** |
| second-queued | 0 | non | 0 | **non** |
| after-removal | 0 | non | 0 | non |
| after-removal-settled | 0 | non | 0 | non |

`removal: {"clicked": false}` — le bouton n'a jamais existé, donc **rien n'a été mesuré**.

## Cause, établie par diagnostic après coup

Le diagnostic final montre :

- `working: false`, `connected: true`, compositeur **actif** ;
- le composer contenait **encore** `QUEUE-SECOND-8842 reply with j…` — soit **40 caractères** laissés en place, que j'ai nettoyés ensuite ;
- le compteur d'entrées était à **50**, donc le **premier** envoi avait bien été soumis (le composer s'était vidé).

Autrement dit : le premier envoi a fonctionné, le second message a été **saisi mais jamais soumis** — mon `Enter` n'a pas déclenché l'envoi à ce moment.

**Et surtout, je n'ai vérifié à aucune étape que le premier tour tournait réellement.** Sans cette vérification, impossible de savoir si l'état attendu (« le second envoi doit être mis en file ») était même atteignable : si le premier tour était déjà terminé, un second envoi démarre normalement et **rien n'est mis en file**.

C'est la **quatrième fois** dans cette campagne qu'un test échoue parce que je n'ai pas vérifié l'état de départ ou l'identité de la conversation avant d'agir. Les trois précédentes sont documentées : le mauvais cadrage de focus, la confusion sur l'ordre des entrées, et le sélecteur du conteneur au lieu de l'ouvreur.

## Ce que M1-10 a tout de même d'établi

Ces points viennent des campagnes précédentes et ne sont pas invalidés :

| Élément | Où |
|---|---|
| Admission en file : `disposition: queued` renvoyé par le host, persisté dans `muse-desktop.queued-turns.v1` | campagne groupe 1, round 3 |
| Panneau **Queued messages** ordonné, avec son action d'enlèvement visible | round 3 |
| État **`Stopping…`** puis bandeau « waiting for the desktop host to confirm it » | round 3 |
| File **vidée** après un Stop — le host consomme le tour en attente | round 3 |
| Base de code : `turn/unqueue` est déclaré côté client (`src/lib/msp.ts`) | lecture de source |

**Ce qui manque :** la preuve que l'action de retrait **supprime** effectivement l'entrée au lieu de seulement la masquer.

## Reprise — protocole corrigé

1. **Vérifier `working: true` après le premier envoi**, et attendre qu'il le devienne ; ne pas supposer qu'un tour long tourne parce qu'on l'a envoyé.
2. **Vérifier que le composer s'est vidé** après chaque envoi, signe que la soumission a été acceptée — c'est le contrôle qui manquait ici.
3. **Vérifier `queuedRows >= 1` avant de chercher le bouton**, au lieu de cliquer et de constater son absence.
4. Ne lancer la recherche du bouton **Remove from queue** que dans le panneau réellement déplié — je sais depuis le round 20 que les surfaces de la barre de travail n'existent pas quand le panneau est replié.

**M1-10 reste ouvert.** Aucune preuve nouvelle n'est apportée par ce round.
