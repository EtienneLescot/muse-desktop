# Effort de raisonnement : le sélecteur aligné sur les niveaux Muse Spark

Date campagne : 27/09/2026 · Plateforme : Windows 10 · Binaire CLI mesuré : `muse-bin-1.3.0-R3401.1` (`C:\Users\etien\Programs\…\muse.cmd`)

## Question posée

« On devait avoir aligné ça avec les réelles valeurs du CLI Muse et j'ai
l'impression que les choix ne sont pas cohérents (aujourd'hui on a 8 choix et
ça me paraît énorme par rapport à ce que propose Muse Spark). »

## Mesures (sources de vérité, pas d'interprétation)

**1. `muse --help`** — le drapeau du CLI :

```
--reasoning-effort <EFFORT>
    Meta reasoning effort: none|minimal|low|medium|high|xhigh|max|ultra
    (default: high)
```

**2. `muse schema generate-json-schema --out <dir>`** — export **offline et exact**
du binaire ; `$defs.ReasoningEffort` :

```
enum: none, minimal, low, medium, high, xhigh, max, ultra   (x-msp-openness: closed)
```

avec la description du contrat : *« The **same closed tier vocabulary** on both
the fresh-turn and steer lanes… `none` is a tier of the vocabulary (ask for no
reasoning), not a way to say "unset". »* — le même type sert à
`turn/start.reasoningEffort`, `session/setReasoningEffort` et
`session/reasoningEffortChanged`.

**3. Niveaux persistants du CLI** (guidance du produit, déjà relevée le 21/09
dans [regles-du-dossier.md](../2026-09-21-ux/regles-du-dossier.md)) :

> For Meta, the persistent effort tiers are `minimal`, `low`, `medium`, `high`,
> `xhigh`, `max`, and `ultra`. `high` is the default Meta baseline; `xhigh` is
> the opt-in premium precision tier. `ultra` remains the saved client selection,
> uses `max` reasoning on the Meta wire, and currently enables proactive
> workflow/delegation guidance…

Donc **deux vocabulaires réels** : 8 valeurs sur le fil, **7 niveaux persistants
Muse Spark** (sans `none`). Et `ultra` n'est pas un cran de profondeur au-dessus
de `max`, c'est `max` **plus** de l'autonomie.

## Décision (choix de l'utilisateur)

Le sélecteur expose **les sept niveaux Muse Spark** : `minimal, low, medium,
high, xhigh, max, ultra`.

- `none` **sort du sélecteur** : le CLI ne le persiste jamais comme niveau, il
  reste une valeur du fil (« ask for no reasoning »).
- Les libellés reprennent l'**orthographe du CLI** (`xhigh` et non « Very high »)
  pour que la liste soit lisible comme le produit qu'elle pilote.
- `ultra` reste **distingué** : « Max depth plus proactive workflow and
  delegation guidance; can raise token usage quickly ».

## Compatibilité assumée

- `reasoningEffortChoices(current)` : une valeur **déjà persistée** qui n'est
  plus proposée (aujourd'hui `none`) reste affichée en tête de liste. La
  supprimer silencieusement réécrirait le niveau de l'utilisateur à la
  prochaine sauvegarde — le test « keeps a legacy `none` selection visible »
  verrouille ce comportement.
- Le vocabulaire **fil reste complet** : `REASONING_EFFORTS` (8) sert à parser
  et valider tout ce qui vient du host, et `validate_reasoning_effort` côté Rust
  accepte toujours les 8 (c'est ce que le contrat déclare ; c'est aussi ainsi
  que `max` avait été perdu en son temps, en rétrécissant notre liste).

## Fichiers

- `src/lib/reasoning.ts` : `REASONING_EFFORT_CHOICES` (7 niveaux), 
  `reasoningEffortChoices(current)`, libellé `xhigh`, doc des deux vocabulaires.
- `src/components/ReasoningEffortControl.tsx`, `SettingsPanel.tsx`,
  `ProjectsPanel.tsx` : itèrent sur `reasoningEffortChoices(...)` au lieu de la
  liste fil.
- `test/reasoning.test.ts` : +3 tests (liste des 7, `none` legacy conservé,
  libellés CLI).
- `src-tauri/src/main.rs` : **inchangé** — le validateur garde les 8 valeurs.

## Preuves (rejouables)

| Étape | Commande | Résultat |
| --- | --- | --- |
| Vocabulaire fil | `muse --help` | `none\|minimal\|low\|medium\|high\|xhigh\|max\|ultra` (défaut `high`) |
| Contrat | `muse schema generate-json-schema --out <dir>` puis lecture `$defs.ReasoningEffort` | enum fermée à 8, `none` = « a tier of the vocabulary… not a way to say unset » |
| Niveaux persistants | guidance CLI (`For Meta, the persistent effort tiers are…`) | 7 : `minimal, low, medium, high, xhigh, max, ultra` |
| Tests | `npm test` | 0 échec, dont les 3 nouveaux (7 choix, `none` legacy affiché mais non proposé, libellés CLI) |
| Typage | `npx tsc --noEmit` | propre |
| App native | `npm run build` + `cargo build` + relance, puis `scripts/cdp-drive.mjs eval` sur le popover `Reasoning effort` | **7 options, aucune « None »** ; libellé `Xhigh` |
