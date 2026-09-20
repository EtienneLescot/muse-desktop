# Composition IME — Entrée ne soumet pas (M0-03, 20 septembre 2026)

Dernier critère de M0-03 : « IME ». J'avais annoncé au round précédent ne pas pouvoir le tester ; **c'était prématuré**. CDP expose `Input.imeSetComposition`, qui pilote une vraie composition.

## Le risque réel, et pourquoi ce n'est pas « perdre du texte »

Avec un IME, **Entrée valide le candidat, elle ne soumet pas le message**. Le danger n'est donc pas la perte de texte mais l'**envoi prématuré** : l'utilisateur tape « にほんご », appuie sur Entrée pour choisir « 日本語 », et le message part avec le texte en cours de composition — ou pire, vide.

C'est ce scénario qui a été testé.

## Protocole

```powershell
node scripts/cdp-ime-compose.mjs
```

Le script installe des écouteurs réels sur `compositionstart`, `compositionupdate` et `compositionend` du compositeur — pour **observer** les événements, pas les supposer — puis :

1. compose `にほんご` en hiragana via `Input.imeSetComposition` ;
2. **appuie sur Entrée pendant que la composition est active** ;
3. valide la composition en `日本語` via `Input.insertText` ;
4. envoie pour de bon, et vérifie ce qui part.

## Résultat

| Étape | Composer | Entrées du journal | Événements observés |
|---|---|---|---|
| opened | `日本語` *(résidu d'une sonde antérieure)* | 45 | — |
| composing-hiragana | `にほんご日本語` | 45 | `compositionstart`, `compositionupdate(にほんご)` |
| **Entrée pendant la composition** | **`にほんご日本語` — inchangé** | **45 — inchangé** | idem |
| after-commit | `日本語日本語` | 45 | `+ compositionupdate(日本語)`, **`compositionend(日本語)`** |
| envoi réel | **vidé** | **48** | — |

### Établi

- **Les événements de composition arrivent réellement** : `compositionstart`, deux `compositionupdate` et un `compositionend` ont été observés par des écouteurs posés sur l'élément. Ce n'est pas une simulation d'événements synthétiques — c'est le chemin de composition du moteur.
- **Entrée pendant une composition n'envoie pas le message.** Le compteur d'entrées reste à **45** et le composer est **inchangé** : l'application n'a pas confondu la validation du candidat avec une soumission. C'est le comportement correct et c'est **le risque principal de l'IME**.
- **La composition committée est bien le texte conservé** : après `compositionend`, le composer contient `日本語` — le texte japonais n'est ni tronqué ni corrompu.
- **L'envoi réel fonctionne ensuite** : composer vidé, journal 45 → 48.

### Un détail à ne pas surinterpréter

Le journal contient `日本語日本語` (doublé) parce que le composer portait déjà `日本語` **au début du test** — résidu de ma sonde de vérification de `Input.imeSetComposition` lancée juste avant, qui avait laissé du texte sans l'envoyer. Ce n'est pas un défaut de l'application : c'est mon état de départ qui n'était pas propre. Le marqueur n'apparaît qu'**une fois** dans le journal, avec le rôle `user`.

## Portée et limites

- Une **seule composition**, en japonais via hiragana → kanji. Le chinois, le coréen et les IME à plusieurs étapes de candidats ne sont pas exercés.
- **Aucun IME système réel** n'a été piloté : `Input.imeSetComposition` reproduit le protocole de composition du moteur, pas le comportement d'un IME installé sur la machine. Les deux devraient coïncider puisque les événements sont les mêmes, mais je ne l'ai pas vérifié.
- La **saisie au clavier physique pendant une composition** (touches de contrôle, Échap pour annuler une composition) n'est pas exercée.
- Un état de départ non propre a faussé la lecture du texte envoyé ; le protocole devrait vider le composer avant de commencer.

## État de M0-03

| Critère | État | Livrable |
|---|---|---|
| Ne perdre aucun texte lors d'un envoi rejeté | **prouvé** | #177 |
| Double-clic → un seul tour | **prouvé** | #178 |
| Fermeture / rechargement | **prouvé** (2 scénarios) | #179 |
| IME | **prouvé** — Entrée ne soumet pas pendant une composition | ce document |

**Les quatre critères listés par le ticket disposent désormais de mesures natives.** M0-03 n'est pas déclaré clos pour autant : chaque critère est couvert sur **un** scénario, pas sur l'ensemble de ses variantes — IME partiels (coréen, chinois), rechargement avant acquittement, double clic à la souris. Les limites sont énumérées ci-dessus et dans les documents liés.
