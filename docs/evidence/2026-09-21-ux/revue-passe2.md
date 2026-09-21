# Passe UX/UI n° 2 — revue indépendante, mesures et faux positifs (21 septembre 2026)

Deux revues visuelles indépendantes sur les 15 captures de [`pass1/`](pass1/), puis vérification instrumentée de chaque constat. Ce document remplace les constats non mesurés de [`constats-passe1.md`](constats-passe1.md) par des mesures, et **écarte quatre faux positifs** — dont deux que j'avais moi-même relayés.

## Ce que la revue a établi

Les deux revues ont travaillé sur les pixels, pas sur des impressions, et ont marqué explicitement **OBSERVÉ** ou **SUPPOSÉ**. Elles ont produit des mesures que je n'avais pas : géométrie du panneau, bandes d'encre, contrastes calculés, diff d'images.

**Elles ont aussi corrigé deux de mes affirmations :**

| Mon constat (non mesuré) | Réalité mesurée |
|---|---|
| « Les captures sont en thème sombre » | **Thème clair** : barre latérale `#F5F6F8`, conversation `#FFFFFF`, panneau `#F8F9FB` |
| « Run in Muse quasi blanc sur blanc, sur **Desktop** » | Le couple illisible est sur **Terminal** ; sur Desktop les plus pâles sont à 2,3-3,15:1 |

## Défauts confirmés

### 1. Message utilisateur dupliqué — cause localisée

**Mesuré :** deux bulles « You » identiques, décalage vertical exact de **127 px**, différence moyenne absolue **0,05/765** (capture 01) et **0,38/765** (capture 07), horodatage `09:21:45` **inclus**. Zones pixel pour pixel identiques.

**J'ai vérifié la source dans les données :** `session.jsonl` de la session `01a0c2d7` contient **quatre occurrences du texte**, mais ce sont **quatre événements distincts d'un seul tour** :

| Ligne | `record_type` / `payload_type` | Nature |
|---|---|---|
| 19 | `runtime.command_intake.received` | la commande arrive |
| 24 | `runtime.user_intent.accepted` | l'intention est acceptée |
| 25 | `runtime.session` | le tour démarre |
| 60 | `runtime.session` | réponse `assistant_message_committed` |

**Un seul message utilisateur dans les données.** Le doublon est donc une **double projection côté client**, pas un double envoi.

**Cause probable, localisée :** `mergeHistoryLog` (`src/lib/history.ts:319-343`) déduplique les entrées distantes contre les entrées **locales** via le jeu `used`, mais **jamais les entrées distantes entre elles**. Deux enregistrements d'un même message avec des identifiants d'élément différents passent donc tous les deux. Vérification de cette hypothèse à faire avant correction, car la déduplication par texte seul masquerait deux messages volontairement identiques.

### 2. Hygiène des captures — bloquant pour la passe suivante

| Capture | Problème mesuré |
|---|---|
| `05-bibliotheque`, `06-profil` | **modale Search encore ouverte** (`x451-989`, `y323-577`) + flou de fond : contenus illisibles |
| `15-theme-clair` | thème clair **sous un scrim sombre** (fond mesuré `#87919B` au lieu de `#F5F6F8`) + modale d'options |
| `07`, `08` | déjà en thème clair, donc `15` fait doublon |

**Conséquence :** il n'existe **aucune capture lisible** de Library, Settings et du panneau de travail. Les revues ont dû raisonner sur le côté droit uniquement. À reprendre avec `ux-capture.mjs`, qui assert déjà ses préconditions — mais refuse apparemment les fermetures d'overlay.

### 3. Onglet Browser : promesse non tenue

**Confirmé par mesure de structure :** l'en-tête annonce « Embedded preview », mais le corps enchaîne puce d'onglet → champ URL → boutons → « Page controls » → commentaires → permissions. Le plus grand blanc vertical fait **~36 px** : **aucune surface d'aperçu, aucun message d'état vide**.

Les autres onglets ont un état vide explicite (Files, Memory, Terminal). Browser est le seul sans.

### 4. Bas de panneau sans marge

**Mesuré :** Desktop, dernière ligne d'encre `y=865`, bande `y867-870`, bordure `872` — et la barre de défilement prouve que le contenu continue. Browser, encre jusqu'à `y=871` = dernière ligne du viewport.

### 5. Contours de contrôles natifs non stylés

**Mesuré :** `#767676` (champ, select, bouton Save de Memory), `#687075` (puce « New tab » du Browser, carte de fenêtre du Desktop), `#545D62` (carte « Available », ~2 px). À comparer aux hairlines `#E6E9ED` du reste du design system : **2,5 à 4× plus sombres**. Ce ne sont pas les « bordures quasi noires » que j'avais décrites, mais elles sont bien hors charte.

## Faux positifs écartés — et ils étaient sérieux

### A. « Send » et « Run in Muse » à 1,97:1 — non

Les deux boutons étaient **`disabled` avec `opacity: 0.45`**. WCAG **exempte explicitement** les contrôles désactivés du critère de contraste. Mesuré après saisie d'une commande :

| Bouton | État actif | Verdict |
|---|---|---|
| **Send** | **4,82:1** | conforme AA |
| « Run in Muse » | désactivé | exempté, mais voir la question ouverte ci-dessous |

Les deux revues annonçaient un défaut majeur ; dans l'état où elles ont mesuré, il n'y en a pas.

**Mon propre instrument avait aussi un bug** : il lisait le fond du **parent** et ignorait le fond de l'élément lui-même, rapportant « bleu sur blanc » pour un bouton bleu sur fond bleu clair. Corrigé : le fond propre est maintenant composité avec les ancêtres, puis l'`opacity` est appliquée.

### B. Contraste du texte secondaire à 3,63:1 — non

Une revue annonçait `--muted` à `#78828A` / 3,63:1 sur les six onglets. **Cette valeur n'existe plus** : `App.css:17` porte `--muted: #6a7279` depuis la passe 1, et `#78828a` ne subsiste que dans un commentaire. Mesure au DOM : « Close » du Terminal à **4,89:1**. Le jeton est conforme.

### C. « Aucun viewport / glyphes coupés en pleine hauteur » — non démontré

La revue a elle-même classé **SUPPOSÉ** ; la mesure ne montre pas de glyphe coupé en pleine hauteur, seulement du contenu qui atteint le bord.

## Question ouverte, non tranchée

### « Run in Muse » reste désactivé alors que le host accorde `userShell`

**C'est un vrai désaccord, mesuré à quatre niveaux :**

| Niveau | Résultat |
|---|---|
| `restore_sessions` (pont Rust) | `granted_capabilities: ["userShell"]` pour la session active `01a0bb03` |
| Prop React `canRunThroughMuse` (lue sur la fibre) | **`false`** |
| `disabled` du bouton | **`true`** |
| `title` | « This Muse host did not grant the userShell capability » |

**Écarté par la mesure :**
- ce n'est pas la saisie : une frappe **réelle** (événements clavier CDP) met bien à jour `command` — « Send » s'active et se désactive correctement ;
- ce n'est pas le cache par workspace : `restore_sessions` itère les hôtes vivants et lit `host_capabilities` à la clé exacte où `initialize` l'a écrit ;
- rappeler `restore_sessions` ne change pas l'état du renderer, donc cet appel n'est pas ce qui alimente `grantedCapabilitiesBySession` dans cet état.

**Non tranché :** l'appel qui alimente réellement l'état du renderer dans ce scénario, et si le message affiché (« did not grant ») est exact ou trompeur. Je ne corrige pas avant de savoir : modifier la chaîne sur une hypothèse serait le neuvième faux diagnostic de cette campagne.

## Correction appliquée et vérifiée

### `model_id` n'était pas transmis au renderer

`session_meta_from_list_row` lisait `session_durability`, `approval_mode` et `granted_capabilities` mais **ignorait `modelId`**, pourtant publié par `session/list`. Le composeur affichait donc « Model ».

Corrigé côté Rust (`SessionMeta::model_id`, helper `session_model_id` acceptant la forme plate de `session/list` et la forme imbriquée de `setModel`) **et** côté renderer (`restore_sessions` ne reportait pas `model_id` dans la fusion).

**Vérifié à trois niveaux :** `restore_sessions` renvoie `"model_id": "muse-spark-1.3-contributor"` pour les **11 sessions** ; et la capture de la passe 2 montre le modèle réel dans le composeur au lieu de « Model ».

### Message utilisateur dupliqué — cause trouvée et corrigée

Le sous-agent a lu les **logs persistés dans `localStorage`** de l'application et y a trouvé deux entrées `role: "user"` pour un seul envoi :

| # | `itemId` | `clientMessageId` | `ts` |
|---|---|---|---|
| 1 | **`null`** | identifiant client | 1789975305622 |
| 2 | **`e948ccf8…`** (id d'item du host) | identifiant de commande du host | 1789975305697 |

75 ms d'écart, donc **la même seconde affichée** — ce qui explique l'horodatage identique. Reproduit dans une seconde session (160 ms d'écart).

**Le mécanisme, en trois étapes :**

1. À l'envoi, le client crée une bulle utilisateur optimiste **et** un placeholder assistant vide.
2. Le réducteur temps réel lie l'`itemId` de l'item **utilisateur** du host à ce placeholder, car la voie incrémentale des items n'a pas de rôle « user ».
3. `mergeHistoryLog` recherche par `itemId` **sans contrôle de rôle** (`src/lib/history.ts:323-325`), donc l'item utilisateur distant **écrase le rôle** du placeholder (`:332`, ordre du spread) au lieu d'être reconnu comme un message déjà représenté. La bulle optimiste reste comme reliquat non consommé.

**Mon hypothèse initiale était fausse** : j'accusais une absence de déduplication entre entrées distantes. Le sous-agent l'a **réfutée par les données** — une entrée distante non appariée conserve un identifiant préfixé `history:`, et aucun identifiant de ce type n'existe dans les logs persistés.

**Corrigé** : la correspondance par `itemId` exige désormais le **même rôle**. Deux tests ajoutés, écrits **avant** le correctif :

- `does not turn an assistant placeholder into a second user bubble` — **échouait** avant, passe après ;
- `still binds a remote item to a local entry of the same role` — garde le comportement légitime.

`npm test` : **1074 tests, 0 échec** (contre 1072).

### Redondance de « Local » — chip du composeur retirée

Décision produit : la chip du composeur est supprimée, la pastille d'en-tête et « Local execution » en barre de statut restent. **Vérifié au DOM** : une seule occurrence de « Local » seul subsiste (la pastille d'en-tête).

### Onglet Browser — état vide ajouté

**Correction de mon propre diagnostic :** il *existe* une surface d'aperçu — une `iframe` même-origine (`BrowserPanel.tsx:884`) — mais elle n'est rendue qu'une fois une URL affichable, et **rien ne s'affichait en attendant**. C'était le seul des 7 onglets sans état vide.

Ajouté : un cadre en pointillés « No page loaded yet. Enter an http or https address above and press Go. », de la hauteur de l'iframe pour éviter tout décalage quand l'aperçu apparaît. Le sous-titre « Embedded preview » devient « **Same-origin preview** », qui décrit ce qui existe réellement.

**Vérifié** au DOM et par capture : état vide présent et visible, sous-titre exact.

### Cible tactile « Close panel »

**16 px de large**, sous le minimum de 24 px : `padding: 15px 1px` réduisait le bouton à la largeur du glyphe. `min-width: 24px` sur `.icon` → **24×50 px**, sans toucher aux autres boutons (28×30, 32×32). L'audit ne signale plus que 2 écarts, tous deux légitimes et documentés.

## Instruments ajoutés

| Script | Rôle |
|---|---|
| `ux-terminal-contrast.mjs` | contraste WCAG réel des contrôles, état actif et désactivé, préconditions assertées |
| `ux-session-meta-probe.mjs` | lit la projection brute du pont Rust (autorité sur le rendu) |
| `ux-react-state-probe.mjs` | lit une prop React sur la fibre, quand le DOM et le pont se contredisent |
| `ux-contrast-audit.mjs` | mesure ciblée par sélecteur, fond propre composité |
| `ux-verify-pass2.mjs` | vérifie les décisions de la passe 2 au DOM et par capture |

**Prédicat de visibilité, corrigé partout.** `ux-capture.mjs`, `ux-capture-conversation.mjs`, `ux-force-conversation.mjs` et `ux-target-size-audit.mjs` utilisaient `offsetParent !== null`, qui vaut `null` pour `<body>` et pour tout élément `position: fixed` : tout un mode de positionnement échappait à l'audit. Le prédicat est désormais `getClientRects()` + `display`/`visibility`, avec assertion des préconditions. Signalé par CodeRabbit sur `ux-target-size-audit.mjs` ; l'audit voit maintenant 43 contrôles au lieu de 46 selon l'état, et signale correctement 0 élément hors viewport.

Le même prédicat subsiste dans l'outillage `cdp-*` **antérieur** et dans `beta-smoke.mjs` : hors du périmètre de ce signalement, non modifié pour ne pas risquer de régression sur des scripts qui étayent des preuves déjà publiées.

## La leçon

**Deux revues indépendantes, sur les mêmes captures, ont produit deux faux positifs majeurs et corrigé deux de mes affirmations.** La cause est la même des deux côtés : **mesurer un état sans vérifier lequel**. Les boutons mesurés étaient désactivés ; le jeton mesuré n'était plus dans la feuille de style.

Et **mon hypothèse sur le doublon était fausse elle aussi**, pour une raison différente : j'avais lu le code et conclu à une absence de déduplication entre entrées distantes, sans aller regarder les **données réellement persistées**. Un seul `localStorage.getItem` a tranché — aucun identifiant préfixé `history:` n'existe, donc la voie que j'accusais n'a jamais servi. La cause était ailleurs, dans une correspondance par `itemId` sans contrôle de rôle.

C'est la même erreur que cette campagne a déjà payée huit fois, sous une forme nouvelle : **raisonner sur le code au lieu de mesurer l'état**. La parade ne change pas — instrumenter, asserter, et préférer la donnée à la déduction. Quand deux sources se contredisent, en instrumenter une troisième (ici : le log persisté, puis la fibre React) plutôt que de choisir celle qui arrange.
