# Le plafond d'approbation n'existe pas — le dernier constat tombe (20 septembre 2026)

**Ce document corrige la dernière affirmation non remesurée de [`SIDECAR-CONTRACT-GAPS.md`](../../SIDECAR-CONTRACT-GAPS.md)**, et ferme l'enquête. Le rapport présentait un plafond `promptUnmatched` comme la seule limite encore debout du sidecar.

**Elle n'existe pas.**

## La méthode

`session/read` expose `approvalMode` sur la session — découverte du round 61, non exploitée jusqu'ici. Elle permet de **lire** le mode effectif après chaque tentative, au lieu de se fier à l'accusé.

Le script essaie quatre noms de méthode plausibles, puis balaie huit valeurs de mode, en **relisant la session** après chacune.

## Le résultat

**Une seule méthode existe :** `session/setApprovalMode`. Les trois autres (`session/setApproval`, `session/approvalMode`, `approval/setMode`) répondent `methodNotFound` — et la session reste inchangée, ce qui confirme qu'elles ne font rien.

**Trois valeurs sont acceptées :**

| Mode | Résultat | Mode effectif après |
|---|---|---|
| `onRequest` | **accepté** | `onRequest` |
| **`allowAll`** | **accepté** | **`allowAll`** |
| `promptUnmatched` | **accepté** | `promptUnmatched` |
| `auto`, `yolo`, `never`, `ask`, `deny` | refusés en `invalidParams` | inchangé |

Les cinq refus sont **mes propres noms inventés** — `auto`, `yolo`, `never` ne font pas partie du vocabulaire du host. **Ils ne prouvent aucune limite.**

## Ce que le host expose réellement

L'accusé est complet :

```json
{ "status": "accepted",
  "applyOutcome": "completed",
  "effectiveMode": { "mode": "allowAll", "source": "approvalReconfigure", … } }
```

Et la session relue confirme :

```
before : { "mode": "onRequest",  "source": "startup",              "lastCommandId": null }
after  : { "mode": "allowAll",   "source": "approvalReconfigure",  "lastCommandId": "<le commandId envoyé>" }
```

Avec, en plus, une notification **`session/approvalModeChanged`**.

**Le mode est configurable, appliqué, projeté sur la session, et signalé par notification.** Il n'y a **aucun plafond**.

## La cause de mon erreur

Le constat d'origine venait de `native-smoke.mjs`, sur un scénario où une **demande d'approbation** n'était jamais apparue — en mode `ask`, un mode qui **n'existe pas**. J'en avais déduit un plafond du host, alors que c'était mon scénario qui ne sollicitait rien.

C'est **exactement** la même erreur que les cinq écarts précédents : une erreur de contexte lue comme une absence de capacité.

## Bilan définitif : six constats, six artefacts

| Constat | Affirmé | Mesuré |
|---|---|---|
| 1 | `session/read`, `session/resume` absents | **fonctionnels** |
| 2 | aucun terminal après interruption | **`turn/completed` émis** |
| 3 | `userShell` sans item ni sortie | **item publié, sortie incluse** |
| 4 | projections non rapportées | **visibles (session + notification)** |
| 5 | durabilité constamment `ephemeral` | **variable** |
| 6 | plafond `approval_mode` à `promptUnmatched` | **inexistant** — trois modes acceptés |

**Aucun écart de contrat du sidecar n'est établi.** Le host 1.3.0 fait tout ce que je lui reprochais de ne pas faire.

## Ce que cela change pour les tickets du groupe 1

| Ticket | Ce que je croyais | Mesuré |
|---|---|---|
| **M0-01** — approbations simultanées | bloqué par le plafond du host | **pas de plafond** — `allowAll` est accepté |
| **M0-02** — reprise | bloqué par le sidecar | **le host sait reprendre** |
| **M0-04** — arrêt fiable | bloqué par l'absence de terminal | **le terminal est émis** |
| **M0-06** — posture de permissions | limité par le plafond | **pas de plafond** |
| **M1-06** — sortie terminal | bloqué par le sidecar | **l'item et la sortie existent** |
| **M1-11** — modèle et effort | bloqué par l'absence de projection | **les projections existent** |

**Aucun de ces tickets n'est bloqué par le sidecar.** Ce qui reste à faire est **côté client**, dans ce dépôt.

## Reproductibilité

```powershell
node scripts/msp-approval-mode-check.mjs
```

Lance un host, démarre une session, essaie quatre noms de méthode, balaie huit valeurs de mode et **relit la session** après chaque tentative. Aucune supposition sur les noms : le script affiche ceux qui existent et ceux que le host refuse.
