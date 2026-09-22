# M1-11 — Modèle effectif : bascule prouvée côté host, libellé UI non par session (27 septembre 2026)

**Bilan en deux temps :** la bascule de modèle **fonctionne** (appel `session/setModel` par session,
`is_active` suit, `model_id` des réponses de session cohérent) — mais **le libellé du sélecteur
n'est pas rafraîchi par conversation** : en basculant entre deux conversations ouvertes, l'UI
annonce le dernier modèle choisi n'importe où, pas le modèle effectif de la conversation affichée.

## 1. Ce qui est prouvé (fonctionnel)

**Bascule + fil** — sélection dans le sélecteur Modèle :

```json
{"cmd":"set_model","payload":{"sessionId":"01a0c96d-…","modelId":"muse-spark-1.2-contributor","providerId":"meta","profile_id":"tbh"},"result":"null"}
```

puis `list_models` rafraîchi **pour cette session** : `is_active` suit la sélection.

**État réellement par session côté host** — deux conversations du même workspace, mêmes hôtes :

| Session | Action | `model_id` effectif |
|---|---|---|
| A `01a0c96d-…` | `set_model` → `muse-spark-1.2-contributor` (succès) | `muse-spark-1.2-contributor` |
| B `01a0c955-…` | `resume_session` (aucune bascule) | **`muse-spark-1.3-contributor`** (défaut) |

B reprend son **propre** modèle alors qu'A venait d'être basculée — l'état du host est bien
**par session**, et non global par hôte.

**Le libellé UI colle au modèle effectif après hydratation** — après `resume_session` de B :
`model_id: "muse-spark-1.3-contributor"`, `list_models(B)` → `is_active: true` sur
`muse-spark-1.3-contributor` (et `is_default: true`), et le déclencheur du sélecteur affiche
exactement `muse-spark-1.3-contributor`. ✓

## 2. Défauts mesurés

### 2.1 Le libellé n'est pas par conversation (bloquant pour la clôture)

Séquence : bascule de B vers `muse-spark-1.3` (succès, `is_active: true` pour B) → retour sur A.

- libellé affiché sur **A** : `muse-spark-1.3`
- modèle effectif d'**A** : `muse-spark-1.2-contributor` (sa propre bascule, `set_model` → `null`)

**L'UI annonce un modèle que la conversation n'utilisera pas.** Mécanisme observé : le libellé
est mis à jour par les actions du sélecteur et par l'hydratation `resume_session`, mais **pas au
changement de conversation** (pas de `list_models` émis lors du switch — cache partagé).

### 2.2 Bascule sur une conversation non chargée : rejet net mais sélecteur actif

`set_model` sur une conversation sauvegardée sans moteur :

```json
{"result": "\"conversation engine is unavailable — start or restore the conversation first\""}
```

Le libellé ne bouge pas (pas de mensonge optimiste ✓) et un bouton honnête
**Reconnect** (« Reconnect this saved conversation to its workspace engine ») est proposé —
mais le sélecteur reste manipulable et n'explique pas le rejet. Après Reconnect, la bascule
fonctionne.

## Verdict M1-11 Windows

- **Bascule entre conversations ouvertes : la capacité existe et l'état est par session** —
  mais **le critère d'acceptation tombe** : « le libellé annoncé par l'UI correspond au modèle
  effectivement transmis au host » est faux au changement de conversation (2.1).
- **Reste :** rafraîchir (ou stocker par session) le modèle affiché au switch — par un
  `list_models` par session ou un état local indexé par `session_id` ; la persistance de la
  bascule après redémarrage de l'app reste à rejouer ; `contextUsage` invarié pendant le tour
  non rejoué aujourd'hui.

## Reproductibilité

- Commit `2f80148`+ ; Windows 11 26200, WebView2, CDP 9222 ; sidecar `muse` 1.3.0.
- Séquence : `node scripts/ux-model-picker.mjs --port 9222` (ouverture du popover, 4 options,
  libellé à la sélection) → bascule manuelle avec trace `window.fetch` (via
  `scripts/cdp-drive.mjs eval`) : `set_model` + `list_models` par `sessionId` ; divergence
  libellé/effetif mesurée en basculant entre `button.session-select`.
