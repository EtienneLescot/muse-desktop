# Pourquoi le composeur affiche « Model » — diagnostic (21 septembre 2026)

Passe UX n° 1. Le composeur affiche le mot générique **« Model »** au lieu du nom du modèle en cours. Ce document établit la chaîne complète, de l'effet visible à la cause.

## L'effet, mesuré

| État du panneau | Largeur du composeur | Texte du bouton | Lignes | Bouton |
|---|---|---|---|---|
| ouvert | 656 px | **`Model`** | **1** | 64×32 |
| fermé | 760 px | **`Model`** | **1** | 64×32 |

**Deux choses à en tirer :**

1. **Le correctif d'habillage tient** : `white-space: nowrap`, une seule ligne, dans les deux états. La revue visuelle a jugé une capture **antérieure** au correctif, et je le comprends — le libellé court ne permet pas de distinguer « tronqué » de « nom absent ». **La revue se trompait sur ce point, et ma vérification initiale était juste, mais pour une raison que je n'avais pas identifiée.**

2. **Le vrai défaut est le repli générique.** L'utilisateur ne sait pas quel modèle il utilise.

## La chaîne, du visible à la cause

`App.tsx`, le contrôle du composeur :

```tsx
{liveModels?.find((model) => model.isActive)?.displayLabel   // 1er choix
  || active.model_id                                          // 2e choix
  || "Model"}                                                 // repli
```

Trois causes possibles pour retomber sur `"Model"` : `liveModels` vide, ou `model_id` absent, ou les deux. **Mesure : les deux.** `0 / 3` sessions stockées portent un `model_id`, et `liveModels` ne fournit pas d'entrée active.

**Pourquoi `model_id` est absent** — recherche dans le code :

| Emplacement | Écrit `model_id` ? |
|---|---|
| `useMuseSessions.ts:4059` | oui, dans `setSessionModel` — **uniquement quand l'utilisateur change explicitement de modèle** |
| `:4282`, `:4659` | oui, à la création, si un modèle a été demandé |
| `:4732`, `:4751` | oui, par héritage lors d'un fork |
| **Restauration d'une session existante** | **non** |

**Rien ne renseigne `model_id` quand une session est restaurée.** Une session créée avant l'introduction du champ, ou restaurée sans changement de modèle, n'en a donc jamais.

## La cause structurelle

`session/list` **expose `modelId` pour chaque session** — je l'ai mesuré : `modelId`, `providerId`, `turnCount`, `title`, `status`, `branch`, `workspaceRoot`…

Et le Rust **lit déjà cette réponse** pour en extraire d'autres champs :

```rust
fn session_meta_from_list_row(root: &Path, session: &Value, …) -> Option<SessionMeta> {
    Some(SessionMeta {
        session_id,
        workspace,
        running,
        session_durability,                          // ← remonte jusqu'à l'interface
        approval_mode: session_approval_mode(session), // ← remonte, avec un commentaire
        granted_capabilities,                        // ← remonte
    })
}
```

**`modelId` est ignoré.** L'asymétrie est nette : le mode d'approbation et la durabilité sont transmis au renderer, le modèle est jeté — alors que **le code Rust sait déjà extraire un champ d'une ligne de `session/list`**, comme le prouve `session_approval_mode(session)`.

## Ce que le correctif demanderait

1. `session_meta_from_list_row` lit `session.get("modelId")` et le place dans `SessionMeta` (même motif que `approval_mode`).
2. `SessionMeta` (Rust) et son type TypeScript reçoivent `model_id`, sérialisé quand présent.
3. Le renderer applique `meta.model_id` aux sessions restaurées, comme il applique déjà `meta.approval_mode`.

**Je n'applique pas ce correctif dans cette passe.** Il touche la structure de données partagée entre les trois couches — Rust, pont TypeScript, renderer — pour une amélioration d'affichage. Il mérite sa propre modification, avec les tests Rust qui existent déjà autour de `session_meta_from_list_row` (`main.rs:7225`), plutôt qu'un ajout en fin de passe UX où je ne pourrais pas le vérifier sur les trois couches.

## Ce que ce diagnostic corrige dans la passe

La revue visuelle avait signalé « le libellé du modèle se coupe encore panneau déplié ». **C'est faux** — mais son observation était fondée sur une capture antérieure au correctif, et le libellé `Model` court ne permettait pas de trancher. **Deux fois dans cette passe, une observation juste s'est révélée mal attribuée** : ici par antériorité de la capture, et pour le panneau Desktop par confusion entre structure et contenu. La mesure tranche, l'œil seul ne suffit pas.
