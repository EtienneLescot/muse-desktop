# Copie produit en anglais — audit du rendu (M0-11, 20 septembre 2026)

M0-11 demande de « finir l'anglais ». Le dépôt disposait d'un test (`test/ui-copy.test.ts`) qui vérifie une **liste noire de neuf phrases françaises** dans **cinq fichiers**. Cet audit va plus loin : il mesure la **source entière** et l'**interface rendue**.

## 1. Source entière — recherche d'accents

```powershell
Get-ChildItem src -Recurse -Include *.tsx,*.ts
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

| Surface | Candidats |
|---|---|
| home | 2 |
| new-conversation | 2 |
| automations | 2 |
| extensions | 3 |
| library | 2 |
| search | 2 |
| conversation | 2 |

**Les 7 chaînes signalées sont toutes des faux positifs de l'heuristique**, et je les examine une par une :

| Chaîne | Déclencheur | Verdict |
|---|---|---|
| `Extensions` | mon marqueur tronqué `Exten` | **anglais** — le mot est identique dans les deux langues |
| `Conversations (…)` | marqueur `Conversations` | **anglais** — identique dans les deux langues |
| `Curated catalog plus an explicit local MCP probe.` | mot grammatical `plus` | **anglais** — la phrase est entièrement anglaise |

Aucune chaîne réellement française n'est apparue sur aucune des sept surfaces.

## Conclusion

**Établi :** la copie produit visible est **en anglais** sur les surfaces auditées, et la source ne contient aucune chaîne accentuée hors motifs de détection. Le critère « finir l'anglais » de M0-11 est **mesuré sur ce périmètre**.

## Limites — ce que cet audit ne couvre pas

- **Sept surfaces seulement.** Les panneaux ouverts à la demande — réglages, projets, revue Git, terminal, navigateur, desktop, mémoire, extensions installées, automatisations configurées — **n'ont pas été visités**. Chacun pourrait contenir de la copie française non détectée.
- **Les chaînes construites dynamiquement** (concaténation, gabarits avec variables) peuvent échapper à un balayage de nœuds texte si le fragment français est court et sans marqueur.
- **Les messages d'erreur, infobulles, `aria-label` et titres d'onglet** ne sont pas tous dans des nœuds texte visibles ; `aria-label` notamment n'apparaît pas dans `innerText`.
- Mon heuristique a produit **trois faux positifs sur sept détections** — un taux élevé. Les marqueurs tronqués (`Exten`) et les mots communs aux deux langues (`Conversations`, `plus`) la rendent bruyante ; elle est **sensible mais peu spécifique**, et une détection manquée reste possible.
- **M0-11 comporte un second volet** — « détails de navigation » : infobulles `Ctrl`/`Cmd`, copie d'erreur centralisée, chemin natif lisible. Ce volet n'est pas traité ici.

**M0-11 n'est donc pas clos.** Son volet linguistique est mesuré sur sept surfaces, avec les limites ci-dessus ; le volet navigation reste à couvrir.
