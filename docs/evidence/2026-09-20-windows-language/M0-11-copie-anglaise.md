# Copie produit en anglais — audit du rendu (M0-11, 20 septembre 2026)

M0-11 demande de « finir l'anglais ». Le dépôt disposait d'un test (`test/ui-copy.test.ts`) qui vérifie une **liste noire de neuf phrases françaises** dans **cinq fichiers**. Cet audit va plus loin : il mesure la **source entière** et l'**interface rendue**.

## 1. Source entière — recherche d'accents

```powershell
Get-ChildItem src -Recurse -Include *.tsx,*.ts |
  Select-String -Pattern "[éèêëàâäôöûüç]"
```

| Mesure | Résultat |
|---|---|
| Fichiers scannés | **129** |
| Lignes contenant un accent | **2** |

Les deux occurrences sont dans des **motifs de détection multilingue**, pas dans de la copie produit :

- `src/lib/artifacts.ts:109` → `/décision|decision|decided|décidé|approved|approuv|conclu|retenu|choisi|choice|outcome/i`
- `src/lib/compact.ts:179` → même motif

Ce sont des expressions régulières qui doivent **reconnaître** des mots français dans les sorties du modèle. Les traduire serait un défaut, pas une correction.

## 2. Interface rendue — audit du DOM réel

Un accent n'est pas nécessaire pour écrire du français : « Ajouter », « Aucun », « Fermer » n'en ont pas. La copie française doit donc être cherchée dans le **DOM**, pas seulement dans la source.

```powershell
node scripts/cdp-language-audit.mjs
```

Le script parcourt les nœuds texte visibles et signale toute chaîne contenant un **verbe d'interface français** ou un **mot grammatical français**, puis visite sept surfaces.

### Résultat : aucune copie française

Première passe, avec une détection **sensible à la casse** (voir la correction plus bas) :

| Surface | Candidats (passe 1) | Candidats (passe 2, insensible à la casse) |
|---|---|---|
| home | 2 | **5** |
| new-conversation | 2 | **5** |
| automations | 2 | **4** |
| extensions | 3 | **5** |
| library | 2 | **5** |
| search | 2 | **5** |
| conversation | 2 | **5** |
| **Total** | **7** | **34** |

**Aucune des 34 chaînes n'est française.** Ce sont toutes des faux positifs, regroupés en trois familles :

| Chaîne signalée | Déclencheur | Verdict |
|---|---|---|
| `Extensions` | marqueur tronqué `Exten` | **anglais** — le mot est identique dans les deux langues |
| `Conversations (…)` | marqueur `Conversations` | **anglais** — identique dans les deux langues |
| `Archived conversations` | marqueur `Conversations` | **anglais** |
| `Search conversations` | marqueur `Conversations` | **anglais** |
| `No imported conversations yet.` | marqueur `Conversations` | **anglais** |
| `Fast responses with no extended reasoning` | marqueur `Exten` | **anglais** — `Exten` matche « Ex**ten**sions » et « ex**ten**ded » |
| `Curated catalog plus an explicit local MCP probe.` | mot grammatical `plus` | **anglais** — phrase entièrement anglaise |

### Une correction apportée après revue

Une revue automatisée a relevé deux défauts réels dans ma première passe :

1. **La détection des marqueurs était sensible à la casse** (`raw.includes(m)`). Une copie française en minuscules — « ajouter », « fermer » — serait passée inaperçue si le marqueur était capitalisé. Corrigé en comparant en minuscules, puis **audit relancé** : 7 → 34 candidats, ce qui double la sensibilité de la passe.
2. **Un défaut de journalisation** : si la conversation cible ne s'ouvrait pas, la surface était quand même enregistrée sous le nom `conversation`, laissant croire à une mesure valide. Corrigé : l'échec est désormais nommé `conversation-NOT-OPENED`.

**La conclusion n'a pas changé après correction**, mais elle repose maintenant sur une détection plus stricte et sur une mesure dont l'échec serait visible.

## Conclusion

**Établi :** la copie produit visible est **en anglais** sur les surfaces auditées, et la source ne contient aucune chaîne accentuée hors motifs de détection. Le critère « finir l'anglais » de M0-11 est **mesuré sur ce périmètre**.

## Limites — ce que cet audit ne couvre pas

- **Sept surfaces seulement.** Les panneaux ouverts à la demande — réglages, projets, revue Git, terminal, navigateur, desktop, mémoire, extensions installées, automatisations configurées — **n'ont pas été visités**. Chacun pourrait contenir de la copie française non détectée.
- **Les chaînes construites dynamiquement** (concaténation, gabarits avec variables) peuvent échapper à un balayage de nœuds texte si le fragment français est court et sans marqueur.
- **Les messages d'erreur, infobulles, `aria-label` et titres d'onglet** ne sont pas tous dans des nœuds texte visibles ; `aria-label` notamment n'apparaît pas dans `innerText`.
- Mon heuristique a produit **34 faux positifs sur 34 détections** — soit aucune spécificité. Les marqueurs tronqués (`Exten`) et les mots communs aux deux langues (`Conversations`, `plus`) la rendent très bruyante. Autrement dit : la passe est **sensible** mais son résultat ne vaut que parce que j'ai **examiné chaque chaîne une par une**. Un audit futur doit remplacer ces marqueurs par des mots réellement exclusifs au français, sans quoi il ne prouvera rien.
- **M0-11 comporte un second volet** — « détails de navigation » : infobulles `Ctrl`/`Cmd`, copie d'erreur centralisée, chemin natif lisible. Ce volet n'est pas traité ici.

**M0-11 n'est donc pas clos.** Son volet linguistique est mesuré sur sept surfaces, avec les limites ci-dessus ; le volet navigation reste à couvrir.
