# Double envoi — un seul tour admis (M0-03, 20 septembre 2026)

Dernier critère accessible de M0-03 : « double-clic ». Vérifie qu'une double soumission rapide n'engendre **pas deux tours**.

## Protocole

```powershell
node scripts/cdp-double-send.mjs
```

Le script ouvre une conversation, saisit un marqueur unique (`DOUBLE-CLICK-PROBE-4187`), puis envoie **deux pressions d'`Enter` à 120 ms d'intervalle** — l'équivalent d'un double clic sur l'affordance d'envoi. L'identité de la conversation est relevée à chaque étape.

## Résultat

### À l'écran

| Étape | `activeId` | Entrées | Composer | Travail | Avertissement | Outbox |
|---|---|---|---|---|---|---|
| opened | `01a0bea1-…` | 32 | vide | non | non | 0 |
| after-double-enter | **identique** | 35 | **vidé** | **oui** | **non** | 0 |
| after-8s | identique | 36 | vidé | oui | non | 0 |

Une **seule** progression est visible (`working: true`, une seule bascule), le compositeur se vide **une fois**, et **aucun avertissement « already in progress »** n'apparaît.

### Dans le journal complet — la mesure qui tranche

L'observation à l'écran ne suffit pas : la fenêtre DOM ne monte que les 160 dernières entrées, donc un comptage sur le DOM peut manquer une occurrence plus haut. Le journal **complet** a donc été relu :

| Mesure | Valeur |
|---|---|
| Entrées du journal | 38 |
| **Occurrences du marqueur** | **1** |
| Rôles | `["user"]` |
| **Identifiants distincts** | **1** — `80270120-d64b-48e7-b…` |
| Entrées d'outbox | **0** |

**Établi :** deux `Enter` consécutifs produisent **un seul envoi**, avec **un seul identifiant client**. Le garde du pipeline (« a send is already in progress for this conversation ») fait son travail : la seconde soumission est écartée au lieu de créer un second tour.

C'est le comportement attendu : le module d'outbox documente que « un envoi logique ne peut jamais devenir deux tours acceptés », et la mesure le confirme côté journal — pas seulement côté affichage.

## Portée

- **Ce qui est prouvé :** deux soumissions rapprochées par le **clavier** (Entrée) n'admettent qu'un tour.
- **Ce qui ne l'est pas :** un double clic **à la souris** sur le bouton d'envoi. Le bouton est une icône sans libellé exploitable, et j'ai vérifié au round 20 qu'un clic mal ciblé atteint le mauvais élément. Le chemin clavier est le chemin documenté (« Enter to send ») et c'est celui qui a été mesuré.
- **Non exercés non plus :** l'IME et la fermeture/rechargement, les deux autres critères de M0-03.

## État de M0-03 après cette mesure

| Critère | État |
|---|---|
| Ne perdre aucun texte lors d'un envoi rejeté | **prouvé** (`M0-03-envoi-rejete.md`) |
| Double-clic → un seul tour | **prouvé** (ce document), par le clavier |
| IME | non exercé |
| Fermeture / rechargement | non exercé |

**M0-03 n'est pas clos** : deux critères restent. Mais ses deux critères de perte et de duplication — les plus importants pour l'utilisateur — sont désormais mesurés, avec des reproductions déterministes.
